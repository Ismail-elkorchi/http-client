export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

export type ProtocolPreference = "auto" | "http1" | "http2";
export type NegotiatedProtocol = "http/1.1" | "h2" | "unknown";
export type MixedAddressPolicy = "reject-host" | "use-safe-addresses-only";

export interface NetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type NetworkResolver = (
  hostname: string,
) => Promise<readonly NetworkAddress[]>;

export interface NetworkSafetyOptions {
  readonly enabled: boolean;
  readonly allowPrivateNetworks: boolean;
  readonly allowLocalhost: boolean;
  readonly mixedAddressPolicy: MixedAddressPolicy;
  readonly dnsTimeoutMs: number;
  readonly dnsCacheTtlMs: number;
  readonly maxDnsCacheEntries: number;
}

export type NetworkSafetyDecision =
  | {
      readonly allowed: true;
      readonly reason: null;
      readonly checkedIp: string | null;
      readonly rejectionKind: null;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly checkedIp: string | null;
      readonly rejectionKind: "dns" | "policy";
    };

export interface NetworkResolution {
  readonly decision: NetworkSafetyDecision;
  readonly hostname: string;
  readonly addresses: readonly NetworkAddress[];
  readonly rejectedAddresses: readonly NetworkAddress[];
}

export interface ResponseLimits {
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly memoryThresholdBytes: number;
  readonly spoolDirectory: string | null;
}

export interface HttpClientOptions {
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly maxRedirects: number;
  readonly protocolPreference: ProtocolPreference;
  readonly rejectUnauthorized: boolean;
  readonly maxConnectionsPerOrigin: number;
  readonly maxOrigins: number;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly responseLimits: ResponseLimits;
  readonly networkSafety: NetworkSafetyOptions;
  readonly resolver?: NetworkResolver;
}

export interface HttpClientConfiguration {
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly firstByteTimeoutMs?: number;
  readonly maxRedirects?: number;
  readonly protocolPreference?: ProtocolPreference;
  readonly rejectUnauthorized?: boolean;
  readonly maxConnectionsPerOrigin?: number;
  readonly maxOrigins?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly responseLimits?: Partial<ResponseLimits>;
  readonly networkSafety?: Partial<NetworkSafetyOptions>;
  readonly resolver?: NetworkResolver;
}

export interface CredentialProvider {
  requestHeaders(url: string): Promise<Readonly<Record<string, string>>>;
  captureResponse(url: string, headers: Headers): Promise<void>;
}

export type RedirectDecision =
  | { readonly action: "follow" }
  | { readonly action: "reject"; readonly reason: string };

export interface RedirectContext {
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly statusCode: number;
  readonly hopIndex: number;
}

export interface HttpRequestOptions {
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
  readonly responseLimits?: ResponseLimits;
  readonly maxRedirects?: number;
  readonly redirectResponseBody?: "discard" | "read";
  readonly credentials?: CredentialProvider;
  readonly onRedirect?: (
    context: RedirectContext,
  ) => Promise<RedirectDecision> | RedirectDecision;
}

export interface HttpRedirect {
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly statusCode: number;
  readonly hopIndex: number;
}

export interface MemoryResponseBody {
  readonly kind: "memory";
  readonly bytes: Uint8Array;
  readonly size: number;
}

export interface FileResponseBody {
  readonly kind: "file";
  readonly path: string;
  readonly size: number;
  readonly temporary: boolean;
}

export type ResponseBody = MemoryResponseBody | FileResponseBody;

export interface NetworkTimings {
  readonly dnsMs: number | null;
  readonly connectMs: number | null;
  readonly tlsMs: number | null;
  readonly firstByteMs: number | null;
  readonly bodyMs: number | null;
  readonly totalMs: number;
}

export interface TlsFacts {
  readonly protocol: string | null;
  readonly cipher: string | null;
  readonly authorized: boolean | null;
  readonly authorizationError: string | null;
  readonly certificateValidTo: string | null;
}

export type HttpErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "NETWORK_SAFETY_REJECTED"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "FETCH_TIMEOUT"
  | "FETCH_CONNECT_TIMEOUT"
  | "FETCH_FIRST_BYTE_TIMEOUT"
  | "FETCH_ABORTED"
  | "FETCH_NETWORK_ERROR"
  | "FETCH_DECOMPRESSION_ERROR"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_LOOP"
  | "REDIRECT_TARGET_REJECTED"
  | "RESPONSE_TOO_LARGE"
  | "DECOMPRESSED_RESPONSE_TOO_LARGE"
  | "PROTOCOL_MISMATCH"
  | "FILESYSTEM_ERROR";

export interface HttpError {
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly url: string;
  readonly retryable: boolean;
  readonly cause: unknown;
}

interface HttpResultBase {
  readonly statusCode: number | null;
  readonly finalUrl: string;
  readonly headers: Headers;
  readonly redirects: readonly HttpRedirect[];
  readonly responseTimeMs: number;
  readonly wireBytesRead: number | null;
  readonly decodedBytesRead: number | null;
  readonly remoteAddress: string | null;
  readonly protocol: NegotiatedProtocol;
  readonly timings: NetworkTimings;
  readonly tls: TlsFacts | null;
}

export interface HttpSuccess extends HttpResultBase {
  readonly ok: true;
  readonly statusCode: number;
  readonly body: ResponseBody;
  readonly error: null;
}

export interface HttpFailure extends HttpResultBase {
  readonly ok: false;
  readonly body: null;
  readonly error: HttpError;
}

export type HttpResult = HttpSuccess | HttpFailure;
