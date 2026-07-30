import type { SecureVersion } from "node:tls";
import type { RESPONSE_BODY_BRAND } from "./body-brand.js";
import type { HttpClientError } from "./errors.js";
import type { HttpFields } from "./fields.js";

declare const EXTENSION_HTTP_METHOD: unique symbol;

export type StandardHttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "TRACE";

export type ExtensionHttpMethod = string & {
  readonly [EXTENSION_HTTP_METHOD]: true;
};

export type HttpMethod = StandardHttpMethod | ExtensionHttpMethod;

export interface HttpFieldInput {
  readonly name: string;
  readonly value: string;
}

export interface HttpField {
  readonly name: string;
  readonly value: string;
}

export type HttpFieldsInput = readonly HttpFieldInput[];

export type ProtocolPreference = "auto" | "http1" | "http2";
export type HttpVersion = "http/1.1" | "http/2";
export type ResponseContentDecoding = "decode" | "preserve";
export type MixedAddressPolicy = "reject-host" | "use-safe-addresses-only";

export interface NetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type NetworkResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly NetworkAddress[]>;

export interface NetworkSafetyOptions {
  readonly enabled: boolean;
  readonly allowPrivateNetworks: boolean;
  readonly allowLocalhost: boolean;
  readonly mixedAddressPolicy: MixedAddressPolicy;
  readonly dnsTimeoutMs: number;
  readonly dnsCacheTtlMs: number;
  readonly maxDnsCacheEntries: number;
  readonly addressAttemptDelayMs: number;
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

export interface ResponseTransferLimits {
  readonly maxWireBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxContentEncodingLayers: number;
}

export interface ResponseStorageOptions {
  readonly memoryThresholdBytes: number;
  readonly spoolDirectory: string | null;
}

export interface HttpTimeouts {
  readonly totalMs: number | null;
  readonly connectMs: number;
  readonly responseFieldsMs: number;
  readonly responseBodyProgressMs: number | null;
}

export interface RequestTimeoutOverrides {
  readonly totalMs?: number | null;
  readonly responseFieldsMs?: number;
  readonly responseBodyProgressMs?: number | null;
}

export type TlsMaterial =
  | string
  | Uint8Array
  | readonly (string | Uint8Array)[];

export interface TlsOptions {
  readonly rejectUnauthorized: boolean;
  readonly certificateAuthorities?: TlsMaterial;
  readonly clientCertificate?: TlsMaterial;
  readonly clientPrivateKey?: TlsMaterial;
  readonly privateKeyPassphrase?: string;
  readonly serverName?: string;
  readonly minimumVersion?: SecureVersion;
  readonly maximumVersion?: SecureVersion;
  readonly ciphers?: string;
}

export interface ProxyOptions {
  readonly url: string;
  readonly fields: HttpFields;
  readonly tls: TlsOptions;
}

export interface ProxyConfiguration {
  readonly url: string | URL;
  readonly fields?: HttpFieldsInput;
  readonly tls?: Partial<TlsOptions>;
}

export interface HttpClientObserver {
  onEvent(event: HttpClientEvent): void;
}

export interface HttpClientOptions {
  readonly timeouts: HttpTimeouts;
  readonly maxRedirects: number;
  readonly protocolPreference: ProtocolPreference;
  readonly responseContentDecoding: ResponseContentDecoding;
  readonly maxConnectionsPerOrigin: number;
  readonly maxOrigins: number;
  readonly maxRequestBodyBytes: number;
  readonly maxRequestFieldsBytes: number;
  readonly maxResponseFieldsBytes: number;
  readonly defaultFields: HttpFields;
  readonly responseTransferLimits: ResponseTransferLimits;
  readonly responseStorage: ResponseStorageOptions;
  readonly tls: TlsOptions;
  readonly proxy: ProxyOptions | null;
  readonly networkSafety: NetworkSafetyOptions;
  readonly observer?: HttpClientObserver;
  readonly resolver?: NetworkResolver;
}

export interface HttpClientConfiguration {
  readonly timeouts?: Partial<HttpTimeouts>;
  readonly maxRedirects?: number;
  readonly protocolPreference?: ProtocolPreference;
  readonly responseContentDecoding?: ResponseContentDecoding;
  readonly maxConnectionsPerOrigin?: number;
  readonly maxOrigins?: number;
  readonly maxRequestBodyBytes?: number;
  readonly maxRequestFieldsBytes?: number;
  readonly maxResponseFieldsBytes?: number;
  readonly defaultFields?: HttpFieldsInput;
  readonly responseTransferLimits?: Partial<ResponseTransferLimits>;
  readonly responseStorage?: Partial<ResponseStorageOptions>;
  readonly tls?: Partial<TlsOptions>;
  readonly proxy?: ProxyConfiguration | null;
  readonly networkSafety?: Partial<NetworkSafetyOptions>;
  readonly observer?: HttpClientObserver;
  readonly resolver?: NetworkResolver;
}

export type RequestByteStream =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export type MultipartFileContent =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | {
      readonly kind: "stream";
      readonly contentLength: number;
      readonly create: () => RequestByteStream;
    };

export type MultipartPart =
  | {
      readonly kind: "text";
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly fileName: string;
      readonly mediaType?: string;
      readonly content: MultipartFileContent;
    };

export type HttpRequestBody =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "multipart"; readonly parts: readonly MultipartPart[] }
  | {
      readonly kind: "stream";
      readonly create: () => RequestByteStream;
      readonly contentLength?: number;
    };

