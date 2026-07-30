import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readBody, type BodyReadResult } from "./body-reader.js";
import type { ResponseBody, ResponseLimits } from "./types.js";

export async function decodeResponseBody(
  body: ResponseBody,
  contentEncoding: string | readonly string[],
  limits: ResponseLimits,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  const source =
    body.kind === "memory"
      ? Readable.from([body.bytes])
      : createReadStream(body.path);
  return await readBody(source, contentEncoding, limits, signal);
}

export type { BodyReadResult as ResponseBodyDecodeResult };
