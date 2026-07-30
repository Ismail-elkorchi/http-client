import type { LookupFunction } from "node:net";
import {
  buildConnector,
  Pool,
  ProxyAgent,
  request,
  type Dispatcher,
} from "undici";
import {
  observeRequest,
  recordConnectionDuration,
} from "./connection-observer.js";
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
  readonly headers: Readonly<Record<string, string>>;
  readonly createBody: () => TransportRequestBody | undefined;
  readonly signal: AbortSignal;
  readonly responseHeadersTimeoutMs: number;
  readonly responseBodyInactivityTimeoutMs: number;
  readonly onInformationalResponse:
    | ((statusCode: number, headers: Headers) => void)
    | undefined;
}

export interface TransportResponse {
  readonly statusCode: number;
  readonly statusMessage: string | null;
  readonly headers: Headers;
  readonly body: Dispatcher.ResponseData["body"];
  readonly trailers: Readonly<Record<string, string>>;
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
      const observed = await observeRequest(
        {
          origin: url.origin,
          path: `${url.pathname}${url.search}`,
          method: options.method,
        },
        async () =>
          await request(url, {
            dispatcher: state.dispatcher,
            method: options.method,
            headers: options.headers,
            ...(body === undefined ? {} : { body }),
            headersTimeout: options.responseHeadersTimeoutMs,
            bodyTimeout: options.responseBodyInactivityTimeoutMs,
            ...(options.onInformationalResponse === undefined
              ? {}
              : {
                  onInfo: ({ statusCode, headers }) => {
                    options.onInformationalResponse?.(
                      statusCode,
                      headersFromIncoming(headers),
                    );
                  },
                }),
            signal: options.signal,
          }),
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
      if (
        this.options.protocolPreference === "http2" &&
        connection.httpVersion !== "http/2"
      ) {
        observed.value.body.on("error", ignoreFailure);
        observed.value.body.destroy();
        throw new ProtocolMismatchError();
      }
      return {
        statusCode: observed.value.statusCode,
        statusMessage: observed.statusMessage,
        headers: headersFromIncoming(observed.value.headers),
        body: observed.value.body,
        trailers: observed.value.trailers,
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
    await Promise.all(
      dispatchers.map(async (dispatcher) => {
        await dispatcher.close();
      }),
    );
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
    await Promise.all(
      dispatchers.map(async (dispatcher) => {
        await dispatcher.destroy(reason ?? null);
      }),
    );
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
        headers: this.options.proxy.headers,
        allowH2: this.options.protocolPreference !== "http1",
        connections: this.options.maxConnectionsPerOrigin,
        maxHeaderSize: this.options.maxResponseHeadersBytes,
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
    return new Pool(origin, {
      allowH2,
      connections: this.options.maxConnectionsPerOrigin,
      maxHeaderSize: this.options.maxResponseHeadersBytes,
      connectTimeout: this.options.timeouts.connectMs,
      strictContentLength: true,
      connect: timedConnector(
        buildConnector(
          connectorOptions(
            this.options.tls,
            this.options,
            this.pinnedLookup(),
          ),
        ),
      ),
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

  public constructor() {
    super("The server did not negotiate HTTP/2.");
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

function headersFromIncoming(
  source: Dispatcher.ResponseData["headers"],
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
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

function ignoreFailure(): undefined {
  return undefined;
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
): buildConnector.connector {
  return (options, callback): void => {
    const startedAt = performance.now();
    connector(options, (error, socket) => {
      if (socket !== null && socket !== undefined) {
        recordConnectionDuration(socket, performance.now() - startedAt);
      }
      if (error !== null) {
        callback(error, null);
      } else {
        callback(null, socket);
      }
    });
  };
}
