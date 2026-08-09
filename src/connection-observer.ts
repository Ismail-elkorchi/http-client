import { AsyncLocalStorage } from "node:async_hooks";
import {
  channel,
  type Channel,
} from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { isDenseArray } from "./arrays.ts";
import type {
  ConnectionFacts,
  HttpVersion,
  PeerCertificateFacts,
  TlsFacts,
} from "./types.ts";

interface Observation {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
  socket: Socket | null;
  requestBodyBytesSent: number;
  rawTrailers: readonly (string | Uint8Array)[];
  readonly onRequestBodyProgress: (sentBytes: number) => void;
}

export interface ObservedRequest<T> {
  readonly value: T;
  readonly facts: ConnectionFacts;
  readonly requestBodyBytesSent: () => number;
  readonly rawTrailers: () => readonly (string | Uint8Array)[];
}

interface Subscription {
  readonly source: Channel;
  readonly listener: (message: unknown) => void;
}

export class UndiciConnectionObserver {
  #closed = false;

  public constructor() {
    diagnosticRouter.acquire();
  }

  public async observeRequest<T>(
    context: {
      readonly origin: string;
      readonly path: string;
      readonly method: string;
    },
    operation: () => Promise<T>,
    onRequestBodyProgress: (sentBytes: number) => void,
  ): Promise<ObservedRequest<T>> {
    if (this.#closed) {
      throw new Error("The transport observer is closed.");
    }
    return await diagnosticRouter.observeRequest(
      context,
      operation,
      onRequestBodyProgress,
    );
  }

  public recordConnectionDuration(
    socket: Socket,
    durationMs: number,
  ): void {
    diagnosticRouter.recordConnectionDuration(socket, durationMs);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    diagnosticRouter.release();
  }
}

class UndiciDiagnosticRouter {
  readonly #observations = new AsyncLocalStorage<Observation>();
  readonly #requests = new WeakMap<object, Observation>();
  readonly #pending = new Map<string, Observation[]>();
  readonly #connectionDurations = new WeakMap<Socket, number>();
  readonly #usedConnections = new WeakSet<Socket>();
  #subscriptions: readonly Subscription[] = [];
  #clients = 0;

  public acquire(): void {
    this.#clients += 1;
    if (this.#clients !== 1) return;
    this.#subscriptions = [
      this.subscribe("undici:request:create", this.requestCreated),
      this.subscribe(
        "undici:request:bodyChunkSent",
        this.requestBodyChunkSent,
      ),
      this.subscribe("undici:request:trailers", this.responseTrailersReceived),
      this.subscribe("undici:client:sendHeaders", this.requestFieldsSent),
    ];
  }

  public async observeRequest<T>(
    context: {
      readonly origin: string;
      readonly path: string;
      readonly method: string;
    },
    operation: () => Promise<T>,
    onRequestBodyProgress: (sentBytes: number) => void,
  ): Promise<ObservedRequest<T>> {
    const observation: Observation = {
      ...context,
      socket: null,
      requestBodyBytesSent: 0,
      rawTrailers: [],
      onRequestBodyProgress,
    };
    const key = observationKey(context);
    const queue = this.#pending.get(key) ?? [];
    queue.push(observation);
    this.#pending.set(key, queue);
    let value: T;
    try {
      value = await this.#observations.run(observation, operation);
    } finally {
      this.removePending(key, observation);
    }
    return {
      value,
      facts: this.factsFromSocket(observation.socket),
      requestBodyBytesSent: () => observation.requestBodyBytesSent,
      rawTrailers: () => observation.rawTrailers,
    };
  }

  public recordConnectionDuration(
    socket: Socket,
    durationMs: number,
  ): void {
    this.#connectionDurations.set(socket, durationMs);
  }

