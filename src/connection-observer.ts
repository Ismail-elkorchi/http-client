import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type {
  ConnectionFacts,
  HttpVersion,
  PeerCertificateFacts,
  TlsFacts,
} from "./types.js";

interface Observation {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
  socket: Socket | null;
  requestBodyBytesSent: number;
  statusMessage: string | null;
}

export interface ObservedRequest<T> {
  readonly value: T;
  readonly facts: ConnectionFacts;
  readonly requestBodyBytesSent: () => number;
  readonly statusMessage: string | null;
}

const observations = new AsyncLocalStorage<Observation>();
const requests = new WeakMap<object, Observation>();
const pendingObservations = new Set<Observation>();
const connectionDurations = new WeakMap<Socket, number>();
const usedConnections = new WeakSet<Socket>();

channel("undici:request:create").subscribe((message: unknown) => {
  const request = objectProperty(message, "request");
  const current = observations.getStore();
  const observation =
    current !== undefined && pendingObservations.has(current)
      ? current
      : request === null
        ? undefined
        : matchingObservation(request);
  if (request !== null && observation !== undefined) {
    requests.set(request, observation);
    pendingObservations.delete(observation);
  }
});

channel("undici:request:bodyChunkSent").subscribe((message: unknown) => {
  const request = objectProperty(message, "request");
  if (request === null) return;
  const observation = requests.get(request);
  if (observation === undefined) return;
  const chunk = unknownProperty(message, "chunk");
  if (typeof chunk === "string") {
    observation.requestBodyBytesSent += Buffer.byteLength(chunk);
  } else if (chunk instanceof Uint8Array) {
    observation.requestBodyBytesSent += chunk.byteLength;
  }
});

channel("undici:request:headers").subscribe((message: unknown) => {
  const request = objectProperty(message, "request");
  if (request === null) return;
  const observation = requests.get(request);
  if (observation === undefined) return;
  const response = unknownProperty(message, "response");
  const statusMessage = stringProperty(response, "statusText");
  observation.statusMessage =
    statusMessage === null || statusMessage.length === 0
      ? null
      : statusMessage;
});

channel("undici:client:sendHeaders").subscribe((message: unknown) => {
  const request = objectProperty(message, "request");
  const socket = objectProperty(message, "socket");
  if (request === null || !isSocket(socket)) return;
  const observation = requests.get(request);
  if (observation !== undefined) observation.socket = socket;
});

export async function observeRequest<T>(
  context: {
    readonly origin: string;
    readonly path: string;
    readonly method: string;
  },
  operation: () => Promise<T>,
): Promise<ObservedRequest<T>> {
  const observation: Observation = {
    ...context,
    socket: null,
    requestBodyBytesSent: 0,
    statusMessage: null,
  };
  pendingObservations.add(observation);
  let value: T;
  try {
    value = await observations.run(observation, operation);
  } finally {
    pendingObservations.delete(observation);
  }
  return {
    value,
    facts: factsFromSocket(observation.socket),
    requestBodyBytesSent: () => observation.requestBodyBytesSent,
    statusMessage: observation.statusMessage,
  };
}

function matchingObservation(request: object): Observation | undefined {
  const origin = unknownProperty(request, "origin");
  const path = unknownProperty(request, "path");
  const method = unknownProperty(request, "method");
  const normalizedOrigin =
    origin instanceof URL
      ? origin.origin
      : typeof origin === "string"
        ? new URL(origin).origin
        : null;
  if (
    normalizedOrigin === null ||
    typeof path !== "string" ||
    typeof method !== "string"
  ) {
    return undefined;
  }
  return [...pendingObservations].find(
    (observation) =>
      observation.origin === normalizedOrigin &&
      observation.path === path &&
      observation.method === method,
  );
}

export function recordConnectionDuration(
  socket: Socket,
  durationMs: number,
): void {
  connectionDurations.set(socket, durationMs);
}

function factsFromSocket(socket: Socket | null): ConnectionFacts {
  if (socket === null) {
    return {
      socketRemoteAddress: null,
      socketRemotePort: null,
      socketAddressFamily: null,
      establishmentMs: null,
      connectionReused: null,
      httpVersion: null,
      tls: null,
      proxyUrl: null,
    };
  }
  const connectionReused = usedConnections.has(socket);
  usedConnections.add(socket);
  const tls = socket instanceof TLSSocket ? tlsFacts(socket) : null;
  return {
    socketRemoteAddress: socket.remoteAddress ?? null,
    socketRemotePort: socket.remotePort ?? null,
    socketAddressFamily: addressFamily(socket.remoteFamily),
    establishmentMs: connectionDurations.get(socket) ?? null,
    connectionReused,
    httpVersion: negotiatedVersion(socket),
    tls,
    proxyUrl: null,
  };
}

function negotiatedVersion(socket: Socket): HttpVersion {
  return socket instanceof TLSSocket && socket.alpnProtocol === "h2"
    ? "http/2"
    : "http/1.1";
}

function tlsFacts(socket: TLSSocket): TlsFacts {
  const certificate = socket.getPeerCertificate();
  const cipher = socket.getCipher();
  return {
    version: socket.getProtocol(),
    cipher: cipher.standardName ?? cipher.name ?? null,
    authorized: socket.authorized,
    authorizationError:
      typeof socket.authorizationError === "string"
        ? socket.authorizationError
        : null,
    serverName: stringProperty(socket, "servername"),
    peerCertificate: peerCertificate(certificate),
  };
}

function peerCertificate(
  certificate: ReturnType<TLSSocket["getPeerCertificate"]>,
): PeerCertificateFacts | null {
  if (Object.keys(certificate).length === 0) return null;
  return {
    subject: stringRecord(certificate.subject),
    issuer: stringRecord(certificate.issuer),
    subjectAlternativeName:
      typeof certificate.subjectaltname === "string"
        ? certificate.subjectaltname
        : null,
    validFrom:
      typeof certificate.valid_from === "string"
        ? certificate.valid_from
        : null,
    validTo:
      typeof certificate.valid_to === "string" ? certificate.valid_to : null,
    fingerprintSha256:
      typeof certificate.fingerprint256 === "string"
        ? certificate.fingerprint256
        : null,
    serialNumber:
      typeof certificate.serialNumber === "string"
        ? certificate.serialNumber
        : null,
  };
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return {};
  const entries: [string, string][] = [];
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string") entries.push([name, item]);
  }
  return Object.fromEntries(entries);
}

function addressFamily(value: string | undefined): 4 | 6 | null {
  if (value === "IPv4") return 4;
  if (value === "IPv6") return 6;
  return null;
}

function objectProperty(
  value: unknown,
  name: "request" | "socket",
): object | null {
  const property = unknownProperty(value, name);
  return typeof property === "object" && property !== null ? property : null;
}

function unknownProperty(value: unknown, name: string): unknown {
  if (!hasUnknownProperty(value, name)) {
    return null;
  }
  return value[name];
}

function hasUnknownProperty(
  value: unknown,
  name: string,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && name in value;
}

function stringProperty(value: unknown, name: string): string | null {
  const property = unknownProperty(value, name);
  return typeof property === "string" ? property : null;
}

function isSocket(value: object | null): value is Socket {
  return (
    value !== null &&
    "remoteAddress" in value &&
    "destroy" in value &&
    typeof value.destroy === "function"
  );
}
