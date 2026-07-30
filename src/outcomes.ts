import { errors as undiciErrors } from "undici";
import {
  ResponseHeadersTimeoutError,
  TotalTimeoutError,
} from "./deadlines.js";
import { HttpClientError } from "./errors.js";
import { RequestHeadersLimitError } from "./headers.js";
import {
  RequestBodyLengthError,
  RequestBodyLimitError,
  RequestBodySourceError,
} from "./request-body.js";
import {
  ResponseBodyProgressTimeoutError,
  ResponseByteLimitError,
  UnsupportedContentEncodingError,
} from "./response-stream.js";
import {
  NetworkSafetyError,
  OriginCapacityError,
  ProtocolMismatchError,
  TransportClosedError,
} from "./transport.js";
import type {
  ConnectionFacts,
  HttpErrorCode,
  HttpFailure,
  HttpRedirect,
  ResponseTransfer,
  StreamingHttpResponse,
} from "./types.js";

export function classifyError(
  caught: unknown,
  url: string,
  signal: AbortSignal,
  decoding: boolean,
): HttpClientError {
  if (caught instanceof NetworkSafetyError) {
    const code =
      !caught.resolution.decision.allowed &&
      caught.resolution.decision.rejectionKind === "dns"
        ? "DNS_ERROR"
        : "NETWORK_SAFETY_REJECTED";
    return clientError(code, caught.message, url, caught);
  }
  if (caught instanceof ProtocolMismatchError) {
    return clientError("PROTOCOL_MISMATCH", caught.message, url, caught);
  }
  if (caught instanceof OriginCapacityError) {
    return clientError(
      "ORIGIN_CAPACITY_EXCEEDED",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof TransportClosedError) {
    return clientError("NETWORK_FAILURE", caught.message, url, caught);
  }
  if (caught instanceof ResponseByteLimitError) {
    return clientError(
      caught.kind === "wire"
        ? "WIRE_RESPONSE_TOO_LARGE"
        : "DECODED_RESPONSE_TOO_LARGE",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof ResponseBodyProgressTimeoutError) {
    return clientError(
      "RESPONSE_BODY_TIMEOUT",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof UnsupportedContentEncodingError) {
    return clientError(
      "UNSUPPORTED_CONTENT_ENCODING",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof RequestBodyLimitError) {
    return clientError(
      "REQUEST_BODY_TOO_LARGE",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof RequestHeadersLimitError) {
    return clientError(
      "REQUEST_HEADERS_TOO_LARGE",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof RequestBodyLengthError) {
    return clientError(
      "REQUEST_BODY_LENGTH_MISMATCH",
      caught.message,
      url,
      caught,
    );
  }
  if (caught instanceof RequestBodySourceError) {
    return clientError(
      "REQUEST_BODY_SOURCE_FAILURE",
      caught.message,
      url,
      caught,
    );
  }
  if (signal.aborted) {
    if (signal.reason instanceof TotalTimeoutError) {
      return clientError(
        "TOTAL_TIMEOUT",
        "The total request deadline expired.",
        url,
        caught,
      );
    }
    if (signal.reason instanceof ResponseHeadersTimeoutError) {
      return clientError(
        "RESPONSE_HEADERS_TIMEOUT",
        signal.reason.message,
        url,
        caught,
      );
    }
    return clientError(
      "REQUEST_ABORTED",
      "The request was aborted.",
      url,
      caught,
    );
  }
  if (caught instanceof undiciErrors.ConnectTimeoutError) {
    return clientError(
      "CONNECT_TIMEOUT",
      "The connection timed out.",
      url,
      caught,
    );
  }
  if (caught instanceof undiciErrors.HeadersTimeoutError) {
    return clientError(
      "RESPONSE_HEADERS_TIMEOUT",
      "The response headers timed out.",
      url,
      caught,
    );
  }
  if (caught instanceof undiciErrors.HeadersOverflowError) {
    return clientError(
      "RESPONSE_HEADERS_TOO_LARGE",
      "Response header fields exceeded the configured limit.",
      url,
      caught,
    );
  }
  if (caught instanceof undiciErrors.BodyTimeoutError) {
    return clientError(
      "RESPONSE_BODY_TIMEOUT",
      "The response body made no progress.",
      url,
      caught,
    );
  }
  const code = systemErrorCode(caught);
  if (
    code?.startsWith("ERR_TLS_") === true ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return clientError("TLS_ERROR", "TLS negotiation failed.", url, caught);
  }
  return clientError(
    decoding ? "RESPONSE_DECOMPRESSION_FAILURE" : "NETWORK_FAILURE",
    decoding
      ? "Response body decoding failed."
      : "The HTTP request failed.",
    url,
    caught,
  );
}

export function clientError(
  code: HttpErrorCode,
  message: string,
  url: string,
  cause: unknown = null,
): HttpClientError {
  return new HttpClientError(code, message, url, cause);
}

export function failureResult(
  error: HttpClientError,
  url: string,
  statusCode: number | null = null,
  headers: Headers = new Headers(),
  connection: ConnectionFacts | null = null,
  transfer: ResponseTransfer | null = null,
  statusMessage: string | null = null,
): HttpFailure {
  return {
    kind: "failure",
    error,
    finalUrl: url,
    statusCode,
    statusMessage,
    headers,
    redirects: [],
    connection,
    transfer,
  };
}

export function failureFromResponse(
  response: StreamingHttpResponse,
  error: HttpClientError,
  transfer: ResponseTransfer,
): HttpFailure {
  return {
    kind: "failure",
    error,
    finalUrl: response.finalUrl,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    headers: response.headers,
    redirects: response.redirects,
    connection: response.connection,
    transfer,
  };
}

export function redirectFailure(
  code: "REDIRECT_LOOP" | "REDIRECT_TARGET_REJECTED" | "TOO_MANY_REDIRECTS",
  message: string,
  url: string,
  previous: StreamingHttpResponse,
  transfer: ResponseTransfer,
  redirects: readonly HttpRedirect[],
  cause: unknown = null,
): HttpFailure {
  return {
    ...failureFromResponse(
      previous,
      clientError(code, message, url, cause),
      transfer,
    ),
    finalUrl: url,
    redirects,
  };
}

function systemErrorCode(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value)
  ) {
    return null;
  }
  return typeof value.code === "string" ? value.code : null;
}
