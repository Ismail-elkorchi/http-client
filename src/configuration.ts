import {
  DEFAULT_HTTP_CLIENT_OPTIONS,
  DEFAULT_HTTP_TIMEOUTS,
  DEFAULT_NETWORK_SAFETY,
  DEFAULT_RESPONSE_STORAGE,
  DEFAULT_RESPONSE_TRANSFER_LIMITS,
  DEFAULT_TLS_OPTIONS,
} from "./defaults.js";
import { HttpConfigurationError } from "./errors.js";
import { mergeRequestHeaders } from "./headers.js";
import type {
  BufferedHttpRequestOptions,
  CredentialProvider,
  HttpClientConfiguration,
  HttpClientOptions,
  HttpMethod,
  HttpRequestBody,
  HttpRequestOptions,
  HttpTimeouts,
  NetworkSafetyOptions,
  ProtocolPreference,
  ProxyOptions,
  RedirectDecision,
  RequestTimeoutOverrides,
  ResponseStorageOptions,
  ResponseTransferLimits,
  TlsMaterial,
  TlsOptions,
} from "./types.js";

const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

const PROTOCOL_PREFERENCES = new Set<ProtocolPreference>([
  "auto",
  "http1",
  "http2",
]);

export interface ResolvedRequestOptions {
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: HttpRequestBody | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeouts: Omit<HttpTimeouts, "connectMs">;
  readonly responseTransferLimits: ResponseTransferLimits;
  readonly responseContentDecoding: "decode" | "preserve";
  readonly responseStorage: ResponseStorageOptions;
  readonly maxRequestBodyBytes: number;
  readonly maxRedirects: number;
  readonly credentials: CredentialProvider | undefined;
  readonly onInformationalResponse:
    | ((response: {
        readonly statusCode: number;
        readonly headers: Headers;
      }) => void)
    | undefined;
  readonly onRedirect:
    | ((
        context: {
          readonly fromUrl: string;
          readonly toUrl: string;
          readonly statusCode: number;
          readonly hopIndex: number;
        },
      ) => Promise<RedirectDecision> | RedirectDecision)
    | undefined;
}

export function resolveClientOptions(
  configuration: HttpClientConfiguration,
): HttpClientOptions {
  assertObject(configuration, "HTTP client configuration");
  assertKnownKeys(
    configuration,
    [
      "timeouts",
      "maxRedirects",
      "protocolPreference",
      "responseContentDecoding",
      "maxConnectionsPerOrigin",
      "maxOrigins",
      "maxRequestBodyBytes",
      "maxRequestHeadersBytes",
      "maxResponseHeadersBytes",
      "defaultHeaders",
      "responseTransferLimits",
      "responseStorage",
      "tls",
      "proxy",
      "networkSafety",
      "resolver",
    ],
    "HTTP client configuration",
  );
  const timeouts = resolveTimeouts(configuration.timeouts);
  const responseTransferLimits = resolveTransferLimits(
    configuration.responseTransferLimits,
  );
  const responseStorage = resolveStorage(configuration.responseStorage);
  const tls = resolveTls(configuration.tls);
  const networkSafety = resolveNetworkSafety(configuration.networkSafety);
  const proxy = resolveProxy(configuration.proxy);
  const options: HttpClientOptions = {
    timeouts,
    maxRedirects:
      configuration.maxRedirects ??
      DEFAULT_HTTP_CLIENT_OPTIONS.maxRedirects,
    protocolPreference:
      configuration.protocolPreference ??
      DEFAULT_HTTP_CLIENT_OPTIONS.protocolPreference,
    responseContentDecoding:
      configuration.responseContentDecoding ??
      DEFAULT_HTTP_CLIENT_OPTIONS.responseContentDecoding,
    maxConnectionsPerOrigin:
      configuration.maxConnectionsPerOrigin ??
      DEFAULT_HTTP_CLIENT_OPTIONS.maxConnectionsPerOrigin,
    maxOrigins:
      configuration.maxOrigins ?? DEFAULT_HTTP_CLIENT_OPTIONS.maxOrigins,
    maxRequestBodyBytes:
      configuration.maxRequestBodyBytes ??
      DEFAULT_HTTP_CLIENT_OPTIONS.maxRequestBodyBytes,
    maxRequestHeadersBytes:
      configuration.maxRequestHeadersBytes ??
      DEFAULT_HTTP_CLIENT_OPTIONS.maxRequestHeadersBytes,
    maxResponseHeadersBytes:
      configuration.maxResponseHeadersBytes ??
      DEFAULT_HTTP_CLIENT_OPTIONS.maxResponseHeadersBytes,
    defaultHeaders: mergeRequestHeaders(configuration.defaultHeaders),
    responseTransferLimits,
    responseStorage,
    tls,
    proxy,
    networkSafety,
    ...(configuration.resolver === undefined
      ? {}
      : { resolver: configuration.resolver }),
  };
  validateNonNegativeInteger("maxRedirects", options.maxRedirects);
  validatePositiveInteger(
    "maxConnectionsPerOrigin",
    options.maxConnectionsPerOrigin,
  );
  validatePositiveInteger("maxOrigins", options.maxOrigins);
  validateNonNegativeInteger(
    "maxRequestBodyBytes",
    options.maxRequestBodyBytes,
  );
  validatePositiveInteger(
    "maxRequestHeadersBytes",
    options.maxRequestHeadersBytes,
  );
  validatePositiveInteger(
    "maxResponseHeadersBytes",
    options.maxResponseHeadersBytes,
  );
  if (!PROTOCOL_PREFERENCES.has(options.protocolPreference)) {
    throw new HttpConfigurationError(
      "protocolPreference must be auto, http1, or http2.",
    );
  }
  if (
    options.responseContentDecoding !== "decode" &&
    options.responseContentDecoding !== "preserve"
  ) {
    throw new HttpConfigurationError(
      "responseContentDecoding must be decode or preserve.",
    );
  }
  if (
    configuration.resolver !== undefined &&
    typeof configuration.resolver !== "function"
  ) {
    throw new HttpConfigurationError("resolver must be a function.");
  }
  if (proxy !== null && networkSafety.enabled) {
    throw new HttpConfigurationError(
      "A proxy cannot preserve target address pinning; networkSafety.enabled must be false.",
    );
  }
  return options;
}

