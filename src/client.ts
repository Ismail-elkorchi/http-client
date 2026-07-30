import { errors as undiciErrors } from "undici";
import {
  disposeResponseBody,
} from "./body.js";
import { readBody } from "./body-reader.js";
import {
  DEFAULT_HTTP_CLIENT_OPTIONS,
  DEFAULT_NETWORK_SAFETY,
  DEFAULT_RESPONSE_LIMITS,
} from "./defaults.js";
import {
  incomingHeaders,
  mergeRequestHeaders,
  requestAfterRedirect,
  type RedirectedRequest,
} from "./headers.js";
import { NetworkSafetyPolicy } from "./network-policy.js";
import {
  NetworkSafetyError,
  ProtocolMismatchError,
  UndiciTransport,
} from "./transport.js";
import type {
  HttpClientConfiguration,
  HttpClientOptions,
  HttpError,
  HttpErrorCode,
  HttpFailure,
  HttpRedirect,
  HttpRequestOptions,
  HttpResult,
  HttpSuccess,
  NetworkTimings,
  ResponseLimits,
  TlsFacts,
} from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type ExchangeOptions = Omit<HttpRequestOptions, "body"> & {
  readonly body?: string | Uint8Array | undefined;
};

export class NodeHttpClient {
  private readonly options: HttpClientOptions;
  private readonly transport: UndiciTransport;

  public constructor(
    configuration: HttpClientConfiguration = {},
    policy?: NetworkSafetyPolicy,
  ) {
    this.options = resolveOptions(configuration);
    const safety =
      policy ??
      new NetworkSafetyPolicy(
        this.options.networkSafety,
        this.options.resolver,
      );
    this.transport = new UndiciTransport(this.options, safety);
  }

  public async request(
    rawUrl: string | URL,
    options: HttpRequestOptions = {},
  ): Promise<HttpResult> {
    const deadline = createDeadline(
      this.options.requestTimeoutMs,
      options.signal,
    );
    try {
      return await this.requestExchange(
        rawUrl,
        options,
        deadline.signal,
        true,
        options.redirectResponseBody === "discard",
      );
    } finally {
      deadline.dispose();
    }
  }

