import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import fs from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import path from "node:path";
import { after, test } from "node:test";
import {
  NodeHttpClient,
  disposeResponseBody,
  readResponseBody,
} from "../dist/index.js";

const openClients = new Set();
const openServers = new Set();

after(async () => {
  await Promise.all([...openClients].map((client) => client.close()));
  await Promise.all([...openServers].map(closeServer));
});

test("follows redirects without forwarding cross-origin credentials", async () => {
  let receivedHeaders = null;
  const target = await listen(
    http.createServer((request, response) => {
      receivedHeaders = request.headers;
      response.end("done");
    }),
  );
  const source = await listen(
    http.createServer((_request, response) => {
      response.writeHead(302, { location: urlFor(target, "/target") });
      response.end();
    }),
  );
  const client = localClient();
  const result = await client.fetch(urlFor(source, "/start"), {
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "proxy-authorization": "Basic secret",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(receivedHeaders?.authorization, undefined);
  assert.equal(receivedHeaders?.cookie, undefined);
  assert.equal(receivedHeaders?.["proxy-authorization"], undefined);
});

for (const statusCode of [301, 302, 303]) {
  test(`rewrites POST to GET after ${String(statusCode)}`, async () => {
    let observed = null;
    const server = await listen(
      http.createServer((request, response) => {
        if (request.url === "/start") {
          response.writeHead(statusCode, { location: "/target" });
          response.end();
          return;
        }
        observed = {
          method: request.method,
          contentType: request.headers["content-type"],
          contentLength: request.headers["content-length"],
        };
        response.end("done");
      }),
    );
    const client = localClient();
    const result = await client.fetch(urlFor(server, "/start"), {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain", "content-length": "7" },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(observed, {
      method: "GET",
      contentType: undefined,
      contentLength: undefined,
    });
  });
}

test("preserves method and body after 307", async () => {
  let observed = null;
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(307, { location: "/target" });
        response.end();
        return;
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        observed = {
          method: request.method,
          body: Buffer.concat(chunks).toString(),
        };
        response.end("done");
      });
    }),
  );
  const client = localClient();
  const result = await client.fetch(urlFor(server, "/start"), {
    method: "POST",
    body: "payload",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(observed, { method: "POST", body: "payload" });
});

test("applies one deadline across redirects and response bodies", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/slow" });
        response.end();
        return;
      }
      response.writeHead(200);
      setTimeout(() => response.end("late"), 120);
    }),
  );
  const client = localClient({ requestTimeoutMs: 40 });
  const startedAt = performance.now();
  const result = await client.fetch(urlFor(server, "/start"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "FETCH_TIMEOUT");
  assert.ok(performance.now() - startedAt < 110);
});

test("distinguishes first-byte timeouts from the total deadline", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      setTimeout(() => response.end("late"), 100);
    }),
  );
  const client = localClient({
    requestTimeoutMs: 500,
    firstByteTimeoutMs: 20,
  });
  const result = await client.request(urlFor(server, "/"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "FETCH_FIRST_BYTE_TIMEOUT");
});

test("reports resolver failures as DNS errors", async () => {
  const client = trackedClient({
    resolver: async () => {
      throw new Error("resolver unavailable");
    },
  });
  const result = await client.request("https://unresolved.example/");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DNS_ERROR");
});

test("captures redirect cookies before preparing the next request", async () => {
  const captured = [];
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, {
          location: "/target",
          "set-cookie": ["first=1; Path=/", "second=2; Path=/"],
        });
        response.end();
        return;
      }
      response.end(request.headers.cookie ?? "");
    }),
  );
  const client = localClient();
  const result = await client.fetch(urlFor(server, "/start"), {
    credentials: {
      async requestHeaders() {
        return captured.length === 0
          ? {}
          : { cookie: "first=1; second=2" };
      },
      async captureResponse(_url, headers) {
        captured.push(...headers.getSetCookie());
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(captured, [
    "first=1; Path=/",
    "second=2; Path=/",
  ]);
  assert.equal(await bodyText(result), "first=1; second=2");
});

test("decodes stacked content encodings while counting raw wire bytes", async () => {
  const payload = Buffer.from("stacked response");
  const encoded = brotliCompressSync(gzipSync(payload));
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip, br" });
      response.end(encoded);
    }),
  );
  const client = localClient();
  const result = await client.request(urlFor(server, "/"));
  assert.equal(result.ok, true);
  assert.equal(result.wireBytesRead, encoded.byteLength);
  assert.equal(result.decodedBytesRead, payload.byteLength);
  assert.deepEqual(Buffer.from(await readResponseBody(result.body)), payload);
});

test("cancels redirect bodies before following or rejecting a target", async () => {
  let closedResponses = 0;
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/target") {
        response.end("done");
        return;
      }
      response.writeHead(302, { location: "/target" });
      response.flushHeaders();
      const timer = setInterval(() => response.write(Buffer.alloc(4096)), 2);
      response.on("close", () => {
        clearInterval(timer);
        closedResponses += 1;
      });
    }),
  );
  const client = localClient({ requestTimeoutMs: 1_000 });
  const followed = await client.fetch(urlFor(server, "/follow"));
  assert.equal(followed.ok, true);
  const rejected = await client.fetch(urlFor(server, "/reject"), {
    onRedirect: () => ({ action: "reject", reason: "test rejection" }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "REDIRECT_TARGET_REJECTED");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closedResponses, 2);
});

