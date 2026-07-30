import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type { NegotiatedProtocol, TlsFacts } from "./types.js";

export interface ConnectionFacts {
  readonly remoteAddress: string | null;
  readonly protocol: NegotiatedProtocol;
  readonly tls: TlsFacts | null;
}

interface Observation {
  socket: Socket | null;
}

const observations = new AsyncLocalStorage<Observation>();
const requests = new WeakMap<object, Observation>();

channel("undici:request:create").subscribe((message: unknown) => {
  const request = objectProperty(message, "request");
  const observation = observations.getStore();
  if (request !== null && observation !== undefined) {
    requests.set(request, observation);
  }
});

channel("undici:client:sendHeaders").subscribe((message: unknown) => {
  const request = objectProperty(message, "request");
  const socket = objectProperty(message, "socket");
  if (request === null || !isSocket(socket)) return;
  const observation = requests.get(request);
  if (observation !== undefined) observation.socket = socket;
});

export async function observeConnection<T>(
  operation: () => Promise<T>,
): Promise<{ readonly value: T; readonly facts: ConnectionFacts }> {
  const observation: Observation = { socket: null };
  const value = await observations.run(observation, operation);
  return { value, facts: factsFromSocket(observation.socket) };
}

function factsFromSocket(socket: Socket | null): ConnectionFacts {
  if (socket === null) {
    return { remoteAddress: null, protocol: "unknown", tls: null };
  }
  if (socket instanceof TLSSocket) {
    const certificate = socket.getPeerCertificate();
    const cipher = socket.getCipher();
    return {
      remoteAddress: socket.remoteAddress ?? null,
      protocol: socket.alpnProtocol === "h2" ? "h2" : "http/1.1",
      tls: {
        protocol: socket.getProtocol(),
        cipher: cipher.standardName ?? cipher.name ?? null,
        authorized: socket.authorized,
        authorizationError:
          typeof socket.authorizationError === "string"
            ? socket.authorizationError
            : null,
        certificateValidTo:
          typeof certificate.valid_to === "string"
            ? certificate.valid_to
            : null,
      },
    };
  }
  return {
    remoteAddress: socket.remoteAddress ?? null,
    protocol: "http/1.1",
    tls: null,
  };
}

function objectProperty(
  value: unknown,
  name: "request" | "socket",
): object | null {
  if (typeof value !== "object" || value === null) return null;
  const property =
    name === "request"
      ? ("request" in value ? value.request : null)
      : ("socket" in value ? value.socket : null);
  return typeof property === "object" && property !== null
    ? property
    : null;
}

function isSocket(value: object | null): value is Socket {
  return (
    value !== null &&
    "remoteAddress" in value &&
    "destroy" in value &&
    typeof value.destroy === "function"
  );
}
