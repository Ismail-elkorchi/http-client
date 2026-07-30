import {
  connect as connectTcp,
  isIP,
  type LookupFunction,
  type Socket,
} from "node:net";
import tls from "node:tls";
import type { TLSSocket } from "node:tls";
import {
  buildConnector,
  errors as undiciErrors,
  Pool,
  ProxyAgent,
  request,
  type Dispatcher,
} from "undici";
import {
  UndiciConnectionObserver,
} from "./connection-observer.js";
import {
  httpFieldsFromRaw,
  httpFieldsToFlatArray,
  httpFieldsToRecord,
} from "./fields.js";
import type { HttpFields } from "./fields.js";
import type { NetworkSafetyPolicy } from "./network-policy.js";
import type { TransportRequestBody } from "./request-body.js";
import type {
  ConnectionFacts,
  HttpClientOptions,
  HttpMethod,
  NetworkResolution,
  TlsMaterial,
  TlsOptions,
} from "./types.js";

export interface TransportRequestOptions {
  readonly method: HttpMethod;
  readonly fields: HttpFields;
  readonly createBody: () => TransportRequestBody | undefined;
  readonly signal: AbortSignal;
  readonly responseFieldsTimeoutMs: number;
  readonly onInformationalResponse:
    | ((statusCode: number, fields: HttpFields) => void)
    | undefined;
  readonly onRequestBodyProgress: (sentBytes: number) => void;
}

export interface TransportResponse {
  readonly statusCode: number;
  readonly statusMessage: string | null;
  readonly fields: HttpFields;
  readonly body: Dispatcher.ResponseData["body"];
  readonly trailers: () => HttpFields;
  readonly connection: ConnectionFacts;
  readonly dnsMs: number | null;
  readonly requestBodyBytesSent: () => number;
}

interface OriginDispatcher {
  readonly dispatcher: Dispatcher;
  activeResponses: number;
  lastUsed: number;
}

export class UndiciTransport {
  private readonly policy: NetworkSafetyPolicy;
  private readonly options: HttpClientOptions;
  private readonly origins = new Map<string, OriginDispatcher>();
  private readonly observer = new UndiciConnectionObserver();
  private acquisitions: Promise<void> = Promise.resolve();
  private useCounter = 0;
  private closed = false;

  public constructor(
    options: HttpClientOptions,
    policy: NetworkSafetyPolicy,
  ) {
    this.options = options;
    this.policy = policy;
  }

  public async request(
    url: URL,
    options: TransportRequestOptions,
  ): Promise<TransportResponse> {
    if (this.closed) {
      throw new TransportClosedError();
    }
    if (
      this.options.protocolPreference === "http2" &&
      url.protocol !== "https:"
    ) {
      throw new ProtocolMismatchError(
        "Strict HTTP/2 requires a TLS origin.",
      );
    }
    const dnsStartedAt =
      this.options.proxy === null ? performance.now() : null;
    if (this.options.proxy === null) {
      const resolution = await this.policy.resolveHostname(
        url.hostname,
        options.signal,
      );
      if (!resolution.decision.allowed) {
        throw new NetworkSafetyError(resolution);
      }
    }
    const dnsMs =
      dnsStartedAt === null ? null : performance.now() - dnsStartedAt;
    const origin = url.origin;
    const state = await this.acquire(origin);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeResponses -= 1;
    };

    try {
      const body = options.createBody();
      const observed = await this.observer.observeRequest(
        {
          origin: url.origin,
          path: `${url.pathname}${url.search}`,
          method: options.method,
        },
        async () =>
          await request(url, {
            dispatcher: state.dispatcher,
            method: options.method,
            headers: httpFieldsToFlatArray(options.fields),
            responseHeaders: "raw",
            ...(body === undefined ? {} : { body }),
            headersTimeout: options.responseFieldsTimeoutMs,
            bodyTimeout: 0,
            ...(options.onInformationalResponse === undefined
              ? {}
              : {
                  onInfo: ({ statusCode, headers }) => {
                    options.onInformationalResponse?.(
                      statusCode,
                      rawResponseFields(headers),
                    );
                  },
                }),
            signal: options.signal,
          }),
        options.onRequestBodyProgress,
      );
      releaseWhenFinished(observed.value.body, release);
      const proxyUrl =
        this.options.proxy === null
          ? null
          : redactedProxyUrl(this.options.proxy.url);
      const connection = {
        ...observed.facts,
        proxyUrl,
      };
      return {
        statusCode: observed.value.statusCode,
        statusMessage: normalizedStatusMessage(observed.value.statusText),
        fields: rawResponseFields(observed.value.headers),
        body: observed.value.body,
        trailers: () => httpFieldsFromRaw(observed.rawTrailers()),
        connection,
        dnsMs,
        requestBodyBytesSent: observed.requestBodyBytesSent,
      };
    } catch (caught) {
      release();
      throw caught;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.policy.close();
    await this.acquisitions;
    const dispatchers = [...this.origins.values()].map(
      ({ dispatcher }) => dispatcher,
    );
    this.origins.clear();
    try {
      await Promise.all(
        dispatchers.map(async (dispatcher) => {
          await dispatcher.close();
        }),
      );
    } finally {
      this.observer.close();
    }
  }

