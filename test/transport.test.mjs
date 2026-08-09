import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { test } from "node:test";
import {
  HttpClientStateError,
  HttpConfigurationError,
  NodeHttpClient,
} from "../dist/index.js";
import {
  closeServer,
  listen,
  portOf,
  streamText,
  tlsFixture,
  urlFor,
} from "./support.mjs";

test("reports socket reuse and measured establishment facts", async () => {
  const server = await listen(
    http.createServer((_request, response) => response.end("complete")),
  );
  const client = new NodeHttpClient({
    maxConnectionsPerOrigin: 1,
    networkSafety: { allowLocalhost: true },
  });
  try {
    const first = await client.request(urlFor(server));
    assert.equal(first.kind, "response");
    await streamText(first.body);
    await first.completion;
    assert.equal(first.connection.connectionReused, false);
    assert.equal((first.connection.establishmentMs ?? -1) >= 0, true);
    assert.equal(first.connection.socketRemoteAddress, "127.0.0.1");
    assert.equal(first.connection.socketAddressFamily, 4);

    const second = await client.request(urlFor(server));
    assert.equal(second.kind, "response");
    await streamText(second.body);
    await second.completion;
    assert.equal(second.connection.connectionReused, true);
    assert.equal(
      second.connection.establishmentMs,
      first.connection.establishmentMs,
    );
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("evicts the least-recently-used inactive origin", async () => {
  const firstServer = await listen(
    http.createServer((_request, response) => response.end("first")),
  );
  const secondServer = await listen(
    http.createServer((_request, response) => response.end("second")),
  );
  const client = new NodeHttpClient({
    maxOrigins: 1,
    networkSafety: { allowLocalhost: true },
  });
  try {
    const first = await client.requestBuffered(urlFor(firstServer));
    assert.equal(first.kind, "response");
    const second = await client.requestBuffered(urlFor(secondServer));
    assert.equal(second.kind, "response");
  } finally {
    await client.close();
    await closeServer(firstServer);
    await closeServer(secondServer);
  }
});

test("reports origin capacity when every retained origin is active", async () => {
  const firstServer = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.write("active");
    }),
  );
  const secondServer = await listen(
    http.createServer((_request, response) => response.end("second")),
  );
  const client = new NodeHttpClient({
    maxOrigins: 1,
    networkSafety: { allowLocalhost: true },
  });
  try {
    const active = await client.request(urlFor(firstServer));
    assert.equal(active.kind, "response");
    const blocked = await client.request(urlFor(secondServer));
    assert.equal(blocked.kind, "failure");
    assert.equal(blocked.error.code, "ORIGIN_CAPACITY_EXCEEDED");
    active.cancel();
    await active.completion;

    const recovered = await client.requestBuffered(urlFor(secondServer));
    assert.equal(recovered.kind, "response");
  } finally {
    await client.destroy();
    await closeServer(firstServer);
    await closeServer(secondServer);
  }
});

test("reserves an origin before admitting a concurrent origin", async () => {
  const firstServer = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.write("active");
    }),
  );
  const secondServer = await listen(
    http.createServer((_request, response) => response.end("second")),
  );
  const client = new NodeHttpClient({
    maxOrigins: 1,
    networkSafety: { allowLocalhost: true },
  });
  try {
    const firstRequest = client.request(urlFor(firstServer));
    const secondRequest = client.request(urlFor(secondServer));
    const [first, second] = await Promise.all([
      firstRequest,
      secondRequest,
    ]);
    assert.equal(first.kind, "response");
    assert.equal(second.kind, "failure");
    assert.equal(second.error.code, "ORIGIN_CAPACITY_EXCEEDED");
    first.cancel();
    await first.completion;
  } finally {
    await client.destroy();
    await closeServer(firstServer);
    await closeServer(secondServer);
  }
});

