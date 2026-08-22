# HTTP Client

A strict streaming HTTP/1.1 and HTTP/2 client with bounded transfers,
address-pinned DNS resolution, explicit outcomes, redirects, content decoding,
proxy and TLS configuration, and memory-to-file response storage.

The package targets Node.js 24 or newer. Its installed package is also tested
through Deno 2.9's Node compatibility layer.

## Install

From npm:

```sh
npm install @ismail-elkorchi/http-client
```

From JSR:

```ts
import { NodeHttpClient } from "jsr:@ismail-elkorchi/http-client@^0.1.1";
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

`request()` performs one exchange. `fetch()` follows redirects. Both resolve
when the response field section arrives, while `completion` reports the final
body transfer outcome. Consume or cancel every streaming response body so its
connection and deadline can be released.

Invalid definitions and request shapes reject with `HttpConfigurationError`.
Network, protocol, timeout, transfer-limit, and cancellation failures use the
`failure` result with a stable `HttpClientError.code`.

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

Responses larger than `memoryThresholdBytes` are written to private files.
Dispose buffered response bodies after use. `openResponseBodyFile()` adopts an
existing file without granting disposal permission to delete it, while
`collectResponseBody()` stores a byte stream under an explicit limit and
storage policy.

## Send request bodies

Text, byte, stream, and multipart bodies are replayable across redirects.
Stream factories are invoked only after network admission and must return a
fresh `ReadableStream<Uint8Array>` or `AsyncIterable<Uint8Array>` each time.

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

Extension methods are explicit:

```ts
import { defineHttpMethod } from "@ismail-elkorchi/http-client";

await client.request("https://example.com/resource", {
  method: defineHttpMethod("PROPFIND"),
});
```

## HTTP fields

Requests accept ordered field lines and responses expose an immutable
`HttpFields` collection. Repeated lines, including `set-cookie`, remain
separate.

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

Use `first()`, `all()`, `has()`, `lines()`, or iteration without losing field
line order. `toHeaders()` is available when the Web `Headers` representation
is appropriate. Request field values use the transport's Latin-1 byte model.

## Network safety, proxies, and TLS

Public addresses are allowed by default. Local, private, special-purpose, and
mixed public/non-public DNS results are rejected. A custom resolver is
validated and its approved addresses are snapshotted before connection
pinning.

```ts
const localClient = new NodeHttpClient({
  networkSafety: { allowLocalhost: true },
});
```

Applications that evaluate targets before making a request can reuse the same
policy semantics through `NetworkSafetyPolicy`. Its `decide()` operation
accepts an optional abort signal.

An explicit HTTP proxy resolves the target itself, so proxy use requires an
explicit opt-out from target address pinning:

```ts
const proxyClient = new NodeHttpClient({
  networkSafety: { enabled: false },
  proxy: { url: "http://proxy.example:8080/" },
});
```

`protocolPreference: "http2"` requires a TLS origin and verified HTTP/2 ALPN
negotiation before request bytes are sent. TLS certificate authorities, client
certificates, protocol versions, ciphers, and server names are configurable.

## Limits, deadlines, and observation

Client and request configuration controls request body bytes, request and
response field bytes, wire response bytes, decoded response bytes, content
encoding layers, redirects, retained origins, and connections per origin.

Set `timeouts.totalMs` or `timeouts.responseBodyProgressMs` to `null` to
disable that deadline. The body-progress deadline runs while a consumer waits
for a chunk and pauses while the consumer applies backpressure. Connect and
response-field deadlines remain bounded.

Observers receive discriminated attempt, upload, response, and download
events. Synchronous and asynchronous observer failures are contained. Session
adapters can synchronously or asynchronously prepare request fields and accept
response state for cookies, authentication, tracing, and application policy.

## Lifecycle

`close()` stops new work and drains accepted exchanges. `destroy()` aborts
active deadlines and response bodies before closing the transport. Concurrent
shutdown calls share one completion operation.

## Public API

The runtime entrypoint exports:

- `NodeHttpClient`
- `HttpFields` and `mergeHttpFields()`
- `NetworkSafetyPolicy`
- `parseContentLength()` and `requestAfterRedirect()`
- `defineHttpMethod()`
- `HttpClientError`, `HttpConfigurationError`, and `HttpClientStateError`
- `collectResponseBody()`, `openResponseBodyFile()`, `readResponseBody()`,
  `responseBodyPrefix()`, `responseBodySize()`, `responseBodyStream()`, and
  `disposeResponseBody()`
- `ResponseBodyCollectionLimitError`

The same entrypoint exports the TypeScript definitions for configuration,
requests, bodies, observations, transfers, failures, and response outcomes.

## Development

```sh
npm ci
npm run check
```

The check runs strict TypeScript, lint, runtime and public-type tests,
offline packed-package consumers for Node.js and Deno, and the JSR publication
dry run.

## Releases

A published `v<version>` GitHub Release is the only publication trigger. The
release commit must be contained in `main`, and its tag, changelog, npm
metadata, and JSR metadata must agree. npm and JSR publication use GitHub OIDC;
the repository does not use registry tokens.
