# Changes to HTTP Client

## 0.1.0 - 2026-08-09

- Add streaming and buffered HTTP/1.1 and HTTP/2 requests with explicit
  completion outcomes.
- Add bounded uploads, response decoding, memory-to-file buffering, redirects,
  cancellation, trailers, and transfer observations.
- Add public-address network policy, DNS pinning, origin limits, explicit proxy
  support, and configurable TLS verification.
- Keep private-network opt-in limited to private-use address space.
- Create default response spool files securely in the system temporary
  directory without trusting a predictable shared child directory.
- Preserve ordered HTTP field lines and provide replayable text, byte, stream,
  and multipart request bodies.
- Snapshot mutable request-body bytes once so redirect retries replay the
  original request content.
- Publish strict TypeScript definitions and npm and JSR entrypoints for Node.js
  and Deno.
