import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { test } from "node:test";
import {
  defineHttpMethod,
  HttpConfigurationError,
  HttpFields,
  mergeHttpFields,
  NodeHttpClient,
  parseContentLength,
  requestAfterRedirect,
} from "../dist/index.js";
import {
  closeServer,
  listen,
  portOf,
  tlsFixture,
  urlFor,
} from "./support.mjs";

test("rejects strict HTTP/2 before sending an HTTP/1.1 request", async () => {
  const certificate = await tlsFixture();
  let requests = 0;
  let offeredProtocols = [];
  const tlsServer = await listen(
    https.createServer(
      {
        key: certificate.key,
        cert: certificate.cert,
        ALPNCallback({ protocols }) {
          offeredProtocols = [...protocols];
          return protocols.includes("http/1.1")
            ? "http/1.1"
            : undefined;
        },
      },
      (_request, response) => {
        requests += 1;
        response.end();
      },
    ),
  );
  const cleartextServer = await listen(
    http.createServer((_request, response) => {
      requests += 1;
      response.end();
    }),
  );
  const client = new NodeHttpClient({
    protocolPreference: "http2",
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    networkSafety: { allowLocalhost: true },
    tls: { certificateAuthorities: certificate.cert },
  });
  try {
    const tlsResult = await client.request(
      `https://localhost:${String(portOf(tlsServer))}/`,
    );
    assert.equal(tlsResult.kind, "failure");
    assert.equal(tlsResult.error.code, "PROTOCOL_MISMATCH");

    const cleartextResult = await client.request(urlFor(cleartextServer));
    assert.equal(cleartextResult.kind, "failure");
    assert.equal(cleartextResult.error.code, "PROTOCOL_MISMATCH");
    assert.deepEqual(offeredProtocols, ["h2"]);
    assert.equal(requests, 0);
  } finally {
    await client.close();
    await closeServer(cleartextServer);
    await closeServer(tlsServer);
  }

  assert.throws(
    () =>
      new NodeHttpClient({
        protocolPreference: "http2",
        networkSafety: { enabled: false },
        proxy: { url: "http://proxy.example/" },
      }),
    HttpConfigurationError,
  );
});