  public async destroy(reason?: Error): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.policy.close(reason);
    await this.acquisitions;
    const dispatchers = [...this.origins.values()].map(
      ({ dispatcher }) => dispatcher,
    );
    this.origins.clear();
    try {
      await Promise.all(
        dispatchers.map(async (dispatcher) => {
          await dispatcher.destroy(reason ?? null);
        }),
      );
    } finally {
      this.observer.close();
    }
  }

  private async acquire(origin: string): Promise<OriginDispatcher> {
    const pending = this.acquisitions.then(async () =>
      await this.acquireExclusive(origin),
    );
    this.acquisitions = pending.then(ignoreResult, ignoreResult);
    return await pending;
  }

  private async acquireExclusive(origin: string): Promise<OriginDispatcher> {
    if (this.closed) throw new TransportClosedError();
    const existing = this.origins.get(origin);
    if (existing !== undefined) {
      existing.lastUsed = ++this.useCounter;
      existing.activeResponses += 1;
      return existing;
    }
    if (this.origins.size >= this.options.maxOrigins) {
      const eviction = [...this.origins.entries()]
        .filter(([, state]) => state.activeResponses === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (eviction === undefined) {
        throw new OriginCapacityError(this.options.maxOrigins);
      }
      this.origins.delete(eviction[0]);
      await eviction[1].dispatcher.close();
    }
    if (this.closed) throw new TransportClosedError();
    const state: OriginDispatcher = {
      dispatcher: this.createDispatcher(origin),
      activeResponses: 1,
      lastUsed: ++this.useCounter,
    };
    this.origins.set(origin, state);
    return state;
  }

  private createDispatcher(origin: string): Dispatcher {
    if (this.options.proxy !== null) {
      return new ProxyAgent({
        uri: this.options.proxy.url,
        headers: httpFieldsToRecord(this.options.proxy.fields),
        allowH2: this.options.protocolPreference !== "http1",
        connections: this.options.maxConnectionsPerOrigin,
        maxHeaderSize: this.options.maxResponseFieldsBytes,
        requestTls: connectorOptions(
          this.options.tls,
          this.options,
          undefined,
        ),
        proxyTls: connectorOptions(
          this.options.proxy.tls,
          this.options,
          undefined,
        ),
      });
    }
    const allowH2 = this.options.protocolPreference !== "http1";
    const lookup = this.pinnedLookup();
    const baseConnector =
      this.options.protocolPreference === "http2"
        ? timedConnector(
            strictHttp2Connector(
              this.options.tls,
              this.options,
              lookup,
            ),
            this.observer,
          )
        : timedConnector(
            buildConnector(
              connectorOptions(
                this.options.tls,
                this.options,
                lookup,
              ),
            ),
            this.observer,
          );
    return new Pool(origin, {
      allowH2,
      connections: this.options.maxConnectionsPerOrigin,
      maxHeaderSize: this.options.maxResponseFieldsBytes,
      connectTimeout: this.options.timeouts.connectMs,
      strictContentLength: true,
      connect: baseConnector,
    });
  }

  private pinnedLookup(): LookupFunction {
    return (hostname, lookupOptions, callback): void => {
      this.policy.resolveHostname(hostname).then(
        (resolution) => {
          if (!resolution.decision.allowed) {
            callback(new NetworkSafetyError(resolution), "", 0);
            return;
          }
          const family = lookupOptions.family;
          const addresses =
            family === 4 || family === 6
              ? resolution.addresses.filter(
                  (address) => address.family === family,
                )
              : resolution.addresses;
          if (addresses.length === 0) {
            callback(
              new Error("No approved address matches the requested family."),
              "",
              0,
            );
            return;
          }
          if (lookupOptions.all === true) {
            callback(null, addresses.map(({ address, family: itemFamily }) => ({
              address,
              family: itemFamily,
            })));
            return;
          }
          const selected = addresses[0];
          if (selected === undefined) {
            callback(new Error("No approved network address."), "", 0);
            return;
          }
          callback(null, selected.address, selected.family);
        },
        (caught: unknown) => {
          callback(toError(caught), "", 0);
        },
      );
    };
  }
}

