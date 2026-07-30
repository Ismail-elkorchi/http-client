import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  HttpConfigurationError,
  NodeHttpClient,
  readResponseBody,
} from "../dist/index.js";
import {
  closeServer,
  listen,
  streamText,
  urlFor,
} from "./support.mjs";

test("strips sensitive headers across origins and rewrites POST redirects", async () => {
  let receivedHeaders = null;
  let receivedMethod = null;
  const target = await listen(
    http.createServer((request, response) => {
      receivedHeaders = request.headers;
      receivedMethod = request.method;
      response.end("complete");
    }),
  );
  const source = await listen(
    http.createServer((_request, response) => {
      response.writeHead(302, { location: urlFor(target, "/target") });
      response.end();
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.fetchBuffered(urlFor(source, "/start"), {
      method: "POST",
      body: { kind: "text", text: "payload" },
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic secret",
        "content-type": "text/plain",
      },
    });
    assert.equal(result.kind, "response");
    assert.equal(receivedMethod, "GET");
    assert.equal(receivedHeaders?.authorization, undefined);
    assert.equal(receivedHeaders?.cookie, undefined);
    assert.equal(receivedHeaders?.["proxy-authorization"], undefined);
    assert.equal(receivedHeaders?.["content-type"], undefined);
  } finally {
    await client.close();
    await closeServer(source);
    await closeServer(target);
  }
});

test("creates a fresh request stream when a redirect preserves the body", async () => {
  let createCount = 0;
  let observedBody = null;
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/start") {
        request.resume();
        request.on("end", () => {
          response.writeHead(307, { location: "/target" });
          response.end();
        });
        return;
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        observedBody = Buffer.concat(chunks).toString();
        response.end("complete");
      });
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.fetchBuffered(urlFor(server, "/start"), {
      method: "POST",
      body: {
        kind: "stream",
        contentLength: 7,
        create() {
          createCount += 1;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("payload"));
              controller.close();
            },
          });
        },
      },
    });
    assert.equal(result.kind, "response");
    assert.equal(createCount, 2);
    assert.equal(observedBody, "payload");
    assert.equal(result.transfer.requestBodyBytesSent, 7);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("enforces streamed upload limits and declared lengths", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("complete"));
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  const streamBody = (contentLength) => ({
    kind: "stream",
    contentLength,
    async *create() {
      yield new Uint8Array(8);
      yield new Uint8Array(8);
    },
  });
  try {
    const limited = await client.requestBuffered(urlFor(server), {
      method: "POST",
      maxRequestBodyBytes: 10,
      body: streamBody(undefined),
    });
    assert.equal(limited.kind, "failure");
    assert.equal(limited.error.code, "REQUEST_BODY_TOO_LARGE");

    const mismatched = await client.requestBuffered(urlFor(server), {
      method: "POST",
      body: streamBody(20),
    });
    assert.equal(mismatched.kind, "failure");
    assert.equal(
      mismatched.error.code,
      "REQUEST_BODY_LENGTH_MISMATCH",
    );
    assert.match(mismatched.error.message, /declared 20 bytes/u);

    const invalidSource = await client.requestBuffered(urlFor(server), {
      method: "POST",
      body: {
        kind: "stream",
        async *create() {
          yield "not bytes";
        },
      },
    });
    assert.equal(invalidSource.kind, "failure");
    assert.equal(
      invalidSource.error.code,
      "REQUEST_BODY_SOURCE_FAILURE",
    );
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("cancels the upload source when the request deadline expires", async () => {
  let uploadCancelled = false;
  const server = await listen(
    http.createServer((request, _response) => {
      request.resume();
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    timeouts: { totalMs: 40, responseHeadersMs: 500 },
  });
  try {
    const result = await client.request(urlFor(server), {
      method: "POST",
      body: {
        kind: "stream",
        create: () =>
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
              uploadCancelled = true;
            },
          }),
      },
    });
    assert.equal(result.kind, "failure");
    assert.equal(result.error.code, "TOTAL_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(uploadCancelled, true);
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("builds replayable multipart request bodies", async () => {
  let contentType = null;
  let contentLength = null;
  let payload = "";
  let requests = 0;
  let fileStreamCreations = 0;
  const server = await listen(
    http.createServer((request, response) => {
      requests += 1;
      contentType = request.headers["content-type"] ?? null;
      contentLength = request.headers["content-length"] ?? null;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        payload = Buffer.concat(chunks).toString();
        response.end("complete");
      });
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.requestBuffered(urlFor(server), {
      method: "POST",
      body: {
        kind: "multipart",
        parts: [
          { kind: "text", name: "title", value: "report" },
          {
            kind: "file",
            name: "attachment",
            fileName: "report.txt",
            mediaType: "text/plain",
            content: {
              kind: "stream",
              contentLength: 8,
              create() {
                fileStreamCreations += 1;
                return new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode("contents"),
                    );
                    controller.close();
                  },
                });
              },
            },
          },
        ],
      },
    });
    assert.equal(result.kind, "response");
    assert.match(contentType ?? "", /^multipart\/form-data; boundary=/u);
    assert.match(payload, /name="title"/u);
    assert.match(payload, /report/u);
    assert.match(payload, /filename="report.txt"/u);
    assert.match(payload, /contents/u);
    assert.equal(Number(contentLength), Buffer.byteLength(payload));
    assert.equal(fileStreamCreations, 1);

    const limited = await client.requestBuffered(urlFor(server), {
      method: "POST",
      maxRequestBodyBytes: 16,
      body: {
        kind: "multipart",
        parts: [{ kind: "text", name: "field", value: "value" }],
      },
    });
    assert.equal(limited.kind, "failure");
    assert.equal(limited.error.code, "REQUEST_BODY_TOO_LARGE");
    assert.equal(requests, 1);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("does not create a streamed upload before network admission", async () => {
  let createCount = 0;
  const client = new NodeHttpClient({
    resolver: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  try {
    const result = await client.request("http://blocked.example/", {
      method: "POST",
      body: {
        kind: "stream",
        create() {
          createCount += 1;
          return new ReadableStream();
        },
      },
    });
    assert.equal(result.kind, "failure");
    assert.equal(result.error.code, "NETWORK_SAFETY_REJECTED");
    assert.equal(createCount, 0);
  } finally {
    await client.close();
  }
});

test("captures credentials before preparing the next redirect request", async () => {
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
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.fetchBuffered(urlFor(server, "/start"), {
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
    assert.equal(result.kind, "response");
    assert.deepEqual(captured, [
      "first=1; Path=/",
      "second=2; Path=/",
    ]);
    assert.equal(
      new TextDecoder().decode(await readResponseBody(result.body)),
      "first=1; second=2",
    );
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("applies the total deadline to asynchronous consumer hooks", async () => {
  let requests = 0;
  const server = await listen(
    http.createServer((request, response) => {
      requests += 1;
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/target" });
        response.end();
        return;
      }
      response.end("complete");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    timeouts: { totalMs: 30 },
  });
  try {
    const preparation = await client.request(
      urlFor(server, "/preparation"),
      {
        credentials: {
          async requestHeaders() {
            return await new Promise(() => {});
          },
          async captureResponse() {},
        },
      },
    );
    assert.equal(preparation.kind, "failure");
    assert.equal(preparation.error.code, "TOTAL_TIMEOUT");
    assert.equal(requests, 0);

    const capture = await client.request(urlFor(server, "/capture"), {
      credentials: {
        async requestHeaders() {
          return {};
        },
        async captureResponse() {
          await new Promise(() => {});
        },
      },
    });
    assert.equal(capture.kind, "failure");
    assert.equal(capture.error.code, "TOTAL_TIMEOUT");

    const redirect = await client.fetch(urlFor(server, "/redirect"), {
      async onRedirect() {
        return await new Promise(() => {});
      },
    });
    assert.equal(redirect.kind, "failure");
    assert.equal(redirect.error.code, "TOTAL_TIMEOUT");
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("rejects invalid request boundaries before network activity", async () => {
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    await assert.rejects(
      client.request("http://127.0.0.1/", { method: "get" }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        headers: { test: "value\r\ninjected: yes" },
      }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        method: "POST",
        body: { kind: "text", text: "payload" },
        headers: { "content-length": "8" },
      }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        body: { kind: "unknown" },
      }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        method: "GET",
        body: { kind: "text", text: "invalid" },
      }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        responseLimit: 12,
      }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        body: { kind: "text", text: "value", data: "ignored" },
      }),
      HttpConfigurationError,
    );
    await assert.rejects(
      client.request("http://127.0.0.1/", {
        method: "POST",
        body: { kind: "multipart", parts: [] },
        headers: { "content-type": "multipart/form-data" },
      }),
      HttpConfigurationError,
    );
  } finally {
    await client.close();
  }
});

test("enforces request and response header limits", async () => {
  let requests = 0;
  const server = await listen(
    http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "x-large": "r".repeat(512) });
      response.end("complete");
    }),
  );
  const requestClient = new NodeHttpClient({
    maxRequestHeadersBytes: 64,
    networkSafety: { allowLocalhost: true },
  });
  const responseClient = new NodeHttpClient({
    maxResponseHeadersBytes: 128,
    networkSafety: { allowLocalhost: true },
  });
  try {
    const request = await requestClient.request(urlFor(server), {
      headers: { "x-large": "q".repeat(128) },
    });
    assert.equal(request.kind, "failure");
    assert.equal(request.error.code, "REQUEST_HEADERS_TOO_LARGE");
    assert.equal(requests, 0);

    const response = await responseClient.request(urlFor(server));
    assert.equal(response.kind, "failure");
    assert.equal(response.error.code, "RESPONSE_HEADERS_TOO_LARGE");
  } finally {
    await requestClient.close();
    await responseClient.close();
    await closeServer(server);
  }
});

