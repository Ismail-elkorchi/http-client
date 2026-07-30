import type {
  HttpClientOptions,
  NetworkSafetyOptions,
  ResponseLimits,
} from "./types.js";

export const DEFAULT_NETWORK_SAFETY: NetworkSafetyOptions = Object.freeze({
  enabled: true,
  allowPrivateNetworks: false,
  allowLocalhost: false,
  mixedAddressPolicy: "reject-host",
  dnsTimeoutMs: 5_000,
  dnsCacheTtlMs: 60_000,
  maxDnsCacheEntries: 1_024,
});

export const DEFAULT_RESPONSE_LIMITS: ResponseLimits = Object.freeze({
  maxCompressedBytes: 10 * 1024 * 1024,
  maxDecompressedBytes: 50 * 1024 * 1024,
  memoryThresholdBytes: 1024 * 1024,
  spoolDirectory: null,
});

export const DEFAULT_HTTP_CLIENT_OPTIONS: Omit<
  HttpClientOptions,
  "resolver"
> = Object.freeze({
  requestTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 15_000,
  maxRedirects: 10,
  protocolPreference: "auto",
  rejectUnauthorized: true,
  maxConnectionsPerOrigin: 4,
  maxOrigins: 1_024,
  defaultHeaders: {},
  responseLimits: DEFAULT_RESPONSE_LIMITS,
  networkSafety: DEFAULT_NETWORK_SAFETY,
});
