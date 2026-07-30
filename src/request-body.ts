import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { HttpConfigurationError } from "./errors.js";
import type {
  HttpRequestBody,
  MultipartFileContent,
  MultipartPart,
  RequestByteStream,
} from "./types.js";

export type TransportRequestBody =
  | string
  | Uint8Array
  | Readable;

export interface PreparedRequestBody {
  readonly create: () => TransportRequestBody | undefined;
  readonly contentLength: number | null;
  readonly contentType: string | null;
}

export function prepareRequestBody(
  body: HttpRequestBody | undefined,
  maxBytes: number,
): PreparedRequestBody {
  if (body === undefined) {
    return {
      create: noRequestBody,
      contentLength: 0,
      contentType: null,
    };
  }
  switch (body.kind) {
    case "bytes": {
      if (!(body.bytes instanceof Uint8Array)) {
        throw new HttpConfigurationError(
          "A bytes request body requires a Uint8Array.",
        );
      }
      enforceKnownLength(body.bytes.byteLength, maxBytes);
      return {
        create: () => body.bytes,
        contentLength: body.bytes.byteLength,
        contentType: null,
      };
    }
    case "text": {
      if (typeof body.text !== "string") {
        throw new HttpConfigurationError(
          "A text request body requires a string.",
        );
      }
      const length = Buffer.byteLength(body.text);
      enforceKnownLength(length, maxBytes);
      return {
        create: () => body.text,
        contentLength: length,
        contentType: null,
      };
    }
    case "multipart": {
      return prepareMultipartBody(body.parts, maxBytes);
    }
    case "stream": {
      if (typeof body.create !== "function") {
        throw new HttpConfigurationError(
          "A stream request body requires a create function.",
        );
      }
      validateOptionalLength(body.contentLength);
      if (
        body.contentLength !== undefined &&
        body.contentLength > maxBytes
      ) {
        throw new RequestBodyLimitError(maxBytes);
      }
      return {
        create: () =>
          createStreamBodyFromFactory(
            body.create,
            maxBytes,
            body.contentLength ?? null,
          ),
        contentLength: body.contentLength ?? null,
        contentType: null,
      };
    }
  }
}

function prepareMultipartBody(
  parts: readonly MultipartPart[],
  maxBytes: number,
): PreparedRequestBody {
  const candidate: unknown = parts;
  if (!isMultipartParts(candidate)) {
    throw new HttpConfigurationError(
      "A multipart request body contains an invalid part.",
    );
  }
  const boundary = `http-client-${randomUUID()}`;
  const segments: MultipartSegment[] = [];
  let contentLength = 0;
  const append = (segment: MultipartSegment): void => {
    contentLength += segmentLength(segment);
    enforceKnownLength(contentLength, maxBytes);
    segments.push(segment);
  };
  for (const part of candidate) {
    const disposition =
      `Content-Disposition: form-data; name="${quotedParameter(part.name)}"`;
    append(byteSegment(textBytes(`--${boundary}\r\n`)));
    if (part.kind === "text") {
      append(byteSegment(textBytes(`${disposition}\r\n\r\n`)));
      append(byteSegment(textBytes(part.value)));
      append(byteSegment(textBytes("\r\n")));
      continue;
    }
    append(
      byteSegment(
        textBytes(
          `${disposition}; filename="${quotedParameter(part.fileName)}"\r\n` +
            `Content-Type: ${part.mediaType ?? "application/octet-stream"}\r\n\r\n`,
        ),
      ),
    );
    append(fileContentSegment(part.content));
    append(byteSegment(textBytes("\r\n")));
  }
  append(byteSegment(textBytes(`--${boundary}--\r\n`)));
  return {
    create: () => Readable.from(iterateMultipartSegments(segments)),
    contentLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

type MultipartSegment =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "stream";
      readonly contentLength: number;
      readonly create: () => RequestByteStream;
    };

function byteSegment(bytes: Uint8Array): MultipartSegment {
  return { kind: "bytes", bytes };
}

function fileContentSegment(content: MultipartFileContent): MultipartSegment {
  return content.kind === "bytes"
    ? { kind: "bytes", bytes: content.bytes }
    : {
        kind: "stream",
        contentLength: content.contentLength,
        create: content.create,
      };
}

function segmentLength(segment: MultipartSegment): number {
  return segment.kind === "bytes"
    ? segment.bytes.byteLength
    : segment.contentLength;
}

async function* iterateMultipartSegments(
  segments: readonly MultipartSegment[],
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const segment of segments) {
    if (segment.kind === "bytes") {
      yield segment.bytes;
      continue;
    }
    yield* iterateLimitedBytesFromFactory(
      segment.create,
      segment.contentLength,
      segment.contentLength,
    );
  }
}

function isMultipartParts(value: unknown): value is readonly MultipartPart[] {
  return Array.isArray(value) && value.every(isMultipartPart);
}

