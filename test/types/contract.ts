import {
  collectResponseBody,
  defineHttpMethod,
  HttpFields,
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
    const finalAttempt = result.attempts.at(-1);
    const received: number =
      finalAttempt?.transfer?.decodedBytesReceived ?? 0;
    void size;
    void received;
  }
}

const fields = new HttpFields([
  { name: "set-cookie", value: "first=1" },
  { name: "set-cookie", value: "second=2" },
]);
const cookies: readonly string[] = fields.all("set-cookie");
void cookies;

const collected = collectResponseBody(
  new ReadableStream<Uint8Array>(),
  {
    maxBytes: 1024,
    storage: {
      memoryThresholdBytes: 512,
      spoolDirectory: null,
    },
  },
);
void collected;

const extensionMethod = defineHttpMethod("PROPFIND");
void new NodeHttpClient({
  timeouts: { totalMs: null, responseBodyProgressMs: null },
}).request(
  "https://example.com/",
  {
    method: extensionMethod,
    body: { kind: "text", text: "query" },
  },
);

void new NodeHttpClient().request("https://example.com/", {
  session: {
    prepareRequest() {
      return [{ name: "authorization", value: "Bearer token" }];
    },
    acceptResponse() {},
  },
});

void new NodeHttpClient().request("https://example.com/", {
  // @ts-expect-error Extension methods must pass through defineHttpMethod.
  method: "PROPFIND",
});

void new NodeHttpClient().request("https://example.com/", {
  method: "GET",
  // @ts-expect-error GET is a bodyless request state.
  body: { kind: "text", text: "invalid" },
});

void streaming;
void buffered;
