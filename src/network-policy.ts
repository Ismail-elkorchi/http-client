import dns from "node:dns/promises";
import { isIP } from "node:net";
import { awaitWithSignal } from "./deadlines.js";
import { HttpConfigurationError } from "./errors.js";
import { decideIp } from "./ip-policy.js";
import type {
  NetworkAddress,
  NetworkResolution,
  NetworkResolver,
  NetworkSafetyOptions,
} from "./types.js";

export class NetworkSafetyPolicy {
  private readonly options: NetworkSafetyOptions;
  private readonly resolver: NetworkResolver;
  private readonly cache = new Map<string, CachedResolution>();
  private readonly resolutions = new Map<string, Promise<NetworkResolution>>();
  private readonly lifecycle = new AbortController();
  private closed = false;

  public constructor(
    options: NetworkSafetyOptions,
    resolver: NetworkResolver = defaultResolver,
  ) {
    validateOptions(options);
    if (typeof resolver !== "function") {
      throw new HttpConfigurationError(
        "Network resolver must be a function.",
      );
    }
    this.options = options;
    this.resolver = resolver;
  }

  public async resolveHostname(
    hostname: string,
    signal?: AbortSignal,
  ): Promise<NetworkResolution> {
    if (this.closed) {
      throw new Error("Network safety policy is closed.");
    }
    signal?.throwIfAborted();
    const normalized = normalizeHostname(hostname);
    const literalFamily = isIP(normalized);
    if (literalFamily !== 0) {
      return evaluateNetworkAddresses(
        normalized,
        [{ address: normalized, family: literalFamily === 6 ? 6 : 4 }],
        this.options,
      );
    }

    const cached = this.cache.get(normalized);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) {
        this.cache.delete(normalized);
        this.cache.set(normalized, cached);
        return cached.resolution;
      }
      this.cache.delete(normalized);
    }

    const existing = this.resolutions.get(normalized);
    if (existing !== undefined) return await withAbort(existing, signal);
    const operation = this.resolveUncached(normalized);
    this.resolutions.set(normalized, operation);
    void operation.then(() => {
      if (this.resolutions.get(normalized) === operation) {
        this.resolutions.delete(normalized);
      }
    }, () => {
      if (this.resolutions.get(normalized) === operation) {
        this.resolutions.delete(normalized);
      }
    });
    return await withAbort(operation, signal);
  }

  public close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.lifecycle.abort(reason);
  }

  private async resolveUncached(
    normalized: string,
  ): Promise<NetworkResolution> {
    let resolution: NetworkResolution;
    try {
      const addresses = await withTimeout(
        (signal) => this.resolver(normalized, signal),
        this.options.dnsTimeoutMs,
        this.lifecycle.signal,
      );
      validateResolvedAddresses(addresses);
      resolution =
        addresses.length === 0
          ? rejected(
              normalized,
              "DNS lookup returned no addresses",
              "dns",
              [],
              [],
            )
          : evaluateNetworkAddresses(normalized, addresses, this.options);
    } catch (caught) {
      if (caught instanceof HttpConfigurationError) throw caught;
      resolution = rejected(
        normalized,
        caught instanceof DnsTimeoutError
          ? "DNS lookup timed out"
          : "DNS lookup failed",
        "dns",
        [],
        [],
      );
    }
    if (!this.closed) this.cacheResolution(normalized, resolution);
    return resolution;
  }

  public async decide(url: string): Promise<NetworkResolution["decision"]> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        allowed: false,
        reason: "Invalid URL",
        checkedIp: null,
        rejectionKind: "policy",
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        allowed: false,
        reason: `Unsupported protocol: ${parsed.protocol}`,
        checkedIp: null,
        rejectionKind: "policy",
      };
    }
    return (await this.resolveHostname(parsed.hostname)).decision;
  }

  private cacheResolution(
    hostname: string,
    resolution: NetworkResolution,
  ): void {
    if (this.options.dnsCacheTtlMs === 0) return;
    while (this.cache.size >= this.options.maxDnsCacheEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(hostname, {
      resolution,
      expiresAt: Date.now() + this.options.dnsCacheTtlMs,
    });
  }
}

interface CachedResolution {
  readonly resolution: NetworkResolution;
  readonly expiresAt: number;
}

