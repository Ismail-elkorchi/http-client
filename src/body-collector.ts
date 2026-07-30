import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { ensurePrivateDirectory, openPrivateFile } from "./private-files.js";
import type { ResponseBody } from "./types.js";

export class BodyCollector extends Writable {
  public bytesRead = 0;
  private readonly chunks: Buffer[] = [];
  private readonly maxBytes: number;
  private readonly memoryThresholdBytes: number;
  private readonly directory: string;
  private fileHandle: fs.FileHandle | null = null;
  private filePath: string | null = null;

  public constructor(
    maxBytes: number,
    memoryThresholdBytes: number,
    spoolDirectory: string | null,
  ) {
    super();
    this.maxBytes = maxBytes;
    this.memoryThresholdBytes = memoryThresholdBytes;
    this.directory =
      spoolDirectory ?? path.join(os.tmpdir(), "http-client-bodies");
  }

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writeChunk(chunk).then(
      () => {
        callback();
      },
      (caught: unknown) => {
        callback(toError(caught, "Body write failed."));
      },
    );
  }

  public override _final(callback: (error?: Error | null) => void): void {
    this.closeFile().then(
      () => {
        callback();
      },
      (caught: unknown) => {
        callback(new BodyStorageError("Response body close failed.", caught));
      },
    );
  }

  public async discard(): Promise<void> {
    await this.closeFile();
    if (this.filePath !== null) await fs.rm(this.filePath, { force: true });
    this.filePath = null;
    this.chunks.length = 0;
  }

  public body(): ResponseBody {
    if (this.filePath !== null) {
      return {
        kind: "file",
        path: this.filePath,
        size: this.bytesRead,
        temporary: true,
      };
    }
    const bytes = Buffer.concat(this.chunks, this.bytesRead);
    return { kind: "memory", bytes, size: bytes.byteLength };
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    this.bytesRead += chunk.byteLength;
    if (this.bytesRead > this.maxBytes) {
      throw new BodyLimitError("decompressed", this.maxBytes);
    }
    try {
      if (
        this.fileHandle === null &&
        this.bytesRead <= this.memoryThresholdBytes
      ) {
        this.chunks.push(Buffer.from(chunk));
        return;
      }
      const handle = await this.ensureFile();
      await handle.write(chunk);
    } catch (caught) {
      if (caught instanceof BodyLimitError) throw caught;
      throw new BodyStorageError("Response body storage failed.", caught);
    }
  }

  private async ensureFile(): Promise<fs.FileHandle> {
    if (this.fileHandle !== null) return this.fileHandle;
    await ensurePrivateDirectory(this.directory);
    this.filePath = path.join(
      this.directory,
      `${process.pid}-${randomUUID()}.body`,
    );
    this.fileHandle = await openPrivateFile(this.filePath);
    for (const chunk of this.chunks) await this.fileHandle.write(chunk);
    this.chunks.length = 0;
    return this.fileHandle;
  }

  private async closeFile(): Promise<void> {
    if (this.fileHandle === null) return;
    await this.fileHandle.close();
    this.fileHandle = null;
  }
}

export class BodyLimitError extends Error {
  public override readonly name = "BodyLimitError";
  public readonly kind: "compressed" | "decompressed";

  public constructor(kind: "compressed" | "decompressed", limit: number) {
    super(`${kind} response body exceeded ${String(limit)} bytes.`);
    this.kind = kind;
  }
}

export class BodyStorageError extends Error {
  public override readonly name = "BodyStorageError";
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
