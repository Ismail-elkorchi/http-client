import { errors as undiciErrors } from "undici";
import {
  ResponseFieldsTimeoutError,
  TotalTimeoutError,
} from "./deadlines.ts";
import { HttpClientError } from "./errors.ts";
import { HttpFields } from "./fields.ts";
import { RequestFieldsLimitError } from "./request-fields.ts";
import {
  RequestBodyLengthError,
  RequestBodyLimitError,
  RequestBodySourceError,
} from "./request-body.ts";
import {
  ResponseBodyProgressTimeoutError,
  ResponseByteLimitError,
  UnsupportedContentEncodingError,
} from "./response-stream.ts";
import {
  NetworkSafetyError,
  OriginCapacityError,
  ProtocolMismatchError,
  TransportClosedError,
} from "./transport.ts";
import type {
  HttpAttemptContext,
  HttpAttemptResponseHead,
  HttpAttemptResult,
  HttpAttemptTransfer,
  HttpErrorCode,
  HttpFailedAttempt,
  HttpFailure,
  HttpRedirect,
  StreamingHttpResponse,
} from "./types.ts";

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
  if (caught instanceof RequestFieldsLimitError) {
    return clientError(
      "REQUEST_FIELDS_TOO_LARGE",
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
    if (signal.reason instanceof ResponseFieldsTimeoutError) {
      return clientError(
        "RESPONSE_FIELDS_TIMEOUT",
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
      "RESPONSE_FIELDS_TIMEOUT",
      "The response field section timed out.",
      url,
      caught,
    );
  }
  if (caught instanceof undiciErrors.HeadersOverflowError) {
    return clientError(
      "RESPONSE_FIELDS_TOO_LARGE",
      "Response field lines exceeded the configured limit.",
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

export function failedAttempt(
  context: HttpAttemptContext,
  error: HttpClientError,
  response: HttpAttemptResponseHead | null = null,
  transfer: HttpAttemptTransfer | null = null,
): HttpFailedAttempt {
  return {
    kind: "failure",
    ...context,
    response,
    transfer,
    error,
  };
}

export function failureResult(
  context: HttpAttemptContext,
  error: HttpClientError,
  previousAttempts: readonly HttpAttemptResult[] = [],
  redirects: readonly HttpRedirect[] = [],
  response: HttpAttemptResponseHead | null = null,
  transfer: HttpAttemptTransfer | null = null,
): HttpFailure {
  const attempt = failedAttempt(context, error, response, transfer);
  return {
    kind: "failure",
    requestId: context.requestId,
    error,
    finalUrl: context.url,
    statusCode: response?.statusCode ?? null,
    statusMessage: response?.statusMessage ?? null,
    fields: response?.fields ?? new HttpFields(),
    redirects,
    attempts: [...previousAttempts, attempt],
    connection: response?.connection ?? null,
  };
}

export function failureFromResponse(
  response: StreamingHttpResponse,
  error: HttpClientError,
  transfer: HttpAttemptTransfer,
): HttpFailure {
  const responseHead: HttpAttemptResponseHead = {
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    fields: response.fields,
    connection: response.connection,
    timings: response.headTimings,
  };
  return failureResult(
    response,
    error,
    response.previousAttempts,
    response.redirects,
    responseHead,
    transfer,
  );
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
