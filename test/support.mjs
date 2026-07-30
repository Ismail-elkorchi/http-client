import assert from "node:assert/strict";
import fs from "node:fs/promises";

export async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server;
}

export async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

export function portOf(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return address.port;
}

export function urlFor(server, pathname = "/") {
  const scheme =
    server.constructor.name === "Http2SecureServer" ? "https" : "http";
  return `${scheme}://127.0.0.1:${String(portOf(server))}${pathname}`;
}

export async function streamBytes(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function streamText(stream) {
  return new TextDecoder().decode(await streamBytes(stream));
}

export async function tlsFixture() {
  return {
    cert: await fs.readFile(
      new URL("fixtures/localhost-cert.pem", import.meta.url),
    ),
    key: await fs.readFile(
      new URL("fixtures/localhost-key.pem", import.meta.url),
    ),
  };
}