export function resolveRequestOptions(
  options: HttpRequestOptions | BufferedHttpRequestOptions,
  client: HttpClientOptions,
  buffered: boolean,
): ResolvedRequestOptions {
  assertObject(options, "HTTP request options");
  assertKnownKeys(
    options,
    [
      "method",
      "headers",
      "body",
      "signal",
      "timeouts",
      "responseContentDecoding",
      "responseTransferLimits",
      "maxRequestBodyBytes",
      "maxRedirects",
      "credentials",
      "onInformationalResponse",
      "onRedirect",
      ...(buffered ? ["responseStorage"] : []),
    ],
    "HTTP request options",
  );
  const method = options.method ?? "GET";
  if (!HTTP_METHODS.has(method)) {
    throw new HttpConfigurationError(
      "method must be a supported uppercase HTTP method.",
    );
  }
  validateRequestBody(options.body);
  if (
    options.body !== undefined &&
    (method === "GET" || method === "HEAD" || method === "TRACE")
  ) {
    throw new HttpConfigurationError(
      `${method} requests cannot contain a request body.`,
    );
  }
  validateSignal(options.signal);
  validateCredentialProvider(options.credentials);
  if (
    options.onInformationalResponse !== undefined &&
    typeof options.onInformationalResponse !== "function"
  ) {
    throw new HttpConfigurationError(
      "onInformationalResponse must be a function.",
    );
  }
  if (
    options.onRedirect !== undefined &&
    typeof options.onRedirect !== "function"
  ) {
    throw new HttpConfigurationError("onRedirect must be a function.");
  }
  const maxRedirects = options.maxRedirects ?? client.maxRedirects;
  validateNonNegativeInteger("maxRedirects", maxRedirects);
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? client.maxRequestBodyBytes;
  validateNonNegativeInteger("maxRequestBodyBytes", maxRequestBodyBytes);
  const responseContentDecoding =
    options.responseContentDecoding ?? client.responseContentDecoding;
  if (
    responseContentDecoding !== "decode" &&
    responseContentDecoding !== "preserve"
  ) {
    throw new HttpConfigurationError(
      "responseContentDecoding must be decode or preserve.",
    );
  }
  const responseStorage =
    buffered && "responseStorage" in options
      ? resolveStorage(options.responseStorage, client.responseStorage)
      : client.responseStorage;
  return {
    method,
    headers: mergeRequestHeaders(options.headers),
    body: options.body,
    signal: options.signal,
    timeouts: resolveRequestTimeouts(options.timeouts, client.timeouts),
    responseTransferLimits: resolveTransferLimits(
      options.responseTransferLimits,
      client.responseTransferLimits,
    ),
    responseContentDecoding,
    responseStorage,
    maxRequestBodyBytes,
    maxRedirects,
    credentials: options.credentials,
    onInformationalResponse: options.onInformationalResponse,
    onRedirect: options.onRedirect,
  };
}