test("spools large bodies to private files", async () => {
  const payload = Buffer.alloc(32 * 1024, 1);
  const server = await listen(
    http.createServer((_request, response) => response.end(payload)),
  );
  const client = localClient({
    responseLimits: { memoryThresholdBytes: 64 },
  });
  const result = await client.request(urlFor(server, "/"));
  assert.equal(result.ok, true);
  assert.equal(result.body.kind, "file");
  const file = await fs.stat(result.body.path);
  const directory = await fs.stat(path.dirname(result.body.path));
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(directory.mode & 0o777, 0o700);
  await disposeResponseBody(result.body);
});

test("enforces compressed and decompressed byte limits", async () => {
  const expanded = Buffer.alloc(16 * 1024, 1);
  const compressed = gzipSync(expanded);
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/wire") {
        response.end(Buffer.alloc(128));
        return;
      }
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(compressed);
    }),
  );
  const client = localClient();
  const wire = await client.request(urlFor(server, "/wire"), {
    responseLimits: { maxCompressedBytes: 64 },
  });
  assert.equal(wire.ok, false);
  assert.equal(wire.error.code, "RESPONSE_TOO_LARGE");
  const decoded = await client.request(urlFor(server, "/decoded"), {
    responseLimits: { maxDecompressedBytes: 1024 },
  });
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, "DECOMPRESSED_RESPONSE_TOO_LARGE");
});

test("uses one pinned HTTP/2 request and exposes raw bytes, address and TLS facts", async () => {
  const certificate = await tlsFixture();
  const rawBody = Buffer.from([0xff, 0x00, 0x7f, 0x80]);
  const protocols = [];
  const server = await listen(
    http2.createSecureServer({
      allowHTTP1: true,
      key: certificate.key,
      cert: certificate.cert,
    }).on("request", (request, response) => {
      protocols.push(request.httpVersion);
      response.writeHead(200, { "content-encoding": "identity" });
      response.end(rawBody);
    }),
  );
  const client = trackedClient({
    protocolPreference: "http2",
    rejectUnauthorized: false,
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    networkSafety: { allowLocalhost: true },
  });
  const result = await client.request(
    `https://pinned.example:${String(portOf(server))}/`,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(protocols, ["2.0"]);
  assert.equal(result.protocol, "h2");
  assert.equal(result.remoteAddress, "127.0.0.1");
  assert.equal(result.wireBytesRead, rawBody.byteLength);
  assert.deepEqual(Buffer.from(await readResponseBody(result.body)), rawBody);
  assert.match(result.tls?.protocol ?? "", /^TLSv/u);
  assert.ok((result.tls?.cipher.length ?? 0) > 0);
  assert.equal(result.tls?.authorized, false);
  assert.ok((result.tls?.certificateValidTo.length ?? 0) > 0);
});

test("does not retry malformed HTTP/2 compressed bodies over HTTP/1", async () => {
  const certificate = await tlsFixture();
  const protocols = [];
  const server = await listen(
    http2.createSecureServer({
      allowHTTP1: true,
      key: certificate.key,
      cert: certificate.cert,
    }).on("request", (request, response) => {
      protocols.push(request.httpVersion);
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end("not gzip");
    }),
  );
  const client = localClient({
    protocolPreference: "auto",
    rejectUnauthorized: false,
  });
  const result = await client.request(urlFor(server, "/"));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "FETCH_DECOMPRESSION_ERROR");
  assert.deepEqual(protocols, ["2.0"]);
});

test("does not send TLS SNI for an IP-literal URL", async () => {
  const certificate = await tlsFixture();
  let servername = "not-observed";
  const server = http2.createSecureServer({
    allowHTTP1: true,
    key: certificate.key,
    cert: certificate.cert,
  });
  server.on("secureConnection", (socket) => {
    servername = socket.servername;
  });
  server.on("request", (_request, response) => response.end("ok"));
  await listen(server);
  const client = localClient({ rejectUnauthorized: false });
  const result = await client.request(urlFor(server, "/"));
  assert.equal(result.ok, true);
  assert.equal(servername, false);
});

test("correlates connection facts for concurrent HTTP/1.1 and HTTP/2 requests", async () => {
  const certificate = await tlsFixture();
  const h1 = await listen(
    http.createServer((_request, response) => response.end("h1")),
  );
  const h2 = await listen(
    http2.createSecureServer({
      allowHTTP1: true,
      key: certificate.key,
      cert: certificate.cert,
    }).on("request", (_request, response) => response.end("h2")),
  );
  const client = localClient({ rejectUnauthorized: false });
  const [first, second] = await Promise.all([
    client.request(urlFor(h1, "/")),
    client.request(urlFor(h2, "/")),
  ]);
  assert.equal(first.protocol, "http/1.1");
  assert.equal(first.tls, null);
  assert.equal(second.protocol, "h2");
  assert.match(second.tls?.protocol ?? "", /^TLSv/u);
});

function localClient(configuration = {}) {
  return trackedClient({
    networkSafety: { allowLocalhost: true },
    ...configuration,
  });
}

function trackedClient(configuration) {
  const client = new NodeHttpClient(configuration);
  openClients.add(client);
  return client;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.add(server);
  return server;
}

async function closeServer(server) {
  openServers.delete(server);
  await new Promise((resolve) => server.close(resolve));
}

function portOf(server) {
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return address.port;
}

function urlFor(server, pathname) {
  const scheme =
    server.constructor.name === "Http2SecureServer" ? "https" : "http";
  return `${scheme}://127.0.0.1:${String(portOf(server))}${pathname}`;
}

async function bodyText(result) {
  assert.equal(result.ok, true);
  return new TextDecoder().decode(await readResponseBody(result.body));
}

async function tlsFixture() {
  return {
    cert: await fs.readFile(new URL("fixtures/localhost-cert.pem", import.meta.url)),
    key: await fs.readFile(new URL("fixtures/localhost-key.pem", import.meta.url)),
  };
}