  public release(): void {
    if (this.#clients === 0) {
      throw new Error("The diagnostic router has no active client.");
    }
    this.#clients -= 1;
    if (this.#clients !== 0) return;
    for (const { source, listener } of this.#subscriptions) {
      source.unsubscribe(listener);
    }
    this.#subscriptions = [];
  }

  private readonly requestCreated = (message: unknown): void => {
    const request = objectProperty(message, "request");
    const current = this.#observations.getStore();
    const observation =
      current !== undefined && this.isPending(current)
        ? current
        : this.takeMatchingPending(request);
    if (request !== null && observation !== undefined) {
      this.#requests.set(request, observation);
      this.removePending(observationKey(observation), observation);
    }
  };

  private takeMatchingPending(request: object | null): Observation | undefined {
    if (request === null) return undefined;
    const context = requestObservationContext(request);
    if (context === null) return undefined;
    const exactKey = observationKey(context);
    const exactQueue = this.#pending.get(exactKey);
    const exact = exactQueue?.shift();
    if (exactQueue?.length === 0) this.#pending.delete(exactKey);
    if (exact !== undefined) return exact;
    for (const [key, queue] of this.#pending) {
      const index = queue.findIndex(
        (observation) =>
          observation.method === context.method &&
          (observation.path === context.path ||
            `${observation.origin}${observation.path}` === context.path),
      );
      if (index < 0) continue;
      const [observation] = queue.splice(index, 1);
      if (queue.length === 0) this.#pending.delete(key);
      return observation;
    }
    return undefined;
  }

  private removePending(key: string, observation: Observation): void {
    const queue = this.#pending.get(key);
    if (queue === undefined) return;
    const index = queue.indexOf(observation);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#pending.delete(key);
  }

  private isPending(observation: Observation): boolean {
    return (
      this.#pending
        .get(observationKey(observation))
        ?.includes(observation) === true
    );
  }

  private readonly requestBodyChunkSent = (message: unknown): void => {
    const observation = this.observationFor(message);
    if (observation === undefined) return;
    const chunk = unknownProperty(message, "chunk");
    if (typeof chunk === "string") {
      observation.requestBodyBytesSent += Buffer.byteLength(chunk);
    } else if (chunk instanceof Uint8Array) {
      observation.requestBodyBytesSent += chunk.byteLength;
    } else {
      return;
    }
    observation.onRequestBodyProgress(observation.requestBodyBytesSent);
  };

  private readonly responseTrailersReceived = (message: unknown): void => {
    const observation = this.observationFor(message);
    if (observation === undefined) return;
    const trailers = unknownProperty(message, "trailers");
    if (isRawFields(trailers)) observation.rawTrailers = trailers.slice();
  };

  private readonly requestFieldsSent = (message: unknown): void => {
    const observation = this.observationFor(message);
    const socket = objectProperty(message, "socket");
    if (observation !== undefined && isSocket(socket)) {
      observation.socket = socket;
    }
  };

  private subscribe(
    name: string,
    listener: (message: unknown) => void,
  ): Subscription {
    const source = channel(name);
    source.subscribe(listener);
    return { source, listener };
  }

  private observationFor(message: unknown): Observation | undefined {
    const request = objectProperty(message, "request");
    return request === null ? undefined : this.#requests.get(request);
  }

  private factsFromSocket(socket: Socket | null): ConnectionFacts {
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
    const connectionReused = this.#usedConnections.has(socket);
    this.#usedConnections.add(socket);
    const tls = socket instanceof TLSSocket ? tlsFacts(socket) : null;
    return {
      socketRemoteAddress: socket.remoteAddress ?? null,
      socketRemotePort: socket.remotePort ?? null,
      socketAddressFamily: addressFamily(socket.remoteFamily),
      establishmentMs: this.#connectionDurations.get(socket) ?? null,
      connectionReused,
      httpVersion: negotiatedVersion(socket),
      tls,
      proxyUrl: null,
    };
  }
}

const diagnosticRouter = new UndiciDiagnosticRouter();

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
  if (!hasUnknownProperty(value, name)) return null;
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

function isRawFields(
  value: unknown,
): value is readonly (string | Uint8Array)[] {
  return (
    Array.isArray(value) &&
    isDenseArray(value) &&
    value.every(
      (item) => typeof item === "string" || item instanceof Uint8Array,
    )
  );
}

function observationKey(context: {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
}): string {
  return `${context.method}\n${context.origin}\n${context.path}`;
}

function requestObservationContext(request: object): {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
} | null {
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
    return null;
  }
  return { origin: normalizedOrigin, path, method };
}
