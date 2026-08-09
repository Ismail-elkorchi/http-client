import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { RESPONSE_BODY_BRAND } from "./body-brand.ts";
import { ensureStorageDirectory, openPrivateFile } from "./private-files.ts";
import type {
  FileResponseBody,
  MemoryResponseBody,
  ResponseBody,
} from "./types.ts";

export class BodyCollector extends Writable {
  public bytesRead = 0;
  private readonly chunks: Buffer[] = [];
  private readonly memoryThresholdBytes: number;
  private readonly directory: string;
  private fileHandle: fs.FileHandle | null = null;
  private filePath: string | null = null;

  public constructor(
    memoryThresholdBytes: number,
    spoolDirectory: string | null,
  ) {
    super();
    this.memoryThresholdBytes = memoryThresholdBytes;
    this.directory = spoolDirectory ?? os.tmpdir();
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
    let closeFailure: unknown = null;
    let removalFailure: unknown = null;
    try {
      await this.closeFile();
    } catch (caught) {
      closeFailure = caught;
    }
    if (this.filePath !== null) {
      try {
        await fs.rm(this.filePath, { force: true });
      } catch (caught) {
        removalFailure = caught;
      }
    }
    this.filePath = null;
    this.chunks.length = 0;
    if (closeFailure !== null || removalFailure !== null) {
      throw new AggregateError(
        [closeFailure, removalFailure].filter(
          (failure) => failure !== null,
        ),
        "Response body cleanup failed.",
      );
    }
  }

  public body(): ResponseBody {
    if (this.filePath !== null) {
      const body: FileResponseBody = {
        [RESPONSE_BODY_BRAND]: true,
        kind: "file",
        path: this.filePath,
        size: this.bytesRead,
        temporary: true,
      };
      return Object.freeze(body);
    }
    const bytes = Buffer.concat(this.chunks, this.bytesRead);
    const body: MemoryResponseBody = {
      [RESPONSE_BODY_BRAND]: true,
      kind: "memory",
      bytes,
      size: bytes.byteLength,
    };
    return Object.freeze(body);
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    this.bytesRead += chunk.byteLength;
    try {
      if (
        this.fileHandle === null &&
        this.bytesRead <= this.memoryThresholdBytes
      ) {
        this.chunks.push(Buffer.from(chunk));
        return;
      }
      const handle = await this.ensureFile();
      await writeAll(handle, chunk);
    } catch (caught) {
      throw new BodyStorageError("Response body storage failed.", caught);
    }
  }

  private async ensureFile(): Promise<fs.FileHandle> {
    if (this.fileHandle !== null) return this.fileHandle;
    await ensureStorageDirectory(this.directory);
    this.filePath = path.join(
      this.directory,
      `http-client-${process.pid}-${randomUUID()}.body`,
    );
    this.fileHandle = await openPrivateFile(this.filePath);
    for (const chunk of this.chunks) await writeAll(this.fileHandle, chunk);
    this.chunks.length = 0;
    return this.fileHandle;
  }

  private async closeFile(): Promise<void> {
    if (this.fileHandle === null) return;
    await this.fileHandle.close();
    this.fileHandle = null;
  }
}

async function writeAll(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Response body file write made no progress.");
    }
    offset += result.bytesWritten;
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
