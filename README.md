# HTTP Client

A streaming HTTP/1.1 and HTTP/2 client for Node.js 24 or newer.

It provides bounded uploads and responses, redirects, content decoding,
lossless HTTP field lines, address-pinned DNS resolution, explicit proxy and
TLS configuration, temporary file storage, cancellation, trailers, connection
facts, and attempt-level transfer results.

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
after the response field section arrives and keep the total deadline active until the
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
      console.log(result.attempts.at(-1)?.transfer?.wireBytesReceived);
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

`openResponseBodyFile()` safely adopts a persistent cache file without giving
disposal permission to delete it. `collectResponseBody()` turns a byte stream
into a branded response body with an explicit byte limit and storage policy.

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

Extension methods must be defined explicitly:

```ts
import { defineHttpMethod } from "@ismail-elkorchi/http-client";

await client.request("https://example.com/resource", {
  method: defineHttpMethod("PROPFIND"),
});
```

## HTTP fields

Requests accept ordered field lines and responses return an immutable
`HttpFields` value. Repeated lines, including `set-cookie`, remain separate.

```ts
const result = await client.request("https://example.com/", {
  fields: [
    { name: "x-trace", value: "first" },
    { name: "x-trace", value: "second" },
  ],
});

if (result.kind === "response") {
  console.log(result.fields.all("set-cookie"));
}
```

`first()`, `all()`, `has()`, and iteration are lossless operations.
`toHeaders()` is available when a caller explicitly accepts the Web
`Headers` model. Field values use the transport's Latin-1 byte model; values
outside that range are rejected before network activity.

## Timeouts and observation

Set `timeouts.totalMs` or `timeouts.responseBodyProgressMs` to `null` to
disable that deadline. The response-body progress deadline applies while a
consumer is waiting for the next body chunk and is suspended while the
consumer applies backpressure. Connect and response-field deadlines remain
active.

An observer receives discriminated attempt, request-body, response, and
response-body progress events. Observer failures never alter the request.
Session adapters can prepare fields and accept response state with the request
identifier, attempt index, method, URL, and complete field lines.

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

`protocolPreference: "http2"` is strict: only TLS origins are accepted, and a
connection is rejected before request bytes are written unless ALPN selects
HTTP/2. Strict HTTP/2 is not accepted with a proxy because that negotiation
cannot be verified before the tunneled request.

Retry policy, cookies, caches, rate limits, and application sessions belong in
consumer adapters.

## Development

```sh
npm ci
npm run check
npm test
```
