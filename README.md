# HTTP Client

A bounded HTTP client for Node.js. It provides address-pinned network safety,
HTTP/1.1 and HTTP/2 through Undici, raw-wire byte limits, layered content
decoding, file-backed response bodies, redirect handling, and connection/TLS
facts.

Requires Node.js 24 or newer.

## Install

```sh
npm install @ismail-elkorchi/http-client
```

## Use

```ts
import {
  NodeHttpClient,
  readResponseBody,
} from "@ismail-elkorchi/http-client";

const client = new NodeHttpClient({
  defaultHeaders: { "user-agent": "my-crawler/1.0" },
  responseLimits: {
    maxCompressedBytes: 10 * 1024 * 1024,
    maxDecompressedBytes: 50 * 1024 * 1024,
  },
});

try {
  const result = await client.fetch("https://example.com/");
  if (!result.ok) {
    console.error(result.error.code, result.error.message);
  } else {
    const bytes = await readResponseBody(result.body);
    console.log(result.statusCode, result.protocol, bytes.byteLength);
  }
} finally {
  await client.close();
}
```

Network safety allows public addresses by default and rejects localhost,
private, reserved, documentation, and mixed public/non-public DNS answers.
Callers that intentionally access a private network must opt in:

```ts
const client = new NodeHttpClient({
  networkSafety: { allowPrivateNetworks: true },
});
```

`request()` performs one HTTP exchange. `fetch()` follows redirects, applies a
single end-to-end deadline, strips credentials across origins, applies standard
POST redirect rewrites, captures intermediate credentials through a
`CredentialProvider`, and cancels unused redirect bodies.

Successful results contain a `ResponseBody` discriminated union. Small bodies
are held in memory; larger bodies are written to private temporary files. Use
`readResponseBody()`, `responseBodyPrefix()`, `responseBodyStream()`, and
`disposeResponseBody()` instead of depending on storage details.

## Development

```sh
npm ci
npm test
```

`npm run check` runs strict TypeScript and ESLint checks.
