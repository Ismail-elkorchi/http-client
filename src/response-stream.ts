import {
  Transform,
  type Readable,
  type TransformCallback,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from "node:zlib";
import type { HttpClientError } from "./errors.js";
import { emitHttpClientEvent } from "./observer.js";
import type {
  HttpAttemptContext,
  HttpAttemptResponseHead,
  HttpAttemptTransfer,
  HttpClientObserver,
  HttpResponseCompletion,
  ResponseTransferLimits,
} from "./types.js";

export interface StreamingBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly completion: Promise<HttpResponseCompletion>;
  readonly cancel: (reason?: Error) => void;
}

export interface StreamingBodyOptions {
  readonly source: Readable;
  readonly contentEncoding: string | readonly string[] | undefined;
  readonly limits: ResponseTransferLimits;
  readonly responseBodyProgressTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly attemptStartedAt: number;
  readonly context: HttpAttemptContext;
  readonly response: HttpAttemptResponseHead;
  readonly observer: HttpClientObserver | undefined;
  readonly onCompletion: (attempt: HttpResponseCompletion) => void;
  readonly requestBodyBytesSent: () => number;
  readonly trailers: () => import("./fields.js").HttpFields;
  readonly classifyFailure: (
    caught: unknown,
    decoding: boolean,
  ) => HttpClientError;
}

export function createStreamingBody(
  options: StreamingBodyOptions,
): StreamingBody {
  const encodings = normalizeEncodings(options.contentEncoding);
  if (encodings.length > options.limits.maxContentEncodingLayers) {
    throw new UnsupportedContentEncodingError(
      `Response has more than ${String(options.limits.maxContentEncodingLayers)} content-encoding layers.`,
    );
  }
  const decoders = encodings.toReversed().map(createDecoder);
  let progressTimer: ReturnType<typeof setTimeout>;
  const stopProgressTimer = (): void => {
    clearTimeout(progressTimer);
  };
  const requireProgress = (): void => {
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      options.source.destroy(
        new ResponseBodyProgressTimeoutError(
          options.responseBodyProgressTimeoutMs,
        ),
      );
    }, options.responseBodyProgressTimeoutMs);
  };
  const reportProgress = (): void => {
    emitHttpClientEvent(options.observer, {
      kind: "response-body-progress",
      context: options.context,
      wireBytesReceived: wireCounter.bytesRead,
      decodedBytesReceived: decodedCounter.bytesRead,
    });
  };
  const wireCounter = new ResponseByteLimitTransform(
    "wire",
    options.limits.maxWireBytes,
    () => {
      requireProgress();
      reportProgress();
    },
  );
  const decodedCounter = new ResponseByteLimitTransform(
    "decoded",
    options.limits.maxDecodedBytes,
    reportProgress,
  );
  const bodyStartedAt = performance.now();
  let cancellationRequested = false;
  let cancellationReason: Error | undefined;
  const nodeBody = decodedCounter;
  const pipelinePromise = pipeline(
    options.source,
    wireCounter,
    ...decoders,
    decodedCounter,
    { signal: options.signal },
  );
  requireProgress();
  void pipelinePromise.then(stopProgressTimer, stopProgressTimer);
  const sourceIterator: AsyncIterator<unknown> =
    nodeBody[Symbol.asyncIterator]();

  const cancel = (reason?: Error): void => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    cancellationReason = reason;
    options.source.destroy(reason);
    nodeBody.destroy(reason);
    void sourceIterator.return?.().catch(ignoreFailure);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const result = await sourceIterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(toBytes(result.value));
      } catch (caught) {
        controller.error(options.classifyFailure(caught, decoders.length > 0));
      }
    },
    async cancel(reason): Promise<void> {
      cancel(reason instanceof Error ? reason : undefined);
      await pipelinePromise.catch(ignoreFailure);
    },
  });

  const completion = completePipeline(
    pipelinePromise,
    options,
    wireCounter,
    decodedCounter,
    bodyStartedAt,
    decoders.length > 0,
    () => cancellationRequested,
    () => cancellationReason,
  );
  return { body, completion, cancel };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new TypeError("Response stream produced a non-byte chunk.");
}

