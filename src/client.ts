import { bufferResult } from "./buffered-response.ts";
import {
  resolveClientOptions,
  resolveRequestOptions,
  validateRedirectDecision,
  type ResolvedRequestOptions,
} from "./configuration.ts";
import {
  HttpConfigurationError,
  type HttpClientError,
} from "./errors.ts";
import {
  awaitWithSignal,
  PhaseDeadline,
  RequestDeadline,
  ResponseFieldsTimeoutError,
} from "./deadlines.ts";
import { mergeHttpFields } from "./fields.ts";
import {
  applyContentLength,
  enforceRequestFieldsLimit,
  requestAfterRedirect,
  type RedirectedRequest,
} from "./request-fields.ts";
import { NetworkSafetyPolicy } from "./network-policy.ts";
import { emitHttpClientEvent } from "./observer.ts";
import {
  prepareRequestBody,
  RequestBodyLimitError,
} from "./request-body.ts";
import {
  classifyError,
  clientError,
  failureResult,
} from "./outcomes.ts";
import { createStreamingBody } from "./response-stream.ts";
import { UndiciTransport } from "./transport.ts";
import type {
  BufferedHttpRequestOptions,
  BufferedHttpResult,
  HttpAttemptContext,
  HttpAttemptResponseHead,
  HttpAttemptResult,
  HttpClientConfiguration,
  HttpClientOptions,
  HttpFailure,
  HttpRedirect,
  HttpRequestOptions,
  HttpResponseCompletion,
  StreamingHttpResponse,
  StreamingHttpResult,
} from "./types.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NodeHttpClient {
  private readonly options: HttpClientOptions;
  private readonly transport: UndiciTransport;
  private readonly activeResponses = new Set<StreamingHttpResponse>();
  private readonly activeDeadlines = new Set<RequestDeadline>();
  private readonly exchangeWaiters = new Set<() => void>();
  private pendingExchanges = 0;
  private requestCounter = 0;
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
    const requestId = ++this.requestCounter;
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
            requestId,
            options,
            deadline.signal,
          )
        : await this.requestExchange(
            rawUrl,
            {
              method: options.method,
              fields: mergeHttpFields(
                this.options.defaultFields,
                options.fields,
              ),
              body: options.body,
            },
            {
              requestId,
              attemptIndex: 0,
              method: options.method,
              url: safeInputUrl(rawUrl),
            },
            options,
            deadline.signal,
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
    return this.registerResponse(result, deadline);
  }

  private async fetchWithRedirects(
    rawUrl: string | URL,
    requestId: number,
    options: ResolvedRequestOptions,
    signal: AbortSignal,
  ): Promise<StreamingHttpResult> {
    const redirects: HttpRedirect[] = [];
    const attempts: HttpAttemptResult[] = [];
    const visited = new Set<string>();
    let currentUrl: URL;
    try {
      currentUrl = parseUrl(rawUrl);
    } catch (caught) {
      const errorUrl = safeErrorUrl(caught);
      return this.failure(
        {
          requestId,
          attemptIndex: 0,
          method: options.method,
          url: errorUrl,
        },
        invalidUrlError(caught, errorUrl),
        options,
      );
    }
    visited.add(currentUrl.href);
    let request: RedirectedRequest = {
      method: options.method,
      fields: mergeHttpFields(
        this.options.defaultFields,
        options.fields,
      ),
      body: options.body,
    };

    for (let hopIndex = 0; ; hopIndex += 1) {
      const context: HttpAttemptContext = {
        requestId,
        attemptIndex: hopIndex,
        method: request.method,
        url: currentUrl.href,
      };
      const exchange = await this.requestExchange(
        currentUrl,
        request,
        context,
        options,
        signal,
        true,
      );
      if (exchange.kind === "failure") {
        return {
          ...exchange,
          redirects,
          attempts: [...attempts, ...exchange.attempts],
        };
      }
      const result: StreamingHttpResponse = {
        ...exchange,
        redirects: [...redirects],
        previousAttempts: [...attempts],
      };
      const location = result.fields.first("location");
      if (
        !REDIRECT_STATUSES.has(result.statusCode) ||
        location === null
      ) {
        return result;
      }

      result.cancel();
      const completion = await result.completion;
      if (hopIndex >= options.maxRedirects) {
        observeAttemptCompletion(options, completion);
        return redirectPolicyFailure(
          result,
          completion,
          clientError(
            "TOO_MANY_REDIRECTS",
            "Redirect limit exceeded.",
            currentUrl.href,
          ),
          currentUrl.href,
          redirects,
        );
      }

      let target: URL;
      try {
        target = redirectTarget(location, currentUrl);
        assertSupportedProtocol(target);
      } catch (caught) {
        observeAttemptCompletion(options, completion);
        return redirectPolicyFailure(
          result,
          completion,
          clientError(
            "REDIRECT_TARGET_REJECTED",
            "The redirect target is invalid.",
            currentUrl.href,
            caught,
          ),
          currentUrl.href,
          redirects,
        );
      }
      const redirect: HttpRedirect = {
        fromUrl: currentUrl.href,
        toUrl: target.href,
        statusCode: result.statusCode,
        hopIndex,
      };
      const nextRedirects = [...redirects, redirect];
      if (visited.has(target.href)) {
        observeAttemptCompletion(options, completion);
        return redirectPolicyFailure(
          result,
          completion,
          clientError(
            "REDIRECT_LOOP",
            "Redirect loop detected.",
            target.href,
          ),
          target.href,
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
        const error = signal.aborted
          ? classifyError(caught, target.href, signal, false)
          : clientError(
              "REDIRECT_TARGET_REJECTED",
              "The redirect callback failed.",
              target.href,
              caught,
            );
        observeAttemptCompletion(options, completion);
        return redirectPolicyFailure(
          result,
          completion,
          error,
          target.href,
          nextRedirects,
        );
      }
      if (decision?.action === "reject") {
        observeAttemptCompletion(options, completion);
        return redirectPolicyFailure(
          result,
          completion,
          clientError(
            "REDIRECT_TARGET_REJECTED",
            decision.reason,
            target.href,
          ),
          target.href,
          nextRedirects,
        );
      }

      const redirectAttempt = {
        kind: "redirect",
        requestId: completion.requestId,
        attemptIndex: completion.attemptIndex,
        method: completion.method,
        url: completion.url,
        response: completion.response,
        transfer: completion.transfer,
        redirect,
      } as const;
      emitHttpClientEvent(options.observer, {
        kind: "attempt-completed",
        attempt: redirectAttempt,
      });
      attempts.push(redirectAttempt);
      redirects.push(redirect);
      visited.add(target.href);
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
    initialContext: HttpAttemptContext,
    options: ResolvedRequestOptions,
    signal: AbortSignal,
    skipRedirectBodyDecoding: boolean,
  ): Promise<StreamingHttpResult> {
    const exchangeStartedAt = performance.now();
    let url: URL;
    try {
      url = parseUrl(rawUrl);
    } catch (caught) {
      const errorUrl = safeErrorUrl(caught);
      const context = { ...initialContext, url: errorUrl };
      return this.failure(
        context,
        invalidUrlError(caught, errorUrl),
        options,
      );
    }
    const context = { ...initialContext, url: url.href };
    try {
      assertSupportedProtocol(url);
    } catch (caught) {
      return this.failure(
        context,
        clientError(
          "UNSUPPORTED_PROTOCOL",
          "Only HTTP and HTTPS URLs are supported.",
          url.href,
          caught,
        ),
        options,
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
        return this.failure(
          context,
          clientError(
            "REQUEST_BODY_TOO_LARGE",
            caught.message,
            url.href,
            caught,
          ),
          options,
        );
      }
      throw caught;
    }
    let sessionFields;
    try {
      sessionFields =
        options.session === undefined
          ? undefined
          : await awaitWithSignal(
              Promise.resolve(
                options.session.prepareRequest({
                  ...context,
                  fields: request.fields,
                }),
              ),
              signal,
            );
    } catch (caught) {
      return this.failure(
        context,
        signal.aborted
          ? classifyError(caught, url.href, signal, false)
          : clientError(
              "NETWORK_FAILURE",
              "Session state could not prepare the request.",
              url.href,
              caught,
            ),
        options,
      );
    }
    const mergedFields = mergeHttpFields(request.fields, sessionFields);
    const decodingFields =
      options.responseContentDecoding === "decode" &&
      !mergedFields.has("accept-encoding")
        ? mergeHttpFields(mergedFields, [
            {
              name: "accept-encoding",
              value: "zstd, br, gzip, deflate",
            },
          ])
        : mergedFields;
    if (
      preparedBody.contentType !== null &&
      decodingFields.has("content-type")
    ) {
      throw new HttpConfigurationError(
        "Multipart content-type is controlled by the HTTP transport.",
      );
    }
    const representationFields =
      preparedBody.contentType === null
        ? decodingFields
        : mergeHttpFields(decodingFields, [
            { name: "content-type", value: preparedBody.contentType },
          ]);
    const fields = applyContentLength(
      representationFields,
      request.body !== undefined,
      preparedBody.contentLength,
    );
    try {
      enforceRequestFieldsLimit(
        fields,
        this.options.maxRequestFieldsBytes,
      );
    } catch (caught) {
      return this.failure(
        context,
        classifyError(caught, url.href, signal, false),
        options,
      );
    }
    emitHttpClientEvent(options.observer, {
      kind: "attempt-started",
      context,
      fields,
    });

    let response;
    const fieldsDeadline = new PhaseDeadline(
      options.timeouts.responseFieldsMs,
      signal,
      new ResponseFieldsTimeoutError(options.timeouts.responseFieldsMs),
    );
    try {
      response = await this.transport.request(url, {
        method: request.method,
        fields,
        createBody: preparedBody.create,
        signal: fieldsDeadline.signal,
        responseFieldsTimeoutMs: options.timeouts.responseFieldsMs,
        onRequestBodyProgress: (sentBytes) => {
          emitHttpClientEvent(options.observer, {
            kind: "request-body-progress",
            context,
            sentBytes,
          });
        },
        onInformationalResponse:
          options.onInformationalResponse === undefined
            ? undefined
            : (statusCode, informationalFields) => {
                options.onInformationalResponse?.({
                  statusCode,
                  fields: informationalFields,
                });
              },
      });
    } catch (caught) {
      if (caught instanceof HttpConfigurationError) throw caught;
      return this.failure(
        context,
        classifyError(caught, url.href, fieldsDeadline.signal, false),
        options,
      );
    } finally {
      fieldsDeadline.dispose();
    }

    const headTimings = {
      dnsMs: response.dnsMs,
      responseFieldsMs: performance.now() - exchangeStartedAt,
    };
    const responseHead: HttpAttemptResponseHead = {
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      fields: response.fields,
      connection: response.connection,
      timings: headTimings,
    };
    emitHttpClientEvent(options.observer, {
      kind: "response-started",
      context,
      response: responseHead,
    });

    try {
      if (options.session !== undefined) {
        await awaitWithSignal(
          Promise.resolve(
            options.session.acceptResponse({
              ...context,
              statusCode: response.statusCode,
              statusMessage: response.statusMessage,
              fields: response.fields,
            }),
          ),
          signal,
        );
      }
    } catch (caught) {
      cancelNodeBody(response.body, caught);
      return this.failure(
        context,
        signal.aborted
          ? classifyError(caught, url.href, signal, false)
          : clientError(
              "NETWORK_FAILURE",
              "Session state could not accept the response.",
              url.href,
              caught,
            ),
        options,
        responseHead,
      );
    }

    let streamingBody;
    const isFollowedRedirect =
      skipRedirectBodyDecoding &&
      REDIRECT_STATUSES.has(response.statusCode) &&
      response.fields.has("location");
    try {
      streamingBody = createStreamingBody({
        source: response.body,
        contentEncoding:
          options.responseContentDecoding === "decode" &&
          !isFollowedRedirect &&
          responseHasContent(request.method, response.statusCode)
            ? response.fields.all("content-encoding")
            : undefined,
        limits: options.responseTransferLimits,
        responseBodyProgressTimeoutMs:
          options.timeouts.responseBodyProgressMs,
        signal,
        attemptStartedAt: exchangeStartedAt,
        context,
        response: responseHead,
        observer: options.observer,
        onCompletion: isFollowedRedirect
          ? ignoreAttemptCompletion
          : (attempt) => {
              emitHttpClientEvent(options.observer, {
                kind: "attempt-completed",
                attempt,
              });
            },
        requestBodyBytesSent: response.requestBodyBytesSent,
        trailers: response.trailers,
        classifyFailure: (caught, decoding) =>
          classifyError(caught, url.href, signal, decoding),
      });
    } catch (caught) {
      cancelNodeBody(response.body, caught);
      return this.failure(
        context,
        classifyError(caught, url.href, signal, false),
        options,
        responseHead,
      );
    }
    return {
      kind: "response",
      ...context,
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      finalUrl: url.href,
      fields: response.fields,
      redirects: [],
      previousAttempts: [],
      connection: response.connection,
      headTimings,
      body: streamingBody.body,
      completion: streamingBody.completion,
      cancel: streamingBody.cancel,
    };
  }

  private failure(
    context: HttpAttemptContext,
    error: HttpClientError,
    options: ResolvedRequestOptions,
    response: HttpAttemptResponseHead | null = null,
  ): HttpFailure {
    const result = failureResult(context, error, [], [], response);
    const attempt = result.attempts[0];
    if (attempt !== undefined) {
      emitHttpClientEvent(options.observer, {
        kind: "attempt-completed",
        attempt,
      });
    }
    return result;
  }

  private registerResponse(
    response: StreamingHttpResponse,
    deadline: RequestDeadline,
  ): StreamingHttpResponse {
    const protectedResponse = Object.freeze(response);
    this.activeResponses.add(protectedResponse);
    void protectedResponse.completion.then(() => {
      this.activeResponses.delete(protectedResponse);
      this.releaseDeadline(deadline);
    });
    return protectedResponse;
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

function redirectPolicyFailure(
  response: StreamingHttpResponse,
  completion: HttpResponseCompletion,
  error: HttpClientError,
  finalUrl: string,
  redirects: readonly HttpRedirect[],
): HttpFailure {
  return {
    kind: "failure",
    requestId: response.requestId,
    error,
    finalUrl,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    fields: response.fields,
    redirects,
    attempts: [...response.previousAttempts, completion],
    connection: response.connection,
  };
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

function redirectTarget(location: string, currentUrl: URL): URL {
  const target = parseUrl(new URL(location, currentUrl));
  if (!location.includes("#")) target.hash = currentUrl.hash;
  return target;
}

function cancelNodeBody(
  body: {
    on(event: "error", listener: () => undefined): unknown;
    destroy(reason?: Error): unknown;
  },
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
      "Request URL credentials are not accepted; use request fields or a session adapter.",
    );
    this.safeUrl = safeUrl;
  }
}

function safeErrorUrl(caught: unknown): string {
  return caught instanceof UrlCredentialsError ? caught.safeUrl : "";
}

function safeInputUrl(value: string | URL): string {
  try {
    return parseUrl(value).href;
  } catch (caught) {
    return safeErrorUrl(caught);
  }
}

function invalidUrlError(
  caught: unknown,
  url: string,
): HttpClientError {
  return clientError(
    "INVALID_URL",
    caught instanceof UrlCredentialsError
      ? caught.message
      : "The request URL is invalid.",
    url,
    caught,
  );
}

function observeAttemptCompletion(
  options: ResolvedRequestOptions,
  attempt: HttpResponseCompletion,
): void {
  emitHttpClientEvent(options.observer, {
    kind: "attempt-completed",
    attempt,
  });
}

function ignoreAttemptCompletion(): void {}