test("enforces declared lengths for Web request streams", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end());
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  const streamBody = (contentLength, byteLength) => ({
    kind: "stream",
    contentLength,
    create: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(byteLength));
          controller.close();
        },
      }),
  });
  try {
    for (const body of [streamBody(4, 3), streamBody(3, 4)]) {
      const result = await client.request(urlFor(server), {
        method: "POST",
        body,
      });
      assert.equal(result.kind, "failure");
      assert.equal(result.error.code, "REQUEST_BODY_LENGTH_MISMATCH");
    }
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("preserves ordered repeated field lines", async () => {
  assert.throws(
    () => new HttpFields(new Array(1)),
    HttpConfigurationError,
  );
  let requestFields = [];
  const server = await listen(
    http.createServer((request, response) => {
      requestFields = request.rawHeaders;
      response.setHeader("set-cookie", ["first=1", "second=2"]);
      response.setHeader("x-repeated", ["first", "second"]);
      response.end();
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.requestBuffered(urlFor(server), {
      fields: [
        { name: "X-Repeated", value: "first" },
        { name: "x-repeated", value: "second" },
        { name: "x-latin1", value: "caf\u00e9" },
      ],
    });
    assert.equal(result.kind, "response");
    assert.deepEqual(result.fields.all("set-cookie"), [
      "first=1",
      "second=2",
    ]);
    assert.deepEqual(result.fields.all("x-repeated"), ["first", "second"]);
    const repeatedRequestValues = requestFields.flatMap((item, index) =>
      index % 2 === 0 && item.toLowerCase() === "x-repeated"
        ? [requestFields[index + 1]]
        : []
    );
    assert.deepEqual(repeatedRequestValues, ["first", "second"]);
    const latin1Index = requestFields.findIndex(
      (item) => item.toLowerCase() === "x-latin1",
    );
    assert.notEqual(latin1Index, -1);
    assert.equal(requestFields[latin1Index + 1], "caf\u00e9");
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("exposes strict field and redirect composition primitives", () => {
  const fields = mergeHttpFields(
    new HttpFields([
      { name: "accept", value: "text/plain" },
      { name: "authorization", value: "Bearer token" },
    ]),
    [{ name: "accept", value: "application/json" }],
  );
  assert.deepEqual(fields.lines(), [
    { name: "authorization", value: "Bearer token" },
    { name: "accept", value: "application/json" },
  ]);
  const redirected = requestAfterRedirect(
    "https://first.example/",
    "https://second.example/",
    303,
    {
      method: "POST",
      fields,
      body: { kind: "text", text: "payload" },
    },
  );
  assert.equal(redirected.method, "GET");
  assert.equal(redirected.body, undefined);
  assert.equal(redirected.fields.has("authorization"), false);
  assert.equal(parseContentLength("42"), 42);
  assert.equal(parseContentLength("4.2"), null);
});

test("contains asynchronous observer failures", async () => {
  const server = await listen(
    http.createServer((_request, response) => response.end("complete")),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    observer: {
      onEvent() {
        return Promise.reject(new Error("observer failed"));
      },
    },
  });
  try {
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "response");
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("isolates identical concurrent requests across client instances", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      let uploadedBytes = 0;
      request.on("data", (chunk) => {
        uploadedBytes += chunk.byteLength;
      });
      request.on("end", () => {
        response.writeHead(200, { trailer: "x-uploaded-bytes" });
        response.write("complete");
        response.addTrailers({
          "x-uploaded-bytes": String(uploadedBytes),
        });
        response.end();
      });
    }),
  );
  const clients = [
    new NodeHttpClient({
      networkSafety: { allowLocalhost: true },
    }),
    new NodeHttpClient({
      networkSafety: { allowLocalhost: true },
    }),
  ];
  const sizes = [3, 11];
  try {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const results = await Promise.all(
        clients.map(async (client, index) =>
          await client.requestBuffered(urlFor(server, "/identical"), {
            method: "POST",
            body: { kind: "bytes", bytes: new Uint8Array(sizes[index]) },
          })
        ),
      );
      for (const [index, result] of results.entries()) {
        assert.equal(result.kind, "response");
        const attempt = result.attempts.at(-1);
        assert.equal(attempt?.kind, "complete");
        assert.equal(
          attempt?.transfer.requestBodyBytesSent,
          sizes[index],
        );
        assert.equal(
          attempt?.transfer.trailers.first("x-uploaded-bytes"),
          String(sizes[index]),
        );
      }
    }
  } finally {
    await Promise.all(clients.map(async (client) => await client.destroy()));
    await closeServer(server);
  }
});

test("supports extension methods without weakening standard method states", async () => {
  let receivedMethod = null;
  const server = await listen(
    http.createServer((request, response) => {
      receivedMethod = request.method;
      request.resume();
      request.on("end", () => response.end());
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.requestBuffered(urlFor(server), {
      method: defineHttpMethod("PROPFIND"),
      body: { kind: "text", text: "query" },
    });
    assert.equal(result.kind, "response");
    assert.equal(receivedMethod, "PROPFIND");
  } finally {
    await client.close();
    await closeServer(server);
  }
  assert.throws(() => defineHttpMethod("propfind"), HttpConfigurationError);
  assert.throws(() => defineHttpMethod("CONNECT"), HttpConfigurationError);
  assert.throws(() => defineHttpMethod("GET"), HttpConfigurationError);
});

test("reports attempt-scoped outcomes and structured progress", async () => {
  const events = [];
  const server = await listen(
    http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.url === "/start") {
          response.writeHead(307, { location: "/target" });
          response.end();
          return;
        }
        response.write("first");
        response.end("second");
      });
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    observer: {
      onEvent(event) {
        events.push(event);
        if (event.kind === "response-body-progress") {
          throw new Error("Observer failures are isolated.");
        }
      },
    },
  });
  try {
    const result = await client.fetchBuffered(urlFor(server, "/start"), {
      method: "POST",
      body: { kind: "text", text: "payload" },
    });
    assert.equal(result.kind, "response");
    assert.deepEqual(
      result.attempts.map(({ kind, attemptIndex }) => [kind, attemptIndex]),
      [
        ["redirect", 0],
        ["complete", 1],
      ],
    );
    assert.equal(
      result.attempts.every(
        (attempt) => attempt.requestId === result.requestId,
      ),
      true,
    );
    assert.equal(
      events.some(({ kind }) => kind === "request-body-progress"),
      true,
    );
    assert.equal(
      events.some(({ kind }) => kind === "response-started"),
      true,
    );
    assert.equal(
      events.some(({ kind }) => kind === "response-body-progress"),
      true,
    );
    assert.equal(
      events.some(({ kind }) => kind === "attempt-completed"),
      true,
    );
    assert.deepEqual(
      events
        .filter(({ kind }) => kind === "attempt-completed")
        .map(({ attempt }) => attempt.kind),
      ["redirect", "complete"],
    );
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("allows disabling total and response-progress deadlines", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      setTimeout(() => response.end("complete"), 50);
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    timeouts: {
      totalMs: null,
      responseFieldsMs: 500,
      responseBodyProgressMs: null,
    },
  });
  try {
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "response");
  } finally {
    await client.close();
    await closeServer(server);
  }
  assert.throws(
    () => new NodeHttpClient({ timeouts: { totalMs: 0 } }),
    HttpConfigurationError,
  );
  assert.throws(
    () =>
      new NodeHttpClient({
        timeouts: { responseBodyProgressMs: 0 },
      }),
    HttpConfigurationError,
  );
});
