import type { LookupFunction } from "node:net";
import { Agent, buildConnector, request, type Dispatcher } from "undici";
import { observeConnection } from "./connection-observer.js";
import type { ConnectionFacts } from "./connection-observer.js";
import type { NetworkSafetyPolicy } from "./network-policy.js";
import type {
  HttpClientOptions,
  HttpMethod,
  NetworkResolution,
} from "./types.js";

export interface TransportResponse {
  readonly statusCode: number;
  readonly headers: Dispatcher.ResponseData["headers"];
  readonly body: Dispatcher.ResponseData["body"];
  readonly facts: ConnectionFacts;
  readonly dnsMs: number;
}

export class UndiciTransport {
  private readonly agent: Agent;
  private readonly policy: NetworkSafetyPolicy;
  private readonly options: HttpClientOptions;

  public constructor(
    options: HttpClientOptions,
    policy: NetworkSafetyPolicy,
  ) {
    this.options = options;
    this.policy = policy;
    const allowH2 = options.protocolPreference !== "http1";
    this.agent = new Agent({
      allowH2,
      connections: options.maxConnectionsPerOrigin,
      maxOrigins: options.maxOrigins,
      connectTimeout: options.connectTimeoutMs,
      headersTimeout: options.firstByteTimeoutMs,
      bodyTimeout: options.requestTimeoutMs,
      connect: buildConnector({
        allowH2,
        preferH2: allowH2,
        timeout: options.connectTimeoutMs,
        rejectUnauthorized: options.rejectUnauthorized,
        lookup: this.pinnedLookup(),
      }),
    });
  }

  public async request(
    url: URL,
    method: HttpMethod,
    headers: Readonly<Record<string, string>>,
    body: string | Uint8Array | undefined,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    const dnsStartedAt = performance.now();
    const resolution = await this.policy.resolveHostname(url.hostname);
    const dnsMs = performance.now() - dnsStartedAt;
    if (!resolution.decision.allowed) {
      throw new NetworkSafetyError(resolution);
    }
    const observed = await observeConnection(async () =>
      request(url, {
        dispatcher: this.agent,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        headersTimeout: this.options.firstByteTimeoutMs,
        bodyTimeout: this.options.requestTimeoutMs,
        signal,
      }),
    );
    if (
      this.options.protocolPreference === "http2" &&
      observed.facts.protocol !== "h2"
    ) {
      observed.value.body.on("error", ignoreError);
      observed.value.body.destroy();
      throw new ProtocolMismatchError();
    }
    return {
      statusCode: observed.value.statusCode,
      headers: observed.value.headers,
      body: observed.value.body,
      facts: observed.facts,
      dnsMs,
    };
  }

  public async close(): Promise<void> {
    await this.agent.close();
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

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("DNS lookup failed.");
}

function ignoreError(): undefined {
  return undefined;
}