export function validateRedirectDecision(
  value: RedirectDecision | undefined,
): RedirectDecision | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !("action" in value)) {
    throw new HttpConfigurationError(
      "onRedirect must return a redirect decision.",
    );
  }
  if (value.action === "follow") {
    assertKnownKeys(value, ["action"], "redirect decision");
    return value;
  }
  if (
    value.action === "reject" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    value.reason.length > 0
  ) {
    assertKnownKeys(value, ["action", "reason"], "redirect decision");
    return value;
  }
  throw new HttpConfigurationError(
    "onRedirect returned an invalid redirect decision.",
  );
}

function resolveTimeouts(
  overrides: Partial<HttpTimeouts> | undefined,
): HttpTimeouts {
  assertOptionalObject(overrides, "timeouts");
  if (overrides !== undefined) {
    assertKnownKeys(
      overrides,
      [
        "totalMs",
        "connectMs",
        "responseHeadersMs",
        "responseBodyProgressMs",
      ],
      "timeouts",
    );
  }
  const value = { ...DEFAULT_HTTP_TIMEOUTS, ...overrides };
  validatePositiveInteger("timeouts.totalMs", value.totalMs);
  validatePositiveInteger("timeouts.connectMs", value.connectMs);
  validatePositiveInteger(
    "timeouts.responseHeadersMs",
    value.responseHeadersMs,
  );
  validatePositiveInteger(
    "timeouts.responseBodyProgressMs",
    value.responseBodyProgressMs,
  );
  return value;
}

function resolveRequestTimeouts(
  overrides: RequestTimeoutOverrides | undefined,
  defaults: HttpTimeouts,
): Omit<HttpTimeouts, "connectMs"> {
  assertOptionalObject(overrides, "request timeouts");
  if (overrides !== undefined) {
    assertKnownKeys(
      overrides,
      ["totalMs", "responseHeadersMs", "responseBodyProgressMs"],
      "request timeouts",
    );
  }
  const value = {
    totalMs: overrides?.totalMs ?? defaults.totalMs,
    responseHeadersMs:
      overrides?.responseHeadersMs ?? defaults.responseHeadersMs,
    responseBodyProgressMs:
      overrides?.responseBodyProgressMs ??
      defaults.responseBodyProgressMs,
  };
  validatePositiveInteger("timeouts.totalMs", value.totalMs);
  validatePositiveInteger(
    "timeouts.responseHeadersMs",
    value.responseHeadersMs,
  );
  validatePositiveInteger(
    "timeouts.responseBodyProgressMs",
    value.responseBodyProgressMs,
  );
  return value;
}

function resolveTransferLimits(
  overrides: Partial<ResponseTransferLimits> | undefined,
  defaults: ResponseTransferLimits = DEFAULT_RESPONSE_TRANSFER_LIMITS,
): ResponseTransferLimits {
  assertOptionalObject(overrides, "responseTransferLimits");
  if (overrides !== undefined) {
    assertKnownKeys(
      overrides,
      ["maxWireBytes", "maxDecodedBytes", "maxContentEncodingLayers"],
      "responseTransferLimits",
    );
  }
  const value = { ...defaults, ...overrides };
  validateNonNegativeInteger("maxWireBytes", value.maxWireBytes);
  validateNonNegativeInteger("maxDecodedBytes", value.maxDecodedBytes);
  validateNonNegativeInteger(
    "maxContentEncodingLayers",
    value.maxContentEncodingLayers,
  );
  return value;
}

function resolveStorage(
  overrides: Partial<ResponseStorageOptions> | undefined,
  defaults: ResponseStorageOptions = DEFAULT_RESPONSE_STORAGE,
): ResponseStorageOptions {
  assertOptionalObject(overrides, "responseStorage");
  if (overrides !== undefined) {
    assertKnownKeys(
      overrides,
      ["memoryThresholdBytes", "spoolDirectory"],
      "responseStorage",
    );
  }
  const value = { ...defaults, ...overrides };
  validateNonNegativeInteger(
    "memoryThresholdBytes",
    value.memoryThresholdBytes,
  );
  if (
    value.spoolDirectory !== null &&
    (typeof value.spoolDirectory !== "string" ||
      value.spoolDirectory.length === 0)
  ) {
    throw new HttpConfigurationError(
      "spoolDirectory must be a non-empty string or null.",
    );
  }
  return value;
}

