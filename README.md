# HTTP Client

A streaming HTTP/1.1 and HTTP/2 client for Node.js 24 or newer.

It provides bounded uploads and responses, redirects, content decoding,
address-pinned DNS resolution, explicit proxy and TLS configuration, temporary
file storage, cancellation, trailers, and connection facts.

## Install

```sh
npm install @ismail-elkorchi/http-client
```

## Stream a response

```ts
import { NodeHttpClient } from "@ismail-elkorchi/http-client";

const client = new NodeHttpClient();

try {
  const result = await client.fetch("https://example.com/");
  if (result.kind === "failure") {
    console.error(result.error.code, result.error.message);
  } else {
    const bytes = new Uint8Array(await new Response(result.body).arrayBuffer());
    const completion = await result.completion;

    if (completion.kind === "complete") {
      console.log(result.statusCode, bytes.byteLength);
      console.log(completion.transfer.wireBytesReceived);
    } else if (completion.kind === "failure") {
      console.error(completion.error.code, completion.error.message);
    }
  }
} finally {
  await client.close();
}
```

`request()` performs one exchange. `fetch()` follows redirects. Both return
after the response headers arrive and keep the total deadline active until the
body completes or is cancelled.

Every response body must be consumed or cancelled. `destroy()` cancels all
active responses when graceful shutdown is not appropriate.

## Buffer a response

```ts
import {
  NodeHttpClient,
  disposeResponseBody,
  readResponseBody,
} from "@ismail-elkorchi/http-client";

const client = new NodeHttpClient({
  responseStorage: {
    memoryThresholdBytes: 512 * 1024,
  },
});

try {
  const result = await client.fetchBuffered("https://example.com/");
  if (result.kind === "response") {
    try {
      const bytes = await readResponseBody(result.body);
      console.log(bytes.byteLength);
    } finally {
      await disposeResponseBody(result.body);
    }
  }
} finally {
  await client.close();
}
```

Responses larger than `memoryThresholdBytes` are stored in private temporary
files. Wire and decoded byte limits apply before storage.

## Send a request body

Request bodies are discriminated and replayable across redirects:

```ts
await client.fetch("https://example.com/upload", {
  method: "POST",
  body: {
    kind: "stream",
    contentLength: 3,
    create: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
  },
});
```

The other body kinds are `text`, `bytes`, and `multipart`.

## Network boundaries

Public addresses are permitted by default. Local, private, reserved,
documentation, and mixed public/non-public DNS answers are rejected.

```ts
const localClient = new NodeHttpClient({
  networkSafety: { allowLocalhost: true },
});
```

An HTTP proxy resolves and connects to the target on behalf of the client, so
target address pinning cannot be guaranteed. Proxy configuration therefore
requires `networkSafety.enabled` to be `false`.

```ts
const proxyClient = new NodeHttpClient({
  networkSafety: { enabled: false },
  proxy: { url: "http://proxy.example:8080/" },
});
```

Retry policy, cookies, caches, rate limits, and application sessions belong in
consumer adapters.

## Development

```sh
npm ci
npm run check
npm test
```
