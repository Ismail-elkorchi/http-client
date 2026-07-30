import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import {
  HttpClientError,
  NodeHttpClient,
  HttpConfigurationError,
  disposeResponseBody,
  readResponseBody,
} from "../dist/index.js";
import {
  closeServer,
  listen,
  streamText,
  urlFor,
} from "./support.mjs";

test("returns response headers before the network body reaches EOF", async () => {
  let responseClosed = false;
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.write("first");
      const timer = setTimeout(() => response.end("late"), 1_000);
      response.on("close", () => {
        clearTimeout(timer);
        responseClosed = true;
      });
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const startedAt = performance.now();
    const result = await client.request(urlFor(server));
    assert.equal(result.kind, "response");
    assert.equal(performance.now() - startedAt < 500, true);
    const reader = result.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "first");
    await reader.cancel(new Error("consumer finished"));
    const completion = await result.completion;
    assert.equal(completion.kind, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(responseClosed, true);
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("rejects caller-constructed response bodies", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "http-client-body-test-"),
  );
  const file = path.join(directory, "unmanaged.txt");
  await fs.writeFile(file, "retain");
  try {
    await assert.rejects(
      disposeResponseBody({
        kind: "file",
        path: file,
        size: 6,
        temporary: true,
      }),
      HttpConfigurationError,
    );
    assert.equal(await fs.readFile(file, "utf8"), "retain");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps the total deadline active through stream consumption", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      const timer = setInterval(() => response.write("x"), 10);
      response.on("close", () => clearInterval(timer));
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    timeouts: { totalMs: 60, responseBodyProgressMs: 500 },
  });
  try {
    const result = await client.request(urlFor(server));
    assert.equal(result.kind, "response");
    await assert.rejects(streamText(result.body));
    const completion = await result.completion;
    assert.equal(completion.kind, "failure");
    assert.equal(completion.error.code, "TOTAL_TIMEOUT");
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("buffers through the same decoded stream and captures trailers", async () => {
  const payload = Buffer.from("decoded response");
  const encoded = gzipSync(payload);
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        trailer: "x-checksum",
      });
      response.write(encoded);
      response.addTrailers({ "x-checksum": "verified" });
      response.end();
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "response");
    assert.deepEqual(Buffer.from(await readResponseBody(result.body)), payload);
    assert.equal(result.transfer.wireBytesReceived, encoded.byteLength);
    assert.equal(result.transfer.decodedBytesReceived, payload.byteLength);
    assert.equal(result.transfer.trailers.get("x-checksum"), "verified");
    assert.equal(result.transfer.timings.responseBodyMs >= 0, true);
    assert.equal(
      result.transfer.timings.totalMs >=
        result.headTimings.responseHeadersMs,
      true,
    );
    await disposeResponseBody(result.body);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("spools buffered responses into private disposable files", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "http-client-spool-test-"),
  );
  const spoolDirectory = path.join(directory, "bodies");
  const payload = Buffer.alloc(32 * 1024, 7);
  const server = await listen(
    http.createServer((_request, response) => response.end(payload)),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    responseStorage: {
      memoryThresholdBytes: 64,
      spoolDirectory,
    },
  });
  try {
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "response");
    assert.equal(result.body.kind, "file");
    assert.deepEqual(
      Buffer.from(await readResponseBody(result.body)),
      payload,
    );
    const filePath = result.body.path;
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(spoolDirectory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    }
    await disposeResponseBody(result.body);
    await assert.rejects(fs.stat(filePath), { code: "ENOENT" });
  } finally {
    await client.close();
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cancels a live response when file spooling fails", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "http-client-spool-failure-"),
  );
  const unusableDirectory = path.join(directory, "not-a-directory");
  await fs.writeFile(unusableDirectory, "file");
  let responseClosed = false;
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      const timer = setInterval(() => response.write(Buffer.alloc(1024)), 5);
      response.on("close", () => {
        clearInterval(timer);
        responseClosed = true;
      });
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    responseStorage: {
      memoryThresholdBytes: 0,
      spoolDirectory: unusableDirectory,
    },
  });
  try {
    const startedAt = performance.now();
    const result = await client.requestBuffered(urlFor(server));
    assert.equal(result.kind, "failure");
    assert.equal(result.error.code, "FILESYSTEM_FAILURE");
    assert.equal(performance.now() - startedAt < 1_000, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(responseClosed, true);
  } finally {
    await client.destroy();
    await closeServer(server);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("decodes zstd and can preserve encoded response bytes", async () => {
  const payload = Buffer.from("modern encoding");
  const encoded = zstdCompressSync(payload);
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200, { "content-encoding": "zstd" });
      response.end(encoded);
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const decoded = await client.requestBuffered(urlFor(server));
    assert.equal(decoded.kind, "response");
    assert.deepEqual(Buffer.from(await readResponseBody(decoded.body)), payload);

    const preserved = await client.requestBuffered(urlFor(server), {
      responseContentDecoding: "preserve",
    });
    assert.equal(preserved.kind, "response");
    assert.deepEqual(
      Buffer.from(await readResponseBody(preserved.body)),
      encoded,
    );
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("classifies unsupported, excessive, and malformed content encodings", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/unsupported") {
        response.writeHead(200, { "content-encoding": "compress" });
        response.end("encoded");
        return;
      }
      if (request.url === "/layers") {
        response.writeHead(200, { "content-encoding": "gzip, gzip" });
        response.end("encoded");
        return;
      }
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end("not-gzip");
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const unsupported = await client.requestBuffered(
      urlFor(server, "/unsupported"),
    );
    assert.equal(unsupported.kind, "failure");
    assert.equal(
      unsupported.error.code,
      "UNSUPPORTED_CONTENT_ENCODING",
    );

    const layers = await client.requestBuffered(urlFor(server, "/layers"), {
      responseTransferLimits: { maxContentEncodingLayers: 1 },
    });
    assert.equal(layers.kind, "failure");
    assert.equal(layers.error.code, "UNSUPPORTED_CONTENT_ENCODING");

    const malformed = await client.requestBuffered(
      urlFor(server, "/malformed"),
    );
    assert.equal(malformed.kind, "failure");
    assert.equal(
      malformed.error.code,
      "RESPONSE_DECOMPRESSION_FAILURE",
    );
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("does not decode representation metadata on bodyless responses", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      response.writeHead(request.method === "HEAD" ? 200 : 204, {
        "content-encoding": "gzip",
      });
      response.end();
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const head = await client.requestBuffered(urlFor(server, "/head"), {
      method: "HEAD",
    });
    assert.equal(head.kind, "response");
    assert.equal(head.body.size, 0);

    const noContent = await client.requestBuffered(
      urlFor(server, "/no-content"),
    );
    assert.equal(noContent.kind, "response");
    assert.equal(noContent.statusCode, 204);
    assert.equal(noContent.body.size, 0);
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("enforces wire and decoded limits while streaming", async () => {
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
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const wire = await client.requestBuffered(urlFor(server, "/wire"), {
      responseTransferLimits: { maxWireBytes: 64 },
    });
    assert.equal(wire.kind, "failure");
    assert.equal(wire.error.code, "WIRE_RESPONSE_TOO_LARGE");

    const decoded = await client.requestBuffered(urlFor(server, "/decoded"), {
      responseTransferLimits: { maxDecodedBytes: 1024 },
    });
    assert.equal(decoded.kind, "failure");
    assert.equal(decoded.error.code, "DECODED_RESPONSE_TOO_LARGE");
  } finally {
    await client.close();
    await closeServer(server);
  }
});

test("distinguishes response-header and body-inactivity deadlines", async () => {
  const server = await listen(
    http.createServer((request, response) => {
      if (request.url === "/headers") {
        setTimeout(() => response.end("late"), 200);
        return;
      }
      response.writeHead(200);
      response.flushHeaders();
      response.write("first");
      setTimeout(() => response.end("late"), 200);
    }),
  );
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
    timeouts: {
      totalMs: 1_000,
      responseHeadersMs: 20,
      responseBodyProgressMs: 50,
    },
  });
  try {
    const headers = await client.request(urlFor(server, "/headers"));
    assert.equal(headers.kind, "failure");
    assert.equal(headers.error.code, "RESPONSE_HEADERS_TIMEOUT");

    const body = await client.request(urlFor(server, "/body"));
    assert.equal(body.kind, "response");
    await assert.rejects(
      streamText(body.body),
      (caught) =>
        caught instanceof HttpClientError &&
        caught.code === "RESPONSE_BODY_TIMEOUT",
    );
    const completion = await body.completion;
    assert.equal(completion.kind, "failure");
    assert.equal(completion.error.code, "RESPONSE_BODY_TIMEOUT");
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});

test("propagates caller cancellation through a live response", async () => {
  const server = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      response.write("first");
    }),
  );
  const controller = new AbortController();
  const client = new NodeHttpClient({
    networkSafety: { allowLocalhost: true },
  });
  try {
    const result = await client.request(urlFor(server), {
      signal: controller.signal,
    });
    assert.equal(result.kind, "response");
    controller.abort(new Error("consumer cancelled"));
    await assert.rejects(
      streamText(result.body),
      (caught) =>
        caught instanceof HttpClientError &&
        caught.code === "REQUEST_ABORTED",
    );
    const completion = await result.completion;
    assert.equal(completion.kind, "failure");
    assert.equal(completion.error.code, "REQUEST_ABORTED");
  } finally {
    await client.destroy();
    await closeServer(server);
  }
});
