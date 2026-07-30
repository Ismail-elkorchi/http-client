import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { test } from "node:test";
import {
  defineHttpMethod,
  HttpConfigurationError,
  NodeHttpClient,
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
  } finally {
    await client.close();
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

test("allows disabling only the total deadline", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      setTimeout(() => response.end("complete"), 50);
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    timeouts: {
      totalMs: null,
      responseFieldsMs: 500,
      responseBodyProgressMs: 500,
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
});