export class ResponseByteLimitError extends Error {
  public override readonly name = "ResponseByteLimitError";
  public readonly kind: "wire" | "decoded";

  public constructor(kind: "wire" | "decoded", limit: number) {
    super(
      `${kind === "wire" ? "Wire" : "Decoded"} response body exceeded ${String(limit)} bytes.`,
    );
    this.kind = kind;
  }
}

export class UnsupportedContentEncodingError extends Error {
  public override readonly name = "UnsupportedContentEncodingError";
}

export class ResponseBodyProgressTimeoutError extends Error {
  public override readonly name = "ResponseBodyProgressTimeoutError";

  public constructor(timeoutMs: number) {
    super(
      `Response body made no progress for ${String(timeoutMs)}ms.`,
    );
  }
}

class ResponseByteLimitTransform extends Transform {
  public bytesRead = 0;
  private readonly kind: "wire" | "decoded";
  private readonly limit: number;
  private readonly observeProgress: () => void;

  public constructor(
    kind: "wire" | "decoded",
    limit: number,
    observeProgress: () => void = ignoreProgress,
  ) {
    super();
    this.kind = kind;
    this.limit = limit;
    this.observeProgress = observeProgress;
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytesRead += chunk.byteLength;
    this.observeProgress();
    if (this.bytesRead > this.limit) {
      callback(new ResponseByteLimitError(this.kind, this.limit));
      return;
    }
    callback(null, chunk);
  }
}

async function completePipeline(
  operation: Promise<void>,
  options: StreamingBodyOptions,
  wireCounter: ResponseByteLimitTransform,
  decodedCounter: ResponseByteLimitTransform,
  bodyStartedAt: number,
  decoding: boolean,
  cancellationRequested: () => boolean,
  cancellationReason: () => Error | undefined,
): Promise<HttpResponseCompletion> {
  try {
    await operation;
    const attempt = {
      kind: "complete",
      ...options.context,
      response: options.response,
      transfer: transfer(
        options,
        wireCounter,
        decodedCounter,
        bodyStartedAt,
      ),
    } as const;
    options.onCompletion(attempt);
    return attempt;
  } catch (caught) {
    const observedTransfer = transfer(
      options,
      wireCounter,
      decodedCounter,
      bodyStartedAt,
    );
    if (cancellationRequested()) {
      const attempt = {
        kind: "cancelled",
        ...options.context,
        response: options.response,
        transfer: observedTransfer,
      } as const;
      options.onCompletion(attempt);
      return attempt;
    }
    const attempt = {
      kind: "failure",
      ...options.context,
      response: options.response,
      error: options.classifyFailure(
        cancellationReason() ?? caught,
        decoding,
      ),
      transfer: observedTransfer,
    } as const;
    options.onCompletion(attempt);
    return attempt;
  }
}

function transfer(
  options: StreamingBodyOptions,
  wireCounter: ResponseByteLimitTransform,
  decodedCounter: ResponseByteLimitTransform,
  bodyStartedAt: number,
): HttpAttemptTransfer {
  const completedAt = performance.now();
  return {
    requestBodyBytesSent: options.requestBodyBytesSent(),
    wireBytesReceived: wireCounter.bytesRead,
    decodedBytesReceived: decodedCounter.bytesRead,
    trailers: options.trailers(),
    timings: {
      ...options.response.timings,
      responseBodyMs: completedAt - bodyStartedAt,
      totalMs: completedAt - options.attemptStartedAt,
    },
  };
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
    case "zstd":
      return createZstdDecompress();
    default:
      throw new UnsupportedContentEncodingError(
        `Unsupported content encoding: ${encoding}`,
      );
  }
}

function ignoreFailure(): undefined {
  return undefined;
}

function ignoreProgress(): void {}
