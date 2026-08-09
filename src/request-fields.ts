import { HttpConfigurationError } from "./errors.ts";
import {
  mergeHttpFields,
  removeHttpFields,
} from "./fields.ts";
import type { HttpFields } from "./fields.ts";
import { parseContentLength } from "./content-length.ts";
import type { HttpMethod, HttpRequestBody } from "./types.ts";

const SENSITIVE_FIELDS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

const BODY_FIELDS = new Set([
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
]);

export interface RedirectedRequest {
  readonly method: HttpMethod;
  readonly fields: HttpFields;
  readonly body: HttpRequestBody | undefined;
}

export function applyContentLength(
  fields: HttpFields,
  bodyPresent: boolean,
  knownLength: number | null,
): HttpFields {
  const declaredValues = fields.all("content-length");
  if (declaredValues.length > 1) {
    throw new HttpConfigurationError(
      "A request cannot contain multiple content-length field lines.",
    );
  }
  const declared = declaredValues[0];
  if (fields.has("transfer-encoding")) {
    throw new HttpConfigurationError(
      "Request transfer-encoding is controlled by the HTTP transport.",
    );
  }
  if (!bodyPresent) {
    if (declared !== undefined && parseContentLength(declared) !== 0) {
      throw new HttpConfigurationError(
        "A request without a body cannot declare a non-zero content-length.",
      );
    }
    return fields;
  }
  if (knownLength === null) {
    if (declared !== undefined) {
      throw new HttpConfigurationError(
        "A request with an inferred length cannot declare content-length.",
      );
    }
    return fields;
  }
  if (declared !== undefined) {
    if (parseContentLength(declared) !== knownLength) {
      throw new HttpConfigurationError(
        "Request content-length does not match the request body.",
      );
    }
    return fields;
  }
  return mergeHttpFields(fields, [
    { name: "content-length", value: String(knownLength) },
  ]);
}

export function enforceRequestFieldsLimit(
  fields: HttpFields,
  maxBytes: number,
): void {
  let bytes = 2;
  for (const { name, value } of fields) {
    bytes += Buffer.byteLength(name) + 2 + Buffer.byteLength(value) + 2;
    if (bytes > maxBytes) {
      throw new RequestFieldsLimitError(maxBytes);
    }
  }
}

export class RequestFieldsLimitError extends Error {
  public override readonly name = "RequestFieldsLimitError";

  public constructor(limit: number) {
    super(`Request field lines exceeded ${String(limit)} bytes.`);
  }
}

export function requestAfterRedirect(
  fromUrl: string,
  toUrl: string,
  statusCode: number,
  request: RedirectedRequest,
): RedirectedRequest {
  const method = redirectedMethod(request.method, statusCode);
  const removed = new Set(["host"]);
  if (new URL(fromUrl).origin !== new URL(toUrl).origin) {
    for (const name of SENSITIVE_FIELDS) removed.add(name);
  }
  if (method !== request.method) {
    for (const name of BODY_FIELDS) removed.add(name);
  }
  return {
    method,
    fields: removeHttpFields(request.fields, removed),
    body: method === request.method ? request.body : undefined,
  };
}

function redirectedMethod(
  method: HttpMethod,
  statusCode: number,
): HttpMethod {
  if (statusCode === 303 && method !== "HEAD") return "GET";
  if ((statusCode === 301 || statusCode === 302) && method === "POST") {
    return "GET";
  }
  return method;
}
