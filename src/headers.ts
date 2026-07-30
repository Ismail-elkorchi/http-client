import { HttpConfigurationError } from "./errors.js";
import { parseContentLength } from "./content-length.js";
import type { HttpMethod, HttpRequestBody } from "./types.js";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

const BODY_HEADERS = new Set([
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
]);

export interface RedirectedRequest {
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: HttpRequestBody | undefined;
}

export function mergeRequestHeaders(
  ...sources: readonly (Readonly<Record<string, string>> | undefined)[]
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (source === undefined) continue;
    if (!isStringRecord(source)) {
      throw new HttpConfigurationError(
        "Request headers must be an object containing string values.",
      );
    }
    for (const [rawName, value] of Object.entries(source)) {
      const name = normalizeHeaderName(rawName);
      validateHeaderValue(value);
      merged[name] = value;
    }
  }
  return merged;
}

export function applyContentLength(
  headers: Readonly<Record<string, string>>,
  bodyPresent: boolean,
  knownLength: number | null,
): Readonly<Record<string, string>> {
  const declared = headers["content-length"];
  if (headers["transfer-encoding"] !== undefined) {
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
    return headers;
  }
  if (knownLength === null) {
    if (declared !== undefined) {
      throw new HttpConfigurationError(
        "A request with an inferred length cannot declare content-length.",
      );
    }
    return headers;
  }
  if (declared !== undefined) {
    if (parseContentLength(declared) !== knownLength) {
      throw new HttpConfigurationError(
        "Request content-length does not match the request body.",
      );
    }
    return headers;
  }
  return { ...headers, "content-length": String(knownLength) };
}

export function enforceRequestHeadersLimit(
  headers: Readonly<Record<string, string>>,
  maxBytes: number,
): void {
  let bytes = 2;
  for (const [name, value] of Object.entries(headers)) {
    bytes += Buffer.byteLength(name) + 2 + Buffer.byteLength(value) + 2;
    if (bytes > maxBytes) {
      throw new RequestHeadersLimitError(maxBytes);
    }
  }
}

export class RequestHeadersLimitError extends Error {
  public override readonly name = "RequestHeadersLimitError";

  public constructor(limit: number) {
    super(`Request header fields exceeded ${String(limit)} bytes.`);
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
    for (const name of SENSITIVE_HEADERS) removed.add(name);
  }
  if (method !== request.method) {
    for (const name of BODY_HEADERS) removed.add(name);
  }
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !removed.has(name)),
  );
  return {
    method,
    headers,
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

function normalizeHeaderName(rawName: string): string {
  const name = rawName.toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(name)) {
    throw new HttpConfigurationError(
      `Invalid HTTP header name: ${rawName}`,
    );
  }
  return name;
}

function validateHeaderValue(value: string): void {
  if (/[\0\r\n]/u.test(value)) {
    throw new HttpConfigurationError(
      "HTTP header values cannot contain NUL, CR, or LF.",
    );
  }
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}