export class NetworkSafetyError extends Error {
  public override readonly name = "NetworkSafetyError";
  public readonly resolution: NetworkResolution;

  public constructor(resolution: NetworkResolution) {
    super(resolution.decision.reason ?? "Network target was rejected.");
    this.resolution = resolution;
  }
}

export class ProtocolMismatchError extends Error {
  public override readonly name = "ProtocolMismatchError";

  public constructor(message = "The server did not negotiate HTTP/2.") {
    super(message);
  }
}

export class OriginCapacityError extends Error {
  public override readonly name = "OriginCapacityError";

  public constructor(limit: number) {
    super(
      `All ${String(limit)} retained origin dispatchers have active responses.`,
    );
  }
}

export class TransportClosedError extends Error {
  public override readonly name = "TransportClosedError";

  public constructor() {
    super("The HTTP client is closed.");
  }
}

function connectorOptions(
  tls: TlsOptions,
  client: HttpClientOptions,
  lookup: LookupFunction | undefined,
): buildConnector.BuildOptions {
  return normalizedConnectorOptions(tls, client, lookup);
}

function normalizedConnectorOptions(
  tls: TlsOptions,
  client: HttpClientOptions,
  lookup: LookupFunction | undefined,
): buildConnector.BuildOptions {
  return {
    allowH2: client.protocolPreference !== "http1",
    preferH2: client.protocolPreference !== "http1",
    timeout: client.timeouts.connectMs,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout:
      client.networkSafety.addressAttemptDelayMs,
    rejectUnauthorized: tls.rejectUnauthorized,
    ...(lookup === undefined ? {} : { lookup }),
    ...(tls.certificateAuthorities === undefined
      ? {}
      : { ca: tlsMaterial(tls.certificateAuthorities) }),
    ...(tls.clientCertificate === undefined
      ? {}
      : { cert: tlsMaterial(tls.clientCertificate) }),
    ...(tls.clientPrivateKey === undefined
      ? {}
      : { key: tlsMaterial(tls.clientPrivateKey) }),
    ...(tls.privateKeyPassphrase === undefined
      ? {}
      : { passphrase: tls.privateKeyPassphrase }),
    ...(tls.serverName === undefined ? {} : { servername: tls.serverName }),
    ...(tls.minimumVersion === undefined
      ? {}
      : { minVersion: tls.minimumVersion }),
    ...(tls.maximumVersion === undefined
      ? {}
      : { maxVersion: tls.maximumVersion }),
    ...(tls.ciphers === undefined ? {} : { ciphers: tls.ciphers }),
  };
}

function tlsMaterial(
  material: TlsMaterial,
): string | Buffer | (string | Buffer)[] {
  if (typeof material === "string") return material;
  if (material instanceof Uint8Array) return Buffer.from(material);
  return material.map((item) =>
    typeof item === "string" ? item : Buffer.from(item),
  );
}

function releaseWhenFinished(
  body: Dispatcher.ResponseData["body"],
  release: () => void,
): void {
  body.once("end", release);
  body.once("error", release);
  body.once("close", release);
  if (body.readableEnded || body.destroyed) release();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("DNS lookup failed.");
}

function ignoreResult(): void {}

function redactedProxyUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.href;
}

function timedConnector(
  connector: buildConnector.connector,
  observer: UndiciConnectionObserver,
): buildConnector.connector {
  return (options, callback): void => {
    const startedAt = performance.now();
    connector(options, (error, socket) => {
      if (socket !== null && socket !== undefined) {
        observer.recordConnectionDuration(socket, performance.now() - startedAt);
      }
      if (error !== null) {
        callback(error, null);
      } else {
        callback(null, socket);
      }
    });
  };
}