function isMultipartPart(value: unknown): value is MultipartPart {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !validMultipartName(value.name)
  ) {
    return false;
  }
  if (value.kind === "text") {
    return (
      hasOnlyKeys(value, ["kind", "name", "value"]) &&
      "value" in value &&
      typeof value.value === "string"
    );
  }
  return (
    value.kind === "file" &&
    hasOnlyKeys(value, ["kind", "name", "fileName", "mediaType", "content"]) &&
    "fileName" in value &&
    typeof value.fileName === "string" &&
    validMultipartName(value.fileName) &&
    "content" in value &&
    isMultipartFileContent(value.content) &&
    (!("mediaType" in value) ||
      value.mediaType === undefined ||
      (typeof value.mediaType === "string" &&
        /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(
          value.mediaType,
        )))
  );
}

function isMultipartFileContent(value: unknown): value is MultipartFileContent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value)
  ) {
    return false;
  }
  if (value.kind === "bytes") {
    return (
      hasOnlyKeys(value, ["kind", "bytes"]) &&
      "bytes" in value &&
      value.bytes instanceof Uint8Array
    );
  }
  return (
    value.kind === "stream" &&
    hasOnlyKeys(value, ["kind", "contentLength", "create"]) &&
    "contentLength" in value &&
    Number.isSafeInteger(value.contentLength) &&
    typeof value.contentLength === "number" &&
    value.contentLength >= 0 &&
    "create" in value &&
    typeof value.create === "function"
  );
}

function validMultipartName(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export class RequestBodyLimitError extends Error {
  public override readonly name = "RequestBodyLimitError";

  public constructor(limit: number) {
    super(`Request body exceeded ${String(limit)} bytes.`);
  }
}

export class RequestBodyLengthError extends Error {
  public override readonly name = "RequestBodyLengthError";

  public constructor(expected: number, observed: number) {
    super(
      `Request body declared ${String(expected)} bytes but produced ${String(observed)} bytes.`,
    );
  }
}

export class RequestBodySourceError extends Error {
  public override readonly name = "RequestBodySourceError";
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown = null) {
    super(message);
    this.cause = cause;
  }
}

function createStreamBodyFromFactory(
  factory: () => RequestByteStream,
  limit: number,
  expectedLength: number | null,
): Readable {
  let source: RequestByteStream;
  try {
    source = factory();
  } catch (caught) {
    throw new RequestBodySourceError(
      "The request body create function failed.",
      caught,
    );
  }
  if (!isRequestByteStream(source)) {
    throw new RequestBodySourceError(
      "A request body create function must return a ReadableStream or AsyncIterable.",
    );
  }
  return Readable.from(iterateLimitedBytes(source, limit, expectedLength));
}

async function* iterateLimitedBytesFromFactory(
  factory: () => RequestByteStream,
  limit: number,
  expectedLength: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  let source: RequestByteStream;
  try {
    source = factory();
  } catch (caught) {
    throw new RequestBodySourceError(
      "A multipart file create function failed.",
      caught,
    );
  }
  if (!isRequestByteStream(source)) {
    throw new RequestBodySourceError(
      "A multipart file create function must return a ReadableStream or AsyncIterable.",
    );
  }
  yield* iterateLimitedBytes(source, limit, expectedLength);
}

async function* iterateLimitedBytes(
  source: RequestByteStream,
  limit: number,
  expectedLength: number | null,
): AsyncGenerator<Uint8Array, void, undefined> {
  let bytesRead = 0;
  const account = (chunk: Uint8Array): Uint8Array => {
    bytesRead += chunk.byteLength;
    if (bytesRead > limit) throw new RequestBodyLimitError(limit);
    if (expectedLength !== null && bytesRead > expectedLength) {
      throw new RequestBodyLengthError(expectedLength, bytesRead);
    }
    return chunk;
  };
  if (isWebReadableStream(source)) {
    const reader = source.getReader();
    let completed = false;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new RequestBodySourceError(
            "A request body stream produced a non-byte chunk.",
          );
        }
        yield account(result.value);
      }
    } finally {
      if (!completed) await reader.cancel();
      reader.releaseLock();
    }
  } else {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new RequestBodySourceError(
          "A request body iterable produced a non-byte chunk.",
        );
      }
      yield account(chunk);
    }
  }
  if (expectedLength !== null && bytesRead !== expectedLength) {
    throw new RequestBodyLengthError(expectedLength, bytesRead);
  }
}

function isRequestByteStream(value: unknown): value is RequestByteStream {
  return isWebReadableStream(value) || isAsyncByteIterable(value);
}

function isWebReadableStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

function isAsyncByteIterable(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function enforceKnownLength(length: number, limit: number): void {
  if (length > limit) throw new RequestBodyLimitError(limit);
}

function validateOptionalLength(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new HttpConfigurationError(
      "A request body contentLength must be a non-negative safe integer.",
    );
  }
}

function quotedParameter(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function noRequestBody(): undefined {
  return undefined;
}
