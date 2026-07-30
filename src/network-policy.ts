import dns from "node:dns/promises";
import { isIP } from "node:net";
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

  public constructor(
    options: NetworkSafetyOptions,
    resolver: NetworkResolver = defaultResolver,
  ) {
    validateOptions(options);
    this.options = options;
    this.resolver = resolver;
  }

  public async resolveHostname(hostname: string): Promise<NetworkResolution> {
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

    let resolution: NetworkResolution;
    try {
      const addresses = await withTimeout(
        this.resolver(normalized),
        this.options.dnsTimeoutMs,
      );
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
    this.cacheResolution(normalized, resolution);
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
  const normalized = deduplicateAddresses(addresses);
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
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return normalized.toLowerCase();
}

async function defaultResolver(
  hostname: string,
): Promise<readonly NetworkAddress[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record): NetworkAddress => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
}

class DnsTimeoutError extends Error {
  public override readonly name = "DnsTimeoutError";
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DnsTimeoutError("DNS lookup timed out"));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function validateOptions(options: NetworkSafetyOptions): void {
  for (const [name, value] of [
    ["dnsTimeoutMs", options.dnsTimeoutMs],
    ["dnsCacheTtlMs", options.dnsCacheTtlMs],
    ["maxDnsCacheEntries", options.maxDnsCacheEntries],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (name === "dnsCacheTtlMs" ? 0 : 1)) {
      throw new TypeError(`${name} must be a valid non-negative integer.`);
    }
  }
}