function resolveNetworkSafety(
  overrides: Partial<NetworkSafetyOptions> | undefined,
): NetworkSafetyOptions {
  assertOptionalObject(overrides, "networkSafety");
  if (overrides !== undefined) {
    assertKnownKeys(
      overrides,
      [
        "enabled",
        "allowPrivateNetworks",
        "allowLocalhost",
        "mixedAddressPolicy",
        "dnsTimeoutMs",
        "dnsCacheTtlMs",
        "maxDnsCacheEntries",
        "addressAttemptDelayMs",
      ],
      "networkSafety",
    );
  }
  const value = { ...DEFAULT_NETWORK_SAFETY, ...overrides };
  validateBoolean("networkSafety.enabled", value.enabled);
  validateBoolean(
    "networkSafety.allowPrivateNetworks",
    value.allowPrivateNetworks,
  );
  validateBoolean(
    "networkSafety.allowLocalhost",
    value.allowLocalhost,
  );
  if (
    value.mixedAddressPolicy !== "reject-host" &&
    value.mixedAddressPolicy !== "use-safe-addresses-only"
  ) {
    throw new HttpConfigurationError(
      "networkSafety.mixedAddressPolicy is invalid.",
    );
  }
  validatePositiveInteger("networkSafety.dnsTimeoutMs", value.dnsTimeoutMs);
  validateNonNegativeInteger(
    "networkSafety.dnsCacheTtlMs",
    value.dnsCacheTtlMs,
  );
  validatePositiveInteger(
    "networkSafety.maxDnsCacheEntries",
    value.maxDnsCacheEntries,
  );
  validatePositiveInteger(
    "networkSafety.addressAttemptDelayMs",
    value.addressAttemptDelayMs,
  );
  return value;
}