export function evaluateNetworkAddresses(
  hostname: string,
  addresses: readonly NetworkAddress[],
  options: NetworkSafetyOptions,
): NetworkResolution {
  validateOptions(options);
  if (typeof hostname !== "string" || hostname.length === 0) {
    throw new HttpConfigurationError(
      "Network hostname must be a non-empty string.",
    );
  }
  validateResolvedAddresses(addresses);
  const normalized = deduplicateAddresses(addresses);
  if (normalized.length === 0) {
    return rejected(
      hostname,
      "DNS lookup returned no addresses",
      "dns",
      [],
      [],
    );
  }
  if (!options.enabled) {
    return {
      decision: {
        allowed: true,
        reason: null,
        checkedIp: normalized[0]?.address ?? null,
        rejectionKind: null,
      },
      hostname,
      addresses: normalized,
      rejectedAddresses: [],
    };
  }

  const approved: NetworkAddress[] = [];
  const rejectedAddresses: NetworkAddress[] = [];
  for (const address of normalized) {
    if (decideIp(address.address, options).allowed) approved.push(address);
    else rejectedAddresses.push(address);
  }
  if (
    options.mixedAddressPolicy === "reject-host" &&
    rejectedAddresses.length > 0
  ) {
    return rejected(
      hostname,
      "Hostname resolved to a blocked network address",
      "policy",
      approved,
      rejectedAddresses,
    );
  }
  if (approved.length === 0) {
    return rejected(
      hostname,
      "Hostname has no approved network addresses",
      "policy",
      [],
      rejectedAddresses,
    );
  }
  return {
    decision: {
      allowed: true,
      reason: null,
      checkedIp: approved[0]?.address ?? null,
      rejectionKind: null,
    },
    hostname,
    addresses: approved,
    rejectedAddresses,
  };
}

function rejected(
  hostname: string,
  reason: string,
  rejectionKind: "dns" | "policy",
  addresses: readonly NetworkAddress[],
  rejectedAddresses: readonly NetworkAddress[],
): NetworkResolution {
  return {
    decision: {
      allowed: false,
      reason,
      checkedIp: rejectedAddresses[0]?.address ?? null,
      rejectionKind,
    },
    hostname,
    addresses,
    rejectedAddresses,
  };
}

function deduplicateAddresses(
  addresses: readonly NetworkAddress[],
): readonly NetworkAddress[] {
  const seen = new Set<string>();
  const result: NetworkAddress[] = [];
  for (const address of addresses) {
    if (
      (address.family !== 4 && address.family !== 6) ||
      isIP(address.address) !== address.family
    ) {
      continue;
    }
    const key = `${String(address.family)}:${address.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

function normalizeHostname(hostname: string): string {
  if (typeof hostname !== "string" || hostname.length === 0) {
    throw new HttpConfigurationError(
      "Network hostname must be a non-empty string.",
    );
  }
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return normalized.toLowerCase();
}

async function defaultResolver(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly NetworkAddress[]> {
  signal.throwIfAborted();
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record): NetworkAddress => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
}

class DnsTimeoutError extends Error {
  public override readonly name = "DnsTimeoutError";
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new DnsTimeoutError("DNS lookup timed out"));
  }, ms);
  try {
    return await awaitWithSignal(
      Promise.resolve().then(() => operation(controller.signal)),
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return await promise;
  signal.throwIfAborted();
  let removeListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("DNS resolution was aborted.", {
              cause: signal.reason,
            }),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    removeListener = () => {
      signal.removeEventListener("abort", abort);
    };
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeListener();
  }
}

function validateOptions(options: NetworkSafetyOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new HttpConfigurationError(
      "Network safety options must be an object.",
    );
  }
  for (const [name, value] of [
    ["enabled", options.enabled],
    ["allowPrivateNetworks", options.allowPrivateNetworks],
    ["allowLocalhost", options.allowLocalhost],
  ] as const) {
    if (typeof value !== "boolean") {
      throw new HttpConfigurationError(`${name} must be a boolean.`);
    }
  }
  if (
    options.mixedAddressPolicy !== "reject-host" &&
    options.mixedAddressPolicy !== "use-safe-addresses-only"
  ) {
    throw new HttpConfigurationError(
      "mixedAddressPolicy is invalid.",
    );
  }
  for (const [name, value] of [
    ["dnsTimeoutMs", options.dnsTimeoutMs],
    ["dnsCacheTtlMs", options.dnsCacheTtlMs],
    ["maxDnsCacheEntries", options.maxDnsCacheEntries],
    ["addressAttemptDelayMs", options.addressAttemptDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === "dnsCacheTtlMs" ? 0 : 1)) {
      throw new HttpConfigurationError(
        `${name} must be a valid non-negative integer.`,
      );
    }
  }
}

function validateResolvedAddresses(
  addresses: readonly NetworkAddress[],
): void {
  const candidate: unknown = addresses;
  if (!isNetworkAddressArray(candidate)) {
    throw new HttpConfigurationError(
      "A network resolver must return valid IP address records.",
    );
  }
}

function isNetworkAddressArray(
  value: unknown,
): value is readonly NetworkAddress[] {
  return Array.isArray(value) && value.every(isNetworkAddress);
}

function isNetworkAddress(value: unknown): value is NetworkAddress {
  if (
    typeof value !== "object" ||
    value === null ||
    !("address" in value) ||
    !("family" in value)
  ) {
    return false;
  }
  return (
    typeof value.address === "string" &&
    (value.family === 4 || value.family === 6) &&
    isIP(value.address) === value.family
  );
}
