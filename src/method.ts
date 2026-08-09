import { HttpConfigurationError } from "./errors.ts";
import type { ExtensionHttpMethod, HttpMethod } from "./types.ts";

const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/u;
const STANDARD_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

export function defineHttpMethod(value: string): ExtensionHttpMethod;
export function defineHttpMethod(value: string): string {
  validateHttpMethod(value);
  if (value === "CONNECT") {
    throw new HttpConfigurationError(
      "CONNECT requires a tunnel API and cannot be used as a request method.",
    );
  }
  if (STANDARD_METHODS.has(value)) {
    throw new HttpConfigurationError(
      `${value} is already a standard request method.`,
    );
  }
  return value;
}

export function validateHttpMethod(value: unknown): asserts value is HttpMethod {
  if (typeof value !== "string" || !METHOD_TOKEN.test(value)) {
    throw new HttpConfigurationError(
      "method must be an uppercase HTTP token.",
    );
  }
}