function resolveTls(
  overrides: Partial<TlsOptions> | undefined,
  defaults: TlsOptions = DEFAULT_TLS_OPTIONS,
): TlsOptions {
  assertOptionalObject(overrides, "tls");
  if (overrides !== undefined) {
    assertKnownKeys(
      overrides,
      [
        "rejectUnauthorized",
        "certificateAuthorities",
        "clientCertificate",
        "clientPrivateKey",
        "privateKeyPassphrase",
        "serverName",
        "minimumVersion",
        "maximumVersion",
        "ciphers",
      ],
      "tls",
    );
  }
  const value = { ...defaults, ...overrides };
  validateBoolean("tls.rejectUnauthorized", value.rejectUnauthorized);
  validateTlsMaterial("tls.certificateAuthorities", value.certificateAuthorities);
  validateTlsMaterial("tls.clientCertificate", value.clientCertificate);
  validateTlsMaterial("tls.clientPrivateKey", value.clientPrivateKey);
  for (const [name, item] of [
    ["tls.privateKeyPassphrase", value.privateKeyPassphrase],
    ["tls.serverName", value.serverName],
    ["tls.minimumVersion", value.minimumVersion],
    ["tls.maximumVersion", value.maximumVersion],
    ["tls.ciphers", value.ciphers],
  ] as const) {
    if (item !== undefined && (typeof item !== "string" || item.length === 0)) {
      throw new HttpConfigurationError(
        `${name} must be a non-empty string.`,
      );
    }
  }
  const hasCertificate = value.clientCertificate !== undefined;
  const hasPrivateKey = value.clientPrivateKey !== undefined;
  if (hasCertificate !== hasPrivateKey) {
    throw new HttpConfigurationError(
      "tls.clientCertificate and tls.clientPrivateKey must be configured together.",
    );
  }
  if (
    value.privateKeyPassphrase !== undefined &&
    value.clientPrivateKey === undefined
  ) {
    throw new HttpConfigurationError(
      "tls.privateKeyPassphrase requires tls.clientPrivateKey.",
    );
  }
  const versions = new Set(["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]);
  if (
    (value.minimumVersion !== undefined &&
      !versions.has(value.minimumVersion)) ||
    (value.maximumVersion !== undefined &&
      !versions.has(value.maximumVersion))
  ) {
    throw new HttpConfigurationError(
      "TLS versions must be TLSv1 through TLSv1.3.",
    );
  }
  const versionOrder = new Map([
    ["TLSv1", 1],
    ["TLSv1.1", 2],
    ["TLSv1.2", 3],
    ["TLSv1.3", 4],
  ]);
  if (
    value.minimumVersion !== undefined &&
    value.maximumVersion !== undefined &&
    (versionOrder.get(value.minimumVersion) ?? 0) >
      (versionOrder.get(value.maximumVersion) ?? 0)
  ) {
    throw new HttpConfigurationError(
      "tls.minimumVersion cannot exceed tls.maximumVersion.",
    );
  }
  if (
    value.serverName !== undefined &&
    /[\u0000-\u0020\u007f]/u.test(value.serverName)
  ) {
    throw new HttpConfigurationError(
      "tls.serverName cannot contain spaces or control characters.",
    );
  }
  return value;
}

function resolveProxy(
  configuration: HttpClientConfiguration["proxy"],
): ProxyOptions | null {
  if (configuration === undefined || configuration === null) return null;
  assertObject(configuration, "proxy configuration");
  assertKnownKeys(
    configuration,
    ["url", "headers", "tls"],
    "proxy configuration",
  );
  let url: URL;
  try {
    url =
      configuration.url instanceof URL
        ? new URL(configuration.url.href)
        : new URL(configuration.url);
  } catch {
    throw new HttpConfigurationError(
      "proxy.url is invalid.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpConfigurationError(
      "proxy.url must use HTTP or HTTPS.",
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new HttpConfigurationError(
      "proxy.url must contain only a proxy origin.",
    );
  }
  const headers = mergeRequestHeaders(configuration.headers);
  if (
    (url.username !== "" || url.password !== "") &&
    headers["proxy-authorization"] !== undefined
  ) {
    throw new HttpConfigurationError(
      "Proxy credentials must use either proxy.url or proxy headers.",
    );
  }
  return {
    url: url.href,
    headers,
    tls: resolveTls(configuration.tls),
  };
}

function validateRequestBody(value: HttpRequestBody | undefined): void {
  if (value === undefined) return;
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    typeof value.kind !== "string"
  ) {
    throw new HttpConfigurationError(
      "body must be a discriminated request body.",
    );
  }
  if (
    value.kind !== "bytes" &&
    value.kind !== "text" &&
    value.kind !== "multipart" &&
    value.kind !== "stream"
  ) {
    throw new HttpConfigurationError("body.kind is invalid.");
  }
  switch (value.kind) {
    case "bytes":
      assertKnownKeys(value, ["kind", "bytes"], "bytes request body");
      break;
    case "text":
      assertKnownKeys(value, ["kind", "text"], "text request body");
      break;
    case "multipart":
      assertKnownKeys(value, ["kind", "parts"], "multipart request body");
      break;
    case "stream":
      assertKnownKeys(
        value,
        ["kind", "create", "contentLength"],
        "stream request body",
      );
      break;
  }
}

function validateSignal(value: AbortSignal | undefined): void {
  if (value !== undefined && !(value instanceof AbortSignal)) {
    throw new HttpConfigurationError("signal must be an AbortSignal.");
  }
}

function validateCredentialProvider(
  value: CredentialProvider | undefined,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.requestHeaders !== "function" ||
    typeof value.captureResponse !== "function"
  ) {
    throw new HttpConfigurationError(
      "credentials must implement requestHeaders and captureResponse.",
    );
  }
}

function validateTlsMaterial(
  name: string,
  value: TlsMaterial | undefined,
): void {
  if (value === undefined) return;
  const items = Array.isArray(value) ? value : [value];
  if (
    items.length === 0 ||
    items.some(
      (item) =>
        !(
          (typeof item === "string" && item.length > 0) ||
          (item instanceof Uint8Array && item.byteLength > 0)
        ),
    )
  ) {
    throw new HttpConfigurationError(
      `${name} must contain non-empty strings or byte arrays.`,
    );
  }
}

function validateBoolean(name: string, value: boolean): void {
  if (typeof value !== "boolean") {
    throw new HttpConfigurationError(`${name} must be a boolean.`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpConfigurationError(
      `${name} must be a positive safe integer.`,
    );
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpConfigurationError(
      `${name} must be a non-negative safe integer.`,
    );
  }
}

function assertObject(value: unknown, name: string): asserts value is object {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new HttpConfigurationError(`${name} must be an object.`);
  }
}

function assertOptionalObject(value: unknown, name: string): void {
  if (value !== undefined) assertObject(value, name);
}

function assertKnownKeys(
  value: object,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new HttpConfigurationError(
      `${name} contains an unknown ${unknown} property.`,
    );
  }
}
