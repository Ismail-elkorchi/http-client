import {
  NodeHttpClient,
  type BufferedHttpResult,
  type HttpRequestBody,
  type StreamingHttpResult,
} from "../../dist/index.js";

const upload: HttpRequestBody = {
  kind: "stream",
  contentLength: 3,
  create: () =>
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
};

async function streaming(client: NodeHttpClient): Promise<void> {
  const result: StreamingHttpResult = await client.fetch(
    "https://example.com/",
    {
      method: "POST",
      body: upload,
      responseContentDecoding: "preserve",
    },
  );
  if (result.kind === "failure") {
    const code: string = result.error.code;
    void code;
    return;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    result.body.getReader();
  await reader.cancel();
  const completion = await result.completion;
  if (completion.kind === "failure") {
    const code: string = completion.error.code;
    void code;
  }
}

async function buffered(client: NodeHttpClient): Promise<void> {
  const result: BufferedHttpResult = await client.requestBuffered(
    "https://example.com/",
  );
  if (result.kind === "response") {
    const size: number = result.body.size;
    const received: number = result.transfer.decodedBytesReceived;
    void size;
    void received;
  }
}

void streaming;
void buffered;
