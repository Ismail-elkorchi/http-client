import { bufferResult } from "./buffered-response.js";
import {
  resolveClientOptions,
  resolveRequestOptions,
  validateRedirectDecision,
  type ResolvedRequestOptions,
} from "./configuration.js";
import { HttpConfigurationError } from "./errors.js";
import {
  awaitWithSignal,
  PhaseDeadline,
  RequestDeadline,
  ResponseHeadersTimeoutError,
} from "./deadlines.js";
import {
  applyContentLength,
  enforceRequestHeadersLimit,
  mergeRequestHeaders,
  requestAfterRedirect,
  type RedirectedRequest,
} from "./headers.js";
import { NetworkSafetyPolicy } from "./network-policy.js";
import {
  prepareRequestBody,
  RequestBodyLimitError,
} from "./request-body.js";
import {
  classifyError,
  clientError,
  failureResult,
  failureFromResponse,
  redirectFailure,
} from "./outcomes.js";
import { createStreamingBody } from "./response-stream.js";
import { UndiciTransport } from "./transport.js";
import type {
  BufferedHttpRequestOptions,
  BufferedHttpResult,
  HttpClientConfiguration,
  HttpClientOptions,
  HttpRedirect,
  HttpRequestOptions,
  StreamingHttpResponse,
  StreamingHttpResult,
} from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NodeHttpClient {
  private readonly options: HttpClientOptions;
  private readonly transport: UndiciTransport;
  private readonly activeResponses = new Set<StreamingHttpResponse>();
  private readonly activeDeadlines = new Set<RequestDeadline>();
  private readonly exchangeWaiters = new Set<() => void>();
  private pendingExchanges = 0;
  private state: "open" | "closing" | "closed" = "open";
  private shutdown: Promise<void> | null = null;

  public constructor(configuration: HttpClientConfiguration = {}) {
    this.options = resolveClientOptions(configuration);
    const policy = new NetworkSafetyPolicy(
      this.options.networkSafety,
      this.options.resolver,
    );
    this.transport = new UndiciTransport(this.options, policy);
  }

  public async request(
    rawUrl: string | URL,
    options: HttpRequestOptions = {},
  ): Promise<StreamingHttpResult> {
    return await this.execute(
      rawUrl,
      resolveRequestOptions(options, this.options, false),
      false,
    );
  }

  public async fetch(
    rawUrl: string | URL,
    options: HttpRequestOptions = {},
  ): Promise<StreamingHttpResult> {
    return await this.execute(
      rawUrl,
      resolveRequestOptions(options, this.options, false),
      true,
    );
  }

  public async requestBuffered(
    rawUrl: string | URL,
    options: BufferedHttpRequestOptions = {},
  ): Promise<BufferedHttpResult> {
    const resolved = resolveRequestOptions(options, this.options, true);
    return await bufferResult(
      await this.execute(rawUrl, resolved, false),
      resolved,
    );
  }

  public async fetchBuffered(
    rawUrl: string | URL,
    options: BufferedHttpRequestOptions = {},
  ): Promise<BufferedHttpResult> {
    const resolved = resolveRequestOptions(options, this.options, true);
    return await bufferResult(
      await this.execute(rawUrl, resolved, true),
      resolved,
    );
  }

  public async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.shutdown === null) {
      this.state = "closing";
      this.shutdown = this.finishShutdown(this.closeGracefully());
    }
    await this.shutdown;
  }

  public async destroy(reason?: Error): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    for (const deadline of this.activeDeadlines) deadline.abort(reason);
    for (const response of this.activeResponses) response.cancel(reason);
    if (this.shutdown === null) {
      this.shutdown = this.finishShutdown(
        this.destroyImmediately(reason),
      );
    }
    await this.shutdown;
    this.activeResponses.clear();
  }

  private async execute(
    rawUrl: string | URL,
    options: ResolvedRequestOptions,
    followRedirects: boolean,
  ): Promise<StreamingHttpResult> {
    if (this.state !== "open") {
      throw new HttpClientStateError("The HTTP client is not open.");
    }
    const startedAt = performance.now();
    const deadline = new RequestDeadline(
      options.timeouts.totalMs,
      options.signal,
    );
    this.activeDeadlines.add(deadline);
    this.pendingExchanges += 1;
    let result: StreamingHttpResult;
    try {
      result = followRedirects
        ? await this.fetchWithRedirects(
            rawUrl,
            options,
            deadline.signal,
            startedAt,
          )
        : await this.requestExchange(
            rawUrl,
            {
              method: options.method,
              headers: mergeRequestHeaders(
                this.options.defaultHeaders,
                options.headers,
              ),
              body: options.body,
            },
            options,
            deadline.signal,
            startedAt,
            false,
          );
    } catch (caught) {
      this.releaseDeadline(deadline);
      this.finishExchange();
      throw caught;
    }
    this.finishExchange();
    if (result.kind === "failure") {
      this.releaseDeadline(deadline);
      return result;
    }
    const registered = this.registerResponse(result, deadline);
    return registered;
  }

  private async fetchWithRedirects(
    rawUrl: string | URL,
    options: ResolvedRequestOptions,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<StreamingHttpResult> {
    const redirects: HttpRedirect[] = [];
    const visited = new Set<string>();
    let currentUrl: URL;
    try {
      currentUrl = parseUrl(rawUrl);
    } catch (caught) {
      const errorUrl = safeErrorUrl(caught);
      return failureResult(
        clientError(
          "INVALID_URL",
          caught instanceof UrlCredentialsError
            ? caught.message
            : "The request URL is invalid.",
          errorUrl,
          caught,
        ),
        errorUrl,
      );
    }
    visited.add(loopIdentity(currentUrl));
    let request: RedirectedRequest = {
      method: options.method,
      headers: mergeRequestHeaders(
        this.options.defaultHeaders,
        options.headers,
      ),
      body: options.body,
    };

    for (let hopIndex = 0; ; hopIndex += 1) {
      const result = await this.requestExchange(
        currentUrl,
        request,
        options,
        signal,
        startedAt,
        true,
      );
      if (result.kind === "failure") {
        return { ...result, redirects };
      }
      const location = result.headers.get("location");
      if (
        !REDIRECT_STATUSES.has(result.statusCode) ||
        location === null
      ) {
        return { ...result, redirects };
      }

      result.cancel();
      const completion = await result.completion;
      if (hopIndex >= options.maxRedirects) {
        return redirectFailure(
          "TOO_MANY_REDIRECTS",
          "Redirect limit exceeded.",
          currentUrl.href,
          result,
          completion.transfer,
          redirects,
        );
      }

      let target: URL;
      try {
        target = parseUrl(new URL(location, currentUrl));
        assertSupportedProtocol(target);
      } catch (caught) {
        return redirectFailure(
          "REDIRECT_TARGET_REJECTED",
          "The redirect target is invalid.",
          currentUrl.href,
          result,
          completion.transfer,
          redirects,
          caught,
        );
      }
      const redirect: HttpRedirect = {
        fromUrl: currentUrl.href,
        toUrl: target.href,
        statusCode: result.statusCode,
        hopIndex,
      };
      const nextRedirects = [...redirects, redirect];
      if (visited.has(loopIdentity(target))) {
        return redirectFailure(
          "REDIRECT_LOOP",
          "Redirect loop detected.",
          target.href,
          result,
          completion.transfer,
          nextRedirects,
        );
      }
      let decision;
      try {
        decision = validateRedirectDecision(
          options.onRedirect === undefined
            ? undefined
            : await awaitWithSignal(
                Promise.resolve(
                  options.onRedirect({
                    fromUrl: currentUrl.href,
                    toUrl: target.href,
                    statusCode: result.statusCode,
                    hopIndex,
                  }),
                ),
                signal,
              ),
        );
      } catch (caught) {
        if (caught instanceof HttpConfigurationError) throw caught;
        if (signal.aborted) {
          return {
            ...failureFromResponse(
              result,
              classifyError(caught, target.href, signal, false),
              completion.transfer,
            ),
            finalUrl: target.href,
            redirects: nextRedirects,
          };
        }
        return redirectFailure(
          "REDIRECT_TARGET_REJECTED",
          "The redirect callback failed.",
          target.href,
          result,
          completion.transfer,
          nextRedirects,
          caught,
        );
      }
      if (decision?.action === "reject") {
        return redirectFailure(
          "REDIRECT_TARGET_REJECTED",
          decision.reason,
          target.href,
          result,
          completion.transfer,
          nextRedirects,
        );
      }

      redirects.push(redirect);
      visited.add(loopIdentity(target));
      request = requestAfterRedirect(
        currentUrl.href,
        target.href,
        result.statusCode,
        request,
      );
      currentUrl = target;
    }
  }

  private async requestExchange(
    rawUrl: string | URL,
    request: RedirectedRequest,
    options: ResolvedRequestOptions,
    signal: AbortSignal,
    requestStartedAt: number,
    skipRedirectBodyDecoding: boolean,
  ): Promise<StreamingHttpResult> {
    const exchangeStartedAt = performance.now();
    let url: URL;
    try {
      url = parseUrl(rawUrl);
    } catch (caught) {
      const errorUrl = safeErrorUrl(caught);
      return failureResult(
        clientError(
          "INVALID_URL",
          caught instanceof UrlCredentialsError
            ? caught.message
            : "The request URL is invalid.",
          errorUrl,
          caught,
        ),
        errorUrl,
      );
    }
    try {
      assertSupportedProtocol(url);
    } catch (caught) {
      return failureResult(
        clientError(
          "UNSUPPORTED_PROTOCOL",
          "Only HTTP and HTTPS URLs are supported.",
          url.href,
          caught,
        ),
        url.href,
      );
    }

    let credentialHeaders: Readonly<Record<string, string>> | undefined;
    try {
      credentialHeaders =
        options.credentials === undefined
          ? undefined
          : await awaitWithSignal(
              options.credentials.requestHeaders(url.href),
              signal,
            );
    } catch (caught) {
      return failureResult(
        signal.aborted
          ? classifyError(caught, url.href, signal, false)
          : clientError(
              "NETWORK_FAILURE",
              "Request credentials could not be prepared.",
              url.href,
              caught,
            ),
        url.href,
      );
    }

    let preparedBody;
    try {
      preparedBody = prepareRequestBody(
        request.body,
        options.maxRequestBodyBytes,
      );
    } catch (caught) {
      if (caught instanceof RequestBodyLimitError) {
        return failureResult(
          clientError(
            "REQUEST_BODY_TOO_LARGE",
            caught.message,
            url.href,
            caught,
          ),
          url.href,
        );
      }
      throw caught;
    }
    const mergedHeaders = mergeRequestHeaders(
      request.headers,
      credentialHeaders,
    );
    const decodingHeaders =
      options.responseContentDecoding === "decode" &&
      mergedHeaders["accept-encoding"] === undefined
        ? {
            ...mergedHeaders,
            "accept-encoding": "zstd, br, gzip, deflate",
          }
        : mergedHeaders;
    if (
      preparedBody.contentType !== null &&
      decodingHeaders["content-type"] !== undefined
    ) {
      throw new HttpConfigurationError(
        "Multipart content-type is controlled by the HTTP transport.",
      );
    }
    const representationHeaders =
      preparedBody.contentType === null
        ? decodingHeaders
        : {
            ...decodingHeaders,
            "content-type": preparedBody.contentType,
          };
    const headers = applyContentLength(
      representationHeaders,
      request.body !== undefined,
      preparedBody.contentLength,
    );
    try {
      enforceRequestHeadersLimit(
        headers,
        this.options.maxRequestHeadersBytes,
      );
    } catch (caught) {
      return failureResult(
        classifyError(caught, url.href, signal, false),
        url.href,
      );
    }

    let response;
    const headersDeadline = new PhaseDeadline(
      options.timeouts.responseHeadersMs,
      signal,
      new ResponseHeadersTimeoutError(options.timeouts.responseHeadersMs),
    );
    try {
      response = await this.transport.request(url, {
        method: request.method,
        headers,
        createBody: preparedBody.create,
        signal: headersDeadline.signal,
        responseHeadersTimeoutMs: options.timeouts.responseHeadersMs,
        responseBodyInactivityTimeoutMs:
          options.timeouts.responseBodyProgressMs,
        onInformationalResponse:
          options.onInformationalResponse === undefined
            ? undefined
            : (statusCode, headers) => {
                options.onInformationalResponse?.({ statusCode, headers });
              },
      });
    } catch (caught) {
      return failureResult(
        classifyError(caught, url.href, headersDeadline.signal, false),
        url.href,
      );
    } finally {
      headersDeadline.dispose();
    }

    try {
      if (options.credentials !== undefined) {
        await awaitWithSignal(
          options.credentials.captureResponse(
            url.href,
            new Headers(response.headers),
          ),
          signal,
        );
      }
    } catch (caught) {
      cancelNodeBody(response.body, caught);
      return failureResult(
        signal.aborted
          ? classifyError(caught, url.href, signal, false)
          : clientError(
              "NETWORK_FAILURE",
              "Response credentials could not be captured.",
              url.href,
              caught,
            ),
        url.href,
        response.statusCode,
        response.headers,
        response.connection,
        null,
        response.statusMessage,
      );
    }

    const headTimings = {
      dnsMs: response.dnsMs,
      responseHeadersMs: performance.now() - exchangeStartedAt,
    };
    let streamingBody;
    const isFollowedRedirect =
      skipRedirectBodyDecoding &&
      REDIRECT_STATUSES.has(response.statusCode) &&
      response.headers.has("location");
    try {
      streamingBody = createStreamingBody({
        source: response.body,
        contentEncoding:
          options.responseContentDecoding === "decode" &&
          !isFollowedRedirect &&
          responseHasContent(request.method, response.statusCode)
            ? response.headers.get("content-encoding") ?? undefined
            : undefined,
        limits: options.responseTransferLimits,
        responseBodyProgressTimeoutMs:
          options.timeouts.responseBodyProgressMs,
        signal,
        requestStartedAt,
        headTimings,
        requestBodyBytesSent: response.requestBodyBytesSent,
        trailers: response.trailers,
        classifyFailure: (caught, decoding) =>
          classifyError(caught, url.href, signal, decoding),
      });
    } catch (caught) {
      cancelNodeBody(response.body, caught);
      return failureResult(
        classifyError(caught, url.href, signal, false),
        url.href,
        response.statusCode,
        response.headers,
        response.connection,
        null,
        response.statusMessage,
      );
    }
    return {
      kind: "response",
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      finalUrl: url.href,
      headers: response.headers,
      redirects: [],
      connection: response.connection,
      headTimings,
      body: streamingBody.body,
      completion: streamingBody.completion,
      cancel: streamingBody.cancel,
    };
  }

  private registerResponse(
    response: StreamingHttpResponse,
    deadline: RequestDeadline,
  ): StreamingHttpResponse {
    this.activeResponses.add(response);
    void response.completion.then(() => {
      this.activeResponses.delete(response);
      this.releaseDeadline(deadline);
    });
    return response;
  }

  private async finishShutdown(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } finally {
      this.state = "closed";
    }
  }

  private async closeGracefully(): Promise<void> {
    await this.waitForExchanges();
    await this.transport.close();
  }

  private async destroyImmediately(reason?: Error): Promise<void> {
    await this.waitForExchanges();
    await this.transport.destroy(reason);
  }

  private releaseDeadline(deadline: RequestDeadline): void {
    this.activeDeadlines.delete(deadline);
    deadline.dispose();
  }

  private finishExchange(): void {
    this.pendingExchanges -= 1;
    if (this.pendingExchanges !== 0) return;
    for (const resolve of this.exchangeWaiters) resolve();
    this.exchangeWaiters.clear();
  }

  private async waitForExchanges(): Promise<void> {
    if (this.pendingExchanges === 0) return;
    await new Promise<void>((resolve) => {
      this.exchangeWaiters.add(resolve);
    });
  }
}