  public async fetch(
    rawUrl: string | URL,
    options: HttpRequestOptions = {},
  ): Promise<HttpResult> {
    const startedAt = performance.now();
    const deadline = createDeadline(
      this.options.requestTimeoutMs,
      options.signal,
    );
    const redirects: HttpRedirect[] = [];
    const visited = new Set<string>();
    let currentUrl: URL;
    try {
      currentUrl = parseUrl(rawUrl);
    } catch (caught) {
      deadline.dispose();
      return failure(
        "INVALID_URL",
        "The request URL is invalid.",
        String(rawUrl),
        caught,
        startedAt,
      );
    }
    visited.add(loopIdentity(currentUrl));
    let request: RedirectedRequest = {
      method: options.method ?? "GET",
      headers: mergeRequestHeaders(
        this.options.defaultHeaders,
        options.headers,
      ),
      body: options.body,
    };
    const maxRedirects = options.maxRedirects ?? this.options.maxRedirects;

    try {
      for (let hopIndex = 0; ; hopIndex += 1) {
        const result = await this.requestExchange(
          currentUrl,
          {
            ...options,
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirectResponseBody: "discard",
          },
          deadline.signal,
          false,
          true,
        );
        if (!result.ok) {
          return withRedirects(result, redirects, startedAt);
        }
        const location = result.headers.get("location");
        if (
          !REDIRECT_STATUSES.has(result.statusCode ?? 0) ||
          location === null
        ) {
          return withRedirects(result, redirects, startedAt);
        }
        if (hopIndex >= maxRedirects) {
          await disposeResponseBody(result.body);
          return redirectFailure(
            "TOO_MANY_REDIRECTS",
            "Redirect limit exceeded.",
            currentUrl.href,
            result,
            redirects,
            startedAt,
          );
        }

        let target: URL;
        try {
          target = new URL(location, currentUrl);
          assertSupportedProtocol(target);
        } catch (caught) {
          await disposeResponseBody(result.body);
          return redirectFailure(
            "REDIRECT_TARGET_REJECTED",
            "The redirect target is invalid.",
            currentUrl.href,
            result,
            redirects,
            startedAt,
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
          await disposeResponseBody(result.body);
          return redirectFailure(
            "REDIRECT_LOOP",
            "Redirect loop detected.",
            target.href,
            result,
            nextRedirects,
            startedAt,
          );
        }
        const decision = await options.onRedirect?.({
          fromUrl: currentUrl.href,
          toUrl: target.href,
          statusCode: result.statusCode,
          hopIndex,
        });
        if (decision?.action === "reject") {
          await disposeResponseBody(result.body);
          return redirectFailure(
            "REDIRECT_TARGET_REJECTED",
            decision.reason,
            target.href,
            result,
            nextRedirects,
            startedAt,
          );
        }

        await disposeResponseBody(result.body);
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
    } finally {
      deadline.dispose();
    }
  }

  public async close(): Promise<void> {
    await this.transport.close();
  }

  private async requestExchange(
    rawUrl: string | URL,
    options: ExchangeOptions,
    signal: AbortSignal,
    mergeDefaults = true,
    discardRedirectBody = false,
  ): Promise<HttpResult> {
    const startedAt = performance.now();
    let url: URL;
    try {
      url = parseUrl(rawUrl);
    } catch (caught) {
      return failure(
        "INVALID_URL",
        "The request URL is invalid.",
        String(rawUrl),
        caught,
        startedAt,
      );
    }
    try {
      assertSupportedProtocol(url);
    } catch (caught) {
      return failure(
        "UNSUPPORTED_PROTOCOL",
        "Only HTTP and HTTPS URLs are supported.",
        url.href,
        caught,
        startedAt,
      );
    }

    const method = options.method ?? "GET";
    let headers: Readonly<Record<string, string>>;
    try {
      const credentialHeaders = await options.credentials?.requestHeaders(
        url.href,
      );
      headers = mergeRequestHeaders(
        mergeDefaults ? this.options.defaultHeaders : undefined,
        options.headers,
        credentialHeaders,
      );
    } catch (caught) {
      return failure(
        "FETCH_NETWORK_ERROR",
        "Request headers could not be prepared.",
        url.href,
        caught,
        startedAt,
      );
    }

    let response;
    const firstByteStartedAt = performance.now();
    const firstByteDeadline = createPhaseDeadline(
      this.options.firstByteTimeoutMs,
      signal,
    );
    try {
      response = await this.transport.request(
        url,
        method,
        headers,
        options.body,
        firstByteDeadline.signal,
      );
    } catch (caught) {
      if (firstByteDeadline.signal.reason instanceof FirstByteTimeoutError) {
        return failure(
          "FETCH_FIRST_BYTE_TIMEOUT",
          "The response headers timed out.",
          url.href,
          caught,
          startedAt,
        );
      }
      return failureFromCaught(caught, url.href, signal, startedAt);
    } finally {
      firstByteDeadline.dispose();
    }
    const firstByteMs = performance.now() - firstByteStartedAt;
    const responseHeaders = incomingHeaders(response.headers);
    try {
      await options.credentials?.captureResponse(url.href, responseHeaders);
    } catch (caught) {
      cancelResponseBody(response.body);
      return failure(
        "FETCH_NETWORK_ERROR",
        "Response credentials could not be captured.",
        url.href,
        caught,
        startedAt,
        response.statusCode,
        responseHeaders,
        response.facts,
      );
    }

    if (
      discardRedirectBody &&
      REDIRECT_STATUSES.has(response.statusCode) &&
      responseHeaders.has("location")
    ) {
      cancelResponseBody(response.body);
      const totalMs = performance.now() - startedAt;
      return success(
        url.href,
        response.statusCode,
        responseHeaders,
        { kind: "memory", bytes: new Uint8Array(), size: 0 },
        0,
        0,
        response.facts,
        {
          dnsMs: response.dnsMs,
          connectMs: null,
          tlsMs: null,
          firstByteMs,
          bodyMs: 0,
          totalMs,
        },
        startedAt,
      );
    }

    const bodyStartedAt = performance.now();
    const body = await readBody(
      response.body,
      response.headers["content-encoding"],
      resolveLimits(this.options.responseLimits, options.responseLimits),
      signal,
    );
    const timings: NetworkTimings = {
      dnsMs: response.dnsMs,
      connectMs: null,
      tlsMs: null,
      firstByteMs,
      bodyMs: performance.now() - bodyStartedAt,
      totalMs: performance.now() - startedAt,
    };
    if (!body.ok) {
      const code =
        signal.aborted && isDeadlineReason(signal.reason)
          ? "FETCH_TIMEOUT"
          : body.code;
      return failure(
        code,
        body.message,
        url.href,
        body.cause,
        startedAt,
        response.statusCode,
        responseHeaders,
        response.facts,
        body.wireBytesRead,
        body.decodedBytesRead,
        timings,
      );
    }
    return success(
      url.href,
      response.statusCode,
      responseHeaders,
      body.body,
      body.wireBytesRead,
      body.decodedBytesRead,
      response.facts,
      timings,
      startedAt,
    );
  }
}

function resolveOptions(
  configuration: HttpClientConfiguration,
): HttpClientOptions {
  const options: HttpClientOptions = {
    ...DEFAULT_HTTP_CLIENT_OPTIONS,
    ...configuration,
    responseLimits: resolveLimits(
      DEFAULT_RESPONSE_LIMITS,
      configuration.responseLimits,
    ),
    networkSafety: {
      ...DEFAULT_NETWORK_SAFETY,
      ...configuration.networkSafety,
    },
    defaultHeaders: mergeRequestHeaders(configuration.defaultHeaders),
  };
  for (const [name, value, minimum] of [
    ["requestTimeoutMs", options.requestTimeoutMs, 1],
    ["connectTimeoutMs", options.connectTimeoutMs, 1],
    ["firstByteTimeoutMs", options.firstByteTimeoutMs, 1],
    ["maxRedirects", options.maxRedirects, 0],
    ["maxConnectionsPerOrigin", options.maxConnectionsPerOrigin, 1],
    ["maxOrigins", options.maxOrigins, 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(
        `${name} must be a safe integer greater than or equal to ${String(minimum)}.`,
      );
    }
  }
  validateLimits(options.responseLimits);
  return options;
}

function resolveLimits(
  defaults: ResponseLimits,
  overrides: Partial<ResponseLimits> | undefined,
): ResponseLimits {
  const limits = { ...defaults, ...overrides };
  validateLimits(limits);
  return limits;
}

function validateLimits(limits: ResponseLimits): void {
  for (const [name, value] of [
    ["maxCompressedBytes", limits.maxCompressedBytes],
    ["maxDecompressedBytes", limits.maxDecompressedBytes],
    ["memoryThresholdBytes", limits.memoryThresholdBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
  }
}

function parseUrl(value: string | URL): URL {
  return value instanceof URL ? new URL(value.href) : new URL(value);
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

function createDeadline(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal:
      externalSignal === undefined
        ? timeout
        : AbortSignal.any([externalSignal, timeout]),
    dispose: () => {},
  };
}

function createPhaseDeadline(
  timeoutMs: number,
  externalSignal: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort(externalSignal.reason);
  };
  if (externalSignal.aborted) abortFromExternal();
  else externalSignal.addEventListener("abort", abortFromExternal, {
    once: true,
  });
  const timer = setTimeout(() => {
    controller.abort(new FirstByteTimeoutError());
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      externalSignal.removeEventListener("abort", abortFromExternal);
    },
  };
}

class FirstByteTimeoutError extends Error {
  public override readonly name = "FirstByteTimeoutError";

  public constructor() {
    super("The response headers timed out.");
  }
}

function isDeadlineReason(value: unknown): boolean {
  return value instanceof DOMException && value.name === "TimeoutError";
}

function failureFromCaught(
  caught: unknown,
  url: string,
  signal: AbortSignal,
  startedAt: number,
): HttpFailure {
  if (caught instanceof NetworkSafetyError) {
    const code =
      !caught.resolution.decision.allowed &&
      caught.resolution.decision.rejectionKind === "dns"
        ? "DNS_ERROR"
        : "NETWORK_SAFETY_REJECTED";
    return failure(
      code,
      caught.message,
      url,
      caught,
      startedAt,
    );
  }
  if (caught instanceof ProtocolMismatchError) {
    return failure(
      "PROTOCOL_MISMATCH",
      caught.message,
      url,
      caught,
      startedAt,
    );
  }
  if (signal.aborted) {
    return failure(
      isDeadlineReason(signal.reason) ? "FETCH_TIMEOUT" : "FETCH_ABORTED",
      isDeadlineReason(signal.reason)
        ? "The request deadline expired."
        : "The request was aborted.",
      url,
      caught,
      startedAt,
    );
  }
  if (caught instanceof undiciErrors.ConnectTimeoutError) {
    return failure(
      "FETCH_CONNECT_TIMEOUT",
      "The connection timed out.",
      url,
      caught,
      startedAt,
    );
  }
  if (caught instanceof undiciErrors.HeadersTimeoutError) {
    return failure(
      "FETCH_FIRST_BYTE_TIMEOUT",
      "The response headers timed out.",
      url,
      caught,
      startedAt,
    );
  }
  const code = errorCode(caught);
  if (code?.startsWith("ERR_TLS_") === true || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return failure("TLS_ERROR", "TLS negotiation failed.", url, caught, startedAt);
  }
  return failure(
    "FETCH_NETWORK_ERROR",
    "The HTTP request failed.",
    url,
    caught,
    startedAt,
  );
}

function errorCode(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value)
  ) {
    return null;
  }
  return typeof value.code === "string" ? value.code : null;
}

function failure(
  code: HttpErrorCode,
  message: string,
  url: string,
  cause: unknown,
  startedAt: number,
  statusCode: number | null = null,
  headers: Headers = new Headers(),
  facts: {
    readonly remoteAddress: string | null;
    readonly protocol: HttpFailure["protocol"];
    readonly tls: TlsFacts | null;
  } = { remoteAddress: null, protocol: "unknown", tls: null },
  wireBytesRead: number | null = null,
  decodedBytesRead: number | null = null,
  timings?: NetworkTimings,
): HttpFailure {
  const totalMs = performance.now() - startedAt;
  const error: HttpError = {
    code,
    message,
    url,
    retryable: retryable(code),
    cause,
  };
  return {
    ok: false,
    statusCode,
    finalUrl: url,
    headers,
    redirects: [],
    responseTimeMs: totalMs,
    wireBytesRead,
    decodedBytesRead,
    remoteAddress: facts.remoteAddress,
    protocol: facts.protocol,
    timings: timings ?? emptyTimings(totalMs),
    tls: facts.tls,
    body: null,
    error,
  };
}

function success(
  url: string,
  statusCode: number,
  headers: Headers,
  body: HttpSuccess["body"],
  wireBytesRead: number,
  decodedBytesRead: number,
  facts: {
    readonly remoteAddress: string | null;
    readonly protocol: HttpSuccess["protocol"];
    readonly tls: TlsFacts | null;
  },
  timings: NetworkTimings,
  startedAt: number,
): HttpSuccess {
  return {
    ok: true,
    statusCode,
    finalUrl: url,
    headers,
    redirects: [],
    responseTimeMs: performance.now() - startedAt,
    wireBytesRead,
    decodedBytesRead,
    remoteAddress: facts.remoteAddress,
    protocol: facts.protocol,
    timings,
    tls: facts.tls,
    body,
    error: null,
  };
}

function withRedirects(
  result: HttpResult,
  redirects: readonly HttpRedirect[],
  startedAt: number,
): HttpResult {
  return {
    ...result,
    redirects,
    responseTimeMs: performance.now() - startedAt,
    timings: {
      ...result.timings,
      totalMs: performance.now() - startedAt,
    },
  };
}

function redirectFailure(
  code: "REDIRECT_LOOP" | "REDIRECT_TARGET_REJECTED" | "TOO_MANY_REDIRECTS",
  message: string,
  url: string,
  previous: HttpSuccess,
  redirects: readonly HttpRedirect[],
  startedAt: number,
  cause: unknown = null,
): HttpFailure {
  const result = failure(
    code,
    message,
    url,
    cause,
    startedAt,
    previous.statusCode,
    previous.headers,
    previous,
    previous.wireBytesRead,
    previous.decodedBytesRead,
    previous.timings,
  );
  const totalMs = performance.now() - startedAt;
  return {
    ...result,
    redirects,
    responseTimeMs: totalMs,
    timings: { ...result.timings, totalMs },
  };
}

function emptyTimings(totalMs: number): NetworkTimings {
  return {
    dnsMs: null,
    connectMs: null,
    tlsMs: null,
    firstByteMs: null,
    bodyMs: null,
    totalMs,
  };
}

function retryable(code: HttpErrorCode): boolean {
  return new Set<HttpErrorCode>([
    "DNS_ERROR",
    "TLS_ERROR",
    "FETCH_TIMEOUT",
    "FETCH_CONNECT_TIMEOUT",
    "FETCH_FIRST_BYTE_TIMEOUT",
    "FETCH_NETWORK_ERROR",
  ]).has(code);
}

function cancelResponseBody(
  body: { on(event: "error", listener: () => undefined): unknown; destroy(): unknown },
): void {
  body.on("error", ignoreError);
  body.destroy();
}

function ignoreError(): undefined {
  return undefined;
}