test("rejects URL credentials without retaining the secret", async () => {
  const client = new NodeHttpClient();
  try {
    const result = await client.request(
      "https://user:secret@example.com/private",
    );
    assert.equal(result.kind, "failure");
    assert.equal(result.error.code, "INVALID_URL");
    assert.equal(result.finalUrl, "https://example.com/private");
    assert.equal(result.error.url.includes("secret"), false);
    assert.equal(result.error.message.includes("secret"), false);
  } finally {
    await client.close();
  }
});

test("request returns one exchange while fetch follows redirects", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/target" });
        response.end();
        return;
      }
      response.end("target");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const exchange = await client.request(urlFor(server, "/start"));
    assert.equal(exchange.kind, "response");
    assert.equal(exchange.statusCode, 302);
    assert.equal(await streamText(exchange.body), "");
    await exchange.completion;

    const fetched = await client.fetch(urlFor(server, "/start"));
    assert.equal(fetched.kind, "response");
    assert.equal(fetched.redirects.length, 1);
    assert.equal(await streamText(fetched.body), "target");
    await fetched.completion;
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("cancels redirect bodies and detects redirect loops", async () => {
  let redirectBodyClosed = false;
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/streaming-redirect") {
        response.writeHead(302, {
          location: "/target",
          "content-encoding": "unsupported",
        });
        response.flushHeaders();
        const timer = setInterval(() => response.write("unused"), 5);
        response.on("close", () => {
          clearInterval(timer);
          redirectBodyClosed = true;
        });
        return;
      }
      if (request.url === "/loop-a") {
        response.writeHead(302, { location: "/loop-b" });
        response.end();
        return;
      }
      if (request.url === "/loop-b") {
        response.writeHead(302, { location: "/loop-a" });
        response.end();
        return;
      }
      response.end("target");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const fetched = await client.fetchBuffered(
      urlFor(server, "/streaming-redirect"),
    );
    assert.equal(fetched.kind, "response");
    assert.equal(
      new TextDecoder().decode(await readResponseBody(fetched.body)),
      "target",
    );
    assert.equal(redirectBodyClosed, true);

    const loop = await client.fetch(urlFor(server, "/loop-a"));
    assert.equal(loop.kind, "failure");
    assert.equal(loop.error.code, "REDIRECT_LOOP");
    assert.deepEqual(
      loop.redirects.map(({ fromUrl, toUrl }) => [
        new URL(fromUrl).pathname,
        new URL(toUrl).pathname,
      ]),
      [
        ["/loop-a", "/loop-b"],
        ["/loop-b", "/loop-a"],
      ],
    );
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("surfaces informational responses before the final response", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeEarlyHints({ link: "</style.css>; rel=preload" });
      response.end("complete");
    }),
  );
  const observed = [];
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.requestBuffered(urlFor(server), {
      onInformationalResponse(response) {
        observed.push(response.statusCode);
      },
    });
    assert.equal(result.kind, "response");
    assert.deepEqual(observed, [103]);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("preserves the HTTP/1.1 status message", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(299, "Custom Status");
      response.end("complete");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "response");
    assert.equal(result.statusCode, 299);
    assert.equal(result.statusMessage, "Custom Status");
  } finally {
    await client.close();
    await closeServer(server);
  }
});