export class HttpClientStateError extends Error {
  public override readonly name = "HttpClientStateError";
}

function parseUrl(value: string | URL): URL {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new TypeError("Request URL must be a string or URL.");
  }
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.username !== "" || url.password !== "") {
    const safeUrl = new URL(url.href);
    safeUrl.username = "";
    safeUrl.password = "";
    throw new UrlCredentialsError(safeUrl.href);
  }
  return url;
}

function assertSupportedProtocol(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsupported URL protocol: ${url.protocol}`);
  }
}

function loopIdentity(url: URL): string {
  const identity = new URL(url.href);
  identity.hash = "";
  return identity.href;
}

function cancelNodeBody(
  body: { on(event: "error", listener: () => undefined): unknown; destroy(reason?: Error): unknown },
  caught: unknown,
): void {
  body.on("error", ignoreFailure);
  body.destroy(caught instanceof Error ? caught : undefined);
}

function ignoreFailure(): undefined {
  return undefined;
}

function responseHasContent(
  method: string,
  statusCode: number,
): boolean {
  return (
    method !== "HEAD" &&
    (statusCode < 100 || statusCode >= 200) &&
    statusCode !== 204 &&
    statusCode !== 205 &&
    statusCode !== 304
  );
}

class UrlCredentialsError extends Error {
  public override readonly name = "UrlCredentialsError";
  public readonly safeUrl: string;

  public constructor(safeUrl: string) {
    super(
      "Request URL credentials are not accepted; use request headers or a credential provider.",
    );
    this.safeUrl = safeUrl;
  }
}

function safeErrorUrl(caught: unknown): string {
  return caught instanceof UrlCredentialsError ? caught.safeUrl : "";
}
