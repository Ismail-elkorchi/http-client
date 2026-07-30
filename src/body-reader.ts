import {
  Transform,
  type Readable,
  type TransformCallback,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  BodyCollector,
  BodyLimitError,
  BodyStorageError,
} from "./body-collector.js";
import type { HttpErrorCode, ResponseBody, ResponseLimits } from "./types.js";

export type BodyReadResult =
  | {
      readonly ok: true;
      readonly body: ResponseBody;
      readonly wireBytesRead: number;
      readonly decodedBytesRead: number;
    }
  | {
      readonly ok: false;
      readonly code: HttpErrorCode;
      readonly message: string;
      readonly cause: unknown;
      readonly wireBytesRead: number;
      readonly decodedBytesRead: number;
    };

export async function readBody(
  source: Readable,
  contentEncoding: string | readonly string[] | undefined,
  limits: ResponseLimits,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  const wire = new WireLimitTransform(limits.maxCompressedBytes);
  const collector = new BodyCollector(
    limits.maxDecompressedBytes,
    limits.memoryThresholdBytes,
    limits.spoolDirectory,
  );
  let decoders: readonly Transform[];
  try {
    decoders = decodersFor(contentEncoding);
  } catch (caught) {
    source.on("error", ignoreError);
    source.destroy();
    return failure(
      "UNSUPPORTED_CONTENT_ENCODING",
      "Unsupported HTTP content encoding",
      caught,
      0,
      0,
    );
  }

  try {
    await pipeline(source, wire, ...decoders, collector, { signal });
    return {
      ok: true,
      body: collector.body(),
      wireBytesRead: wire.bytesRead,
      decodedBytesRead: collector.bytesRead,
    };
  } catch (caught) {
    try {
      await collector.discard();
    } catch (discardFailure) {
      return failure(
        "FILESYSTEM_ERROR",
        "Response body cleanup failed",
        discardFailure,
        wire.bytesRead,
        collector.bytesRead,
      );
    }
    if (caught instanceof BodyLimitError) {
      return failure(
        caught.kind === "compressed"
          ? "RESPONSE_TOO_LARGE"
          : "DECOMPRESSED_RESPONSE_TOO_LARGE",
        caught.message,
        caught,
        wire.bytesRead,
        collector.bytesRead,
      );
    }
    if (signal.aborted) {
      return failure(
        "FETCH_ABORTED",
        "Response body reading was aborted",
        caught,
        wire.bytesRead,
        collector.bytesRead,
      );
    }
    if (caught instanceof BodyStorageError) {
      return failure(
        "FILESYSTEM_ERROR",
        caught.message,
        caught.cause,
        wire.bytesRead,
        collector.bytesRead,
      );
    }
    return failure(
      decoders.length === 0
        ? "FETCH_NETWORK_ERROR"
        : "FETCH_DECOMPRESSION_ERROR",
      decoders.length === 0
        ? "Response body reading failed"
        : "Response body decoding failed",
      caught,
      wire.bytesRead,
      collector.bytesRead,
    );
  }
}

class WireLimitTransform extends Transform {
  public bytesRead = 0;
  private readonly limit: number;

  public constructor(limit: number) {
    super();
    this.limit = limit;
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytesRead += chunk.byteLength;
    if (this.bytesRead > this.limit) {
      callback(new BodyLimitError("compressed", this.limit));
      return;
    }
    callback(null, chunk);
  }
}

function decodersFor(
  rawEncoding: string | readonly string[] | undefined,
): readonly Transform[] {
  const encodings = normalizeEncodings(rawEncoding);
  if (encodings.length > 5) {
    throw new Error("Response has more than five content-encoding layers.");
  }
  return [...encodings].reverse().map(createDecoder);
}

function normalizeEncodings(
  rawEncoding: string | readonly string[] | undefined,
): readonly string[] {
  const raw =
    typeof rawEncoding === "string"
      ? rawEncoding
      : (rawEncoding?.join(",") ?? "identity");
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "" && value !== "identity");
}

function createDecoder(encoding: string): Transform {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Error(`Unsupported content encoding: ${encoding}`);
  }
}

function failure(
  code: HttpErrorCode,
  message: string,
  cause: unknown,
  wireBytesRead: number,
  decodedBytesRead: number,
): BodyReadResult {
  return {
    ok: false,
    code,
    message,
    cause,
    wireBytesRead,
    decodedBytesRead,
  };
}

function ignoreError(): undefined {
  return undefined;
}
