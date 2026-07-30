import type { HttpErrorCode } from "./types.js";

export class HttpConfigurationError extends TypeError {
  public override readonly name = "HttpConfigurationError";

  public constructor(message: string) {
    super(message);
  }
}

export class HttpClientError extends Error {
  public override readonly name = "HttpClientError";
  public readonly code: HttpErrorCode;
  public readonly url: string;
  public override readonly cause: unknown;

  public constructor(
    code: HttpErrorCode,
    message: string,
    url: string,
    cause: unknown = null,
  ) {
    super(message);
    this.code = code;
    this.url = url;
    this.cause = cause;
  }
}
