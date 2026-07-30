import type { Dispatcher } from "undici";
import type { HttpMethod } from "./types.js";

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
  readonly body: string | Uint8Array | undefined;
}

export function mergeRequestHeaders(
  ...sources: readonly (Readonly<Record<string, string>> | undefined)[]
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [rawName, value] of Object.entries(source)) {
      const name = normalizeHeaderName(rawName);
      validateHeaderValue(value);
      merged[name] = value;
    }
  }
  return merged;
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

export function incomingHeaders(
  source: Dispatcher.ResponseData["headers"],
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

export function headersRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(headers.entries());
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
    throw new TypeError(`Invalid HTTP header name: ${rawName}`);
  }
  return name;
}

function validateHeaderValue(value: string): void {
  if (/[\0\r\n]/u.test(value)) {
    throw new TypeError("HTTP header values cannot contain NUL, CR, or LF.");
  }
}