export interface HttpAttemptContext {
  readonly requestId: number;
  readonly attemptIndex: number;
  readonly url: string;
  readonly method: HttpMethod;
}

export interface HttpSessionRequestContext extends HttpAttemptContext {
  readonly fields: HttpFields;
}

export interface HttpSessionResponseContext extends HttpAttemptContext {
  readonly statusCode: number;
  readonly statusMessage: string | null;
  readonly fields: HttpFields;
}

export interface HttpSessionAdapter {
  prepareRequest(
    context: HttpSessionRequestContext,
  ): Promise<HttpFieldsInput | undefined>;
  acceptResponse(context: HttpSessionResponseContext): Promise<void>;
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

interface HttpRequestOptionsBase {
  readonly fields?: HttpFieldsInput;
  readonly signal?: AbortSignal;
  readonly timeouts?: RequestTimeoutOverrides;
  readonly responseContentDecoding?: ResponseContentDecoding;
  readonly responseTransferLimits?: Partial<ResponseTransferLimits>;
  readonly maxRequestBodyBytes?: number;
  readonly maxRedirects?: number;
  readonly session?: HttpSessionAdapter;
  readonly observer?: HttpClientObserver;
  readonly onInformationalResponse?: (
    response: InformationalResponse,
  ) => void;
  readonly onRedirect?: (
    context: RedirectContext,
  ) => Promise<RedirectDecision> | RedirectDecision;
}

type BodylessRequestOptions =
  | {
      readonly method?: "GET";
      readonly body?: never;
    }
  | {
      readonly method: "HEAD" | "TRACE";
      readonly body?: never;
    };

type BodyRequestOptions = {
  readonly method:
    | Exclude<StandardHttpMethod, "GET" | "HEAD" | "TRACE">
    | ExtensionHttpMethod;
  readonly body?: HttpRequestBody;
};

export type HttpRequestOptions = HttpRequestOptionsBase &
  (BodylessRequestOptions | BodyRequestOptions);

export interface InformationalResponse {
  readonly statusCode: number;
  readonly fields: HttpFields;
}

export type BufferedHttpRequestOptions = HttpRequestOptions & {
  readonly responseStorage?: Partial<ResponseStorageOptions>;
};

export interface HttpRedirect {
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly statusCode: number;
  readonly hopIndex: number;
}

export interface MemoryResponseBody {
  readonly [RESPONSE_BODY_BRAND]: true;
  readonly kind: "memory";
  readonly bytes: Uint8Array;
  readonly size: number;
}

export interface FileResponseBody {
  readonly [RESPONSE_BODY_BRAND]: true;
  readonly kind: "file";
  readonly path: string;
  readonly size: number;
  readonly temporary: boolean;
}

export type ResponseBody = MemoryResponseBody | FileResponseBody;

export interface ResponseHeadTimings {
  readonly dnsMs: number | null;
  readonly responseFieldsMs: number;
}

export interface ResponseTransferTimings extends ResponseHeadTimings {
  readonly responseBodyMs: number;
  readonly totalMs: number;
}

export interface PeerCertificateFacts {
  readonly subject: Readonly<Record<string, string>>;
  readonly issuer: Readonly<Record<string, string>>;
  readonly subjectAlternativeName: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly fingerprintSha256: string | null;
  readonly serialNumber: string | null;
}

export interface TlsFacts {
  readonly version: string | null;
  readonly cipher: string | null;
  readonly authorized: boolean;
  readonly authorizationError: string | null;
  readonly serverName: string | null;
  readonly peerCertificate: PeerCertificateFacts | null;
}

export interface ConnectionFacts {
  readonly socketRemoteAddress: string | null;
  readonly socketRemotePort: number | null;
  readonly socketAddressFamily: 4 | 6 | null;
  readonly establishmentMs: number | null;
  readonly connectionReused: boolean | null;
  readonly httpVersion: HttpVersion | null;
  readonly tls: TlsFacts | null;
  readonly proxyUrl: string | null;
}

export type HttpErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "NETWORK_SAFETY_REJECTED"
  | "DNS_ERROR"
  | "TLS_ERROR"
  | "TOTAL_TIMEOUT"
  | "CONNECT_TIMEOUT"
  | "RESPONSE_FIELDS_TIMEOUT"
  | "RESPONSE_BODY_TIMEOUT"
  | "REQUEST_ABORTED"
  | "NETWORK_FAILURE"
  | "RESPONSE_DECOMPRESSION_FAILURE"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "REQUEST_BODY_TOO_LARGE"
  | "REQUEST_BODY_LENGTH_MISMATCH"
  | "REQUEST_BODY_SOURCE_FAILURE"
  | "REQUEST_FIELDS_TOO_LARGE"
  | "RESPONSE_FIELDS_TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_LOOP"
  | "REDIRECT_TARGET_REJECTED"
  | "WIRE_RESPONSE_TOO_LARGE"
  | "DECODED_RESPONSE_TOO_LARGE"
  | "PROTOCOL_MISMATCH"
  | "ORIGIN_CAPACITY_EXCEEDED"
  | "FILESYSTEM_FAILURE";

export interface HttpAttemptTransfer {
  readonly requestBodyBytesSent: number;
  readonly wireBytesReceived: number;
  readonly decodedBytesReceived: number;
  readonly trailers: HttpFields;
  readonly timings: ResponseTransferTimings;
}

export interface HttpAttemptResponseHead {
  readonly statusCode: number;
  readonly statusMessage: string | null;
  readonly fields: HttpFields;
  readonly connection: ConnectionFacts;
  readonly timings: ResponseHeadTimings;
}

type HttpAttemptResultBase = HttpAttemptContext;

export interface HttpCompletedAttempt extends HttpAttemptResultBase {
  readonly kind: "complete";
  readonly response: HttpAttemptResponseHead;
  readonly transfer: HttpAttemptTransfer;
}

export interface HttpCancelledAttempt extends HttpAttemptResultBase {
  readonly kind: "cancelled";
  readonly response: HttpAttemptResponseHead;
  readonly transfer: HttpAttemptTransfer;
}

export interface HttpRedirectAttempt extends HttpAttemptResultBase {
  readonly kind: "redirect";
  readonly response: HttpAttemptResponseHead;
  readonly transfer: HttpAttemptTransfer;
  readonly redirect: HttpRedirect;
}

export interface HttpFailedAttempt extends HttpAttemptResultBase {
  readonly kind: "failure";
  readonly response: HttpAttemptResponseHead | null;
  readonly transfer: HttpAttemptTransfer | null;
  readonly error: HttpClientError;
}

export interface HttpResponseFailedAttempt extends HttpAttemptResultBase {
  readonly kind: "failure";
  readonly response: HttpAttemptResponseHead;
  readonly transfer: HttpAttemptTransfer;
  readonly error: HttpClientError;
}

export type HttpAttemptResult =
  | HttpCompletedAttempt
  | HttpCancelledAttempt
  | HttpRedirectAttempt
  | HttpFailedAttempt;

export type HttpResponseCompletion =
  | HttpCompletedAttempt
  | HttpCancelledAttempt
  | HttpResponseFailedAttempt;

interface HttpResponseBase extends HttpAttemptContext {
  readonly kind: "response";
  readonly statusCode: number;
  readonly statusMessage: string | null;
  readonly finalUrl: string;
  readonly fields: HttpFields;
  readonly redirects: readonly HttpRedirect[];
  readonly previousAttempts: readonly HttpAttemptResult[];
  readonly connection: ConnectionFacts;
  readonly headTimings: ResponseHeadTimings;
}

export interface StreamingHttpResponse extends HttpResponseBase {
  readonly body: ReadableStream<Uint8Array>;
  readonly completion: Promise<HttpResponseCompletion>;
  readonly cancel: (reason?: Error) => void;
}

export interface BufferedHttpResponse extends HttpResponseBase {
  readonly body: ResponseBody;
  readonly attempts: readonly HttpAttemptResult[];
}

export interface HttpFailure {
  readonly kind: "failure";
  readonly requestId: number;
  readonly error: HttpClientError;
  readonly finalUrl: string;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
  readonly fields: HttpFields;
  readonly redirects: readonly HttpRedirect[];
  readonly attempts: readonly HttpAttemptResult[];
  readonly connection: ConnectionFacts | null;
}

export type StreamingHttpResult = StreamingHttpResponse | HttpFailure;
export type BufferedHttpResult = BufferedHttpResponse | HttpFailure;

export type HttpClientEvent =
  | {
      readonly kind: "attempt-started";
      readonly context: HttpAttemptContext;
      readonly fields: HttpFields;
    }
  | {
      readonly kind: "request-body-progress";
      readonly context: HttpAttemptContext;
      readonly sentBytes: number;
    }
  | {
      readonly kind: "response-started";
      readonly context: HttpAttemptContext;
      readonly response: HttpAttemptResponseHead;
    }
  | {
      readonly kind: "response-body-progress";
      readonly context: HttpAttemptContext;
      readonly wireBytesReceived: number;
      readonly decodedBytesReceived: number;
    }
  | {
      readonly kind: "attempt-completed";
      readonly attempt: HttpAttemptResult;
    };