test("falls back across approved IPv6 and IPv4 addresses", async () => {
  const server = await listen(
    http.createServer((_request, response) => response.end("fallback")),
  );
  const client = new NodeHttpClient({
    resolver: async () => [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ],
    networkSafety: {
      allowLocalhost: true,
      addressAttemptDelayMs: 20,
    },
  });
  try {
    const result = await client.requestBuffered(
      `http://fallback.test:${String(portOf(server))}/`,
    );
    assert.equal(result.kind, "response");
    assert.equal(result.connection.socketRemoteAddress, "127.0.0.1");
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("supports an explicit HTTP proxy when target pinning is disabled", async () => {
  const target = await listen(
    http.createServer((_request, response) => response.end("proxied")),
  );
  let forwardedTarget = null;
  let proxyAuthorization = null;
  const proxy = http.createServer((request, response) => {
    forwardedTarget = request.url ?? null;
    proxyAuthorization = request.headers["proxy-authorization"] ?? null;
    const targetUrl = new URL(request.url ?? "");
    const upstream = http.request(
      targetUrl,
      {
        method: request.method,
        headers: {
          ...request.headers,
          host: targetUrl.host,
        },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connect", (request, clientSocket, head) => {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const host = request.url?.slice(0, separator) ?? "";
    const port = Number(request.url?.slice(separator + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n",
      );
      if (head.byteLength > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  await listen(proxy);
  const authenticatedProxyUrl = new URL(urlFor(proxy));
  authenticatedProxyUrl.username = "proxy-user";
  authenticatedProxyUrl.password = "proxy-password";
  const client = new NodeHttpClient({
    networkSafety: { enabled: false },
    proxy: { url: authenticatedProxyUrl },
  });
  try {
    const result = await client.requestBuffered(urlFor(target));
    assert.equal(result.kind, "response");
    assert.equal(forwardedTarget, urlFor(target));
    assert.equal(
      proxyAuthorization,
      `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`,
    );
    assert.equal(result.connection.proxyUrl, urlFor(proxy));
  } finally {
    await client.close();
    await closeServer(proxy);
    await closeServer(target);
  }
});

test("pins HTTP/2, trusts an explicit CA, and reports certificate facts", async () => {
  const certificate = await tlsFixture();
  const server = await listen(
    http2.createSecureServer({
      allowHTTP1: true,
      key: certificate.key,
      cert: certificate.cert,
    }).on("request", (_request, response) => response.end("secure")),
  );
  const client = new NodeHttpClient({
    protocolPreference: "http2",
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    networkSafety: { allowLocalhost: true },
    tls: { certificateAuthorities: certificate.cert },
  });
  try {
    const result = await client.requestBuffered(
      `https://localhost:${String(portOf(server))}/`,
    );
    assert.equal(result.kind, "response");
    assert.equal(result.connection.httpVersion, "http/2");
    assert.equal(result.connection.tls?.authorized, true);
    assert.equal(
      result.connection.tls?.peerCertificate?.subject.CN,
      "localhost",
    );
    assert.match(
      result.connection.tls?.peerCertificate?.fingerprintSha256 ?? "",
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u,
    );
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("multiplexes concurrent strict HTTP/2 requests on one connection", async () => {
  const certificate = await tlsFixture();
  let connectionCount = 0;
  let activeStreams = 0;
  let peakStreams = 0;
  const server = http2.createSecureServer({
    key: certificate.key,
    cert: certificate.cert,
  });
  server.on("session", () => {
    connectionCount += 1;
  });
  server.on("stream", (stream) => {
    activeStreams += 1;
    peakStreams = Math.max(peakStreams, activeStreams);
    setTimeout(() => {
      activeStreams -= 1;
      stream.respond({ ":status": 200 });
      stream.end("multiplexed");
    }, 25);
  });
  await listen(server);
  const client = new NodeHttpClient({
    protocolPreference: "http2",
    maxConnectionsPerOrigin: 20,
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    networkSafety: { allowLocalhost: true },
    tls: { certificateAuthorities: certificate.cert },
  });
  try {
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          await client.requestBuffered(
            `https://localhost:${String(portOf(server))}/`,
          ),
      ),
    );
    assert.equal(
      results.every((result) => result.kind === "response"),
      true,
    );
    assert.equal(connectionCount, 1);
    assert.equal(peakStreams > 1, true);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("establishes a verified TLS tunnel through an HTTP proxy", async () => {
  const certificate = await tlsFixture();
  const target = await listen(
    http2.createSecureServer({
      allowHTTP1: true,
      key: certificate.key,
      cert: certificate.cert,
    }).on("request", (_request, response) => response.end("tunnelled")),
  );
  let tunnelTarget = null;
  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket, head) => {
    tunnelTarget = request.url ?? null;
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const host = request.url?.slice(0, separator) ?? "";
    const port = Number(request.url?.slice(separator + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n",
      );
      if (head.byteLength > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  await listen(proxy);
  const client = new NodeHttpClient({
    networkSafety: { enabled: false },
    proxy: { url: urlFor(proxy) },
    tls: { certificateAuthorities: certificate.cert },
  });
  try {
    const result = await client.requestBuffered(
      `https://localhost:${String(portOf(target))}/`,
    );
    assert.equal(result.kind, "response");
    assert.equal(
      tunnelTarget,
      `localhost:${String(portOf(target))}`,
    );
    assert.equal(result.connection.httpVersion, "http/2");
    assert.equal(result.connection.tls?.authorized, true);
    assert.equal(result.connection.proxyUrl, urlFor(proxy));
  } finally {
    await client.close();
    await closeServer(proxy);
    await closeServer(target);
  }
});

test("does not send TLS SNI for an IP literal", async () => {
  const certificate = await tlsFixture();
  let serverName = "not-observed";
  const server = http2.createSecureServer({
    allowHTTP1: true,
    key: certificate.key,
    cert: certificate.cert,
  });
  server.on("secureConnection", (socket) => {
    serverName = socket.servername;
  });
  server.on("request", (_request, response) => response.end("secure"));
  await listen(server);
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    tls: { rejectUnauthorized: false },
  });
  try {
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "response");
    assert.equal(serverName, false);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("validates proxy and TLS configurations", () => {
  assert.throws(
    () => new NodeHttpClient({ proxy: { url: "http://127.0.0.1:8080" } }),
    HttpConfigurationError,
  );
  assert.throws(
    () =>
      new NodeHttpClient({
        tls: { clientCertificate: "certificate without key" },
      }),
    HttpConfigurationError,
  );
  assert.throws(
    () => new NodeHttpClient({ protocolPreference: "sometimes" }),
    HttpConfigurationError,
  );
  assert.throws(
    () => new NodeHttpClient({ requestTimeoutMs: 100 }),
    HttpConfigurationError,
  );
  assert.throws(
    () => new NodeHttpClient({ tls: { minimumVersion: "SSLv3" } }),
    HttpConfigurationError,
  );
  assert.throws(
    () =>
      new NodeHttpClient({
        tls: {
          minimumVersion: "TLSv1.3",
          maximumVersion: "TLSv1.2",
        },
      }),
    HttpConfigurationError,
  );
  assert.throws(
    () =>
      new NodeHttpClient({
        networkSafety: { enabled: false },
        proxy: { url: "http://proxy.example/path" },
      }),
    HttpConfigurationError,
  );
  assert.throws(
    () =>
      new NodeHttpClient({
        networkSafety: { enabled: false },
        proxy: {
          url: "http://user:password@proxy.example/",
          fields: [
            { name: "proxy-authorization", value: "Bearer token" },
          ],
        },
      }),
    HttpConfigurationError,
  );
  assert.throws(
    () =>
      new NodeHttpClient({
        networkSafety: { enabled: false },
        proxy: {
          url: "http://:password@proxy.example/",
          fields: [
            { name: "proxy-authorization", value: "Bearer token" },
          ],
        },
      }),
    HttpConfigurationError,
  );
  const sparseAuthorities = new Array(1);
  assert.throws(
    () =>
      new NodeHttpClient({
        tls: { certificateAuthorities: sparseAuthorities },
      }),
    HttpConfigurationError,
  );
});

test("accepts prototype-named proxy fields without object collisions", async () => {
  const client = new NodeHttpClient({
    networkSafety: { enabled: false },
    proxy: {
      url: "http://proxy.example/",
      fields: [
        { name: "constructor", value: "value" },
        { name: "__proto__", value: "value" },
      ],
    },
  });
  await client.close();
});

test("applies the total deadline while DNS is unresolved", async () => {
  const client = new NodeHttpClient({
    resolver: async () => await new Promise(() => {}),
    timeouts: { totalMs: 20 },
    networkSafety: { dnsTimeoutMs: 100 },
  });
  const startedAt = performance.now();
  try {
    const result = await client.request("https://unresolved.example/");
    assert.equal(result.kind, "failure");
    assert.equal(result.error.code, "TOTAL_TIMEOUT");
    assert.equal(performance.now() - startedAt < 500, true);
  } finally {
    await client.close();
  }
});

test("close rejects new work and destroy cancels live responses", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.write("active");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const response = await client.request(urlFor(server));
    assert.equal(response.kind, "response");
    await client.destroy(new Error("shutdown"));
    const completion = await response.completion;
    assert.equal(completion.kind, "cancelled");
    await assert.rejects(client.request(urlFor(server)), HttpClientStateError);
  } finally {
    await closeServer(server);
  }
});

test("shares concurrent shutdown and allows close-to-destroy escalation", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.write("active");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const response = await client.request(urlFor(server));
    assert.equal(response.kind, "response");
    const firstClose = client.close();
    const secondClose = client.close();
    await client.destroy(new Error("shutdown escalation"));
    await Promise.all([firstClose, secondClose]);
    const completion = await response.completion;
    assert.equal(completion.kind, "cancelled");
  } finally {
    await closeServer(server);
  }
});

test("drains accepted exchanges and aborts pending exchanges on destroy", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      setTimeout(() => response.end("complete"), 30);
    }),
  );
  const gracefulClient = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const pending = gracefulClient.request(urlFor(server));
    const closing = gracefulClient.close();
    const result = await pending;
    assert.equal(result.kind, "response");
    assert.equal(await streamText(result.body), "complete");
    await result.completion;
    await closing;
  } finally {
    await closeServer(server);
  }

  const destructiveClient = new NodeHttpClient({
    resolver: async () => await new Promise(() => {}),
    networkSafety: { dnsTimeoutMs: 1_000 },
  });
  const pending = destructiveClient.request("https://pending.example/");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await destructiveClient.destroy(new Error("shutdown"));
  const result = await pending;
  assert.equal(result.kind, "failure");
  assert.equal(result.error.code, "REQUEST_ABORTED");
});