function strictHttp2Connector(
  configuredTls: TlsOptions,
  client: HttpClientOptions,
  lookup: LookupFunction,
): buildConnector.connector {
  const sessions = new Map<string, Buffer>();
  return (options, callback): void => {
    const serverName =
      options.servername ??
      configuredTls.serverName ??
      (isIpLiteral(options.hostname) ? undefined : options.hostname);
    const sessionKey = serverName ?? options.hostname;
    let settled = false;
    const finish = (
      error: Error | null,
      socket: TLSSocket | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null && socket !== null) {
        callback(null, socket);
      } else {
        callback(error ?? new Error("TLS connection failed."), null);
      }
    };
    const tlsConnectionOptions = {
      rejectUnauthorized: configuredTls.rejectUnauthorized,
      ...(configuredTls.certificateAuthorities === undefined
        ? {}
        : { ca: tlsMaterial(configuredTls.certificateAuthorities) }),
      ...(configuredTls.clientCertificate === undefined
        ? {}
        : { cert: tlsMaterial(configuredTls.clientCertificate) }),
      ...(configuredTls.clientPrivateKey === undefined
        ? {}
        : { key: tlsMaterial(configuredTls.clientPrivateKey) }),
      ...(configuredTls.privateKeyPassphrase === undefined
        ? {}
        : { passphrase: configuredTls.privateKeyPassphrase }),
      ...(configuredTls.minimumVersion === undefined
        ? {}
        : { minVersion: configuredTls.minimumVersion }),
      ...(configuredTls.maximumVersion === undefined
        ? {}
        : { maxVersion: configuredTls.maximumVersion }),
      ...(configuredTls.ciphers === undefined
        ? {}
        : { ciphers: configuredTls.ciphers }),
      ...(serverName === undefined ? {} : { servername: serverName }),
      ...(sessions.get(sessionKey) === undefined
        ? {}
        : { session: sessions.get(sessionKey) }),
      ALPNProtocols: ["h2"],
    };
    let activeSocket: Socket | TLSSocket;
    let socket: Socket;
    try {
      socket = connectTcp({
        host: options.hostname,
        port: Number(options.port || 443),
        localAddress: options.localAddress ?? undefined,
        lookup,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout:
          client.networkSafety.addressAttemptDelayMs,
      });
      activeSocket = socket;
    } catch (caught) {
      callback(toError(caught), null);
      return;
    }
    const timeoutError = new undiciErrors.ConnectTimeoutError();
    const timer = setTimeout(() => {
      activeSocket.destroy(timeoutError);
    }, client.timeouts.connectMs);
    const tcpFailure = (error: Error): void => {
      finish(normalizedTcpConnectionError(error), null);
    };
    socket.setKeepAlive(true, 60_000);
    socket.setNoDelay(true);
    socket.once("error", tcpFailure);
    socket.once("connect", () => {
      socket.off("error", tcpFailure);
      let secureSocket: TLSSocket;
      try {
        secureSocket = tls.connect({
          socket,
          ...tlsConnectionOptions,
        });
        activeSocket = secureSocket;
      } catch (caught) {
        const error = toError(caught);
        socket.destroy(error);
        finish(error, null);
        return;
      }
      secureSocket.on("session", (session) => {
        sessions.delete(sessionKey);
        sessions.set(sessionKey, session);
        if (sessions.size > 100) {
          const oldest = sessions.keys().next().value;
          if (oldest !== undefined) sessions.delete(oldest);
        }
      });
      secureSocket.once("secureConnect", () => {
        if (secureSocket.alpnProtocol !== "h2") {
          const error = new ProtocolMismatchError();
          secureSocket.destroy(error);
          finish(error, null);
          return;
        }
        finish(null, secureSocket);
      });
      secureSocket.on("error", (error: unknown) => {
        finish(
          isAlpnNegotiationFailure(error)
            ? new ProtocolMismatchError()
            : toError(error),
          null,
        );
      });
    });
  };
}

function rawResponseFields(value: unknown): HttpFields {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) => typeof item === "string" || item instanceof Uint8Array,
    )
  ) {
    throw new Error("The HTTP transport did not return raw field lines.");
  }
  return httpFieldsFromRaw(value);
}

function normalizedStatusMessage(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isIpLiteral(value: string): boolean {
  return isIP(value) !== 0;
}

function isAlpnNegotiationFailure(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL"
  );
}

function normalizedTcpConnectionError(error: Error): Error {
  if (
    error instanceof AggregateError &&
    error.errors.some(
      (item: unknown) => errorCode(item) === "ETIMEDOUT",
    )
  ) {
    const timeout = new undiciErrors.ConnectTimeoutError();
    timeout.cause = error;
    return timeout;
  }
  return error;
}

function errorCode(value: unknown): string | null {
  return (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      typeof value.code === "string"
    )
    ? value.code
    : null;
}
