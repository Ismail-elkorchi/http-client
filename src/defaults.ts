import type {
  HttpClientOptions,
  HttpTimeouts,
  NetworkSafetyOptions,
  ResponseStorageOptions,
  ResponseTransferLimits,
  TlsOptions,
} from "./types.js";
import { HttpFields } from "./fields.js";

export const DEFAULT_NETWORK_SAFETY: NetworkSafetyOptions = Object.freeze({
  enabled: true,
  allowPrivateNetworks: false,
  allowLocalhost: false,
  mixedAddressPolicy: "reject-host",
  dnsTimeoutMs: 5_000,
  dnsCacheTtlMs: 60_000,
  maxDnsCacheEntries: 1_024,
  addressAttemptDelayMs: 250,
});

export const DEFAULT_RESPONSE_TRANSFER_LIMITS: ResponseTransferLimits =
  Object.freeze({
    maxWireBytes: 10 * 1024 * 1024,
    maxDecodedBytes: 50 * 1024 * 1024,
    maxContentEncodingLayers: 5,
  });

export const DEFAULT_RESPONSE_STORAGE: ResponseStorageOptions = Object.freeze({
  memoryThresholdBytes: 1024 * 1024,
  spoolDirectory: null,
});

export const DEFAULT_HTTP_TIMEOUTS: HttpTimeouts = Object.freeze({
  totalMs: 30_000,
  connectMs: 10_000,
  responseFieldsMs: 15_000,
  responseBodyProgressMs: 30_000,
});

export const DEFAULT_TLS_OPTIONS: TlsOptions = Object.freeze({
  rejectUnauthorized: true,
});

export const DEFAULT_HTTP_CLIENT_OPTIONS: Omit<
  HttpClientOptions,
  "observer" | "resolver"
> = Object.freeze({
  timeouts: DEFAULT_HTTP_TIMEOUTS,
  maxRedirects: 10,
  protocolPreference: "auto",
  responseContentDecoding: "decode",
  maxConnectionsPerOrigin: 4,
  maxOrigins: 1_024,
  maxRequestBodyBytes: 50 * 1024 * 1024,
  maxRequestFieldsBytes: 64 * 1024,
  maxResponseFieldsBytes: 64 * 1024,
  defaultFields: new HttpFields(),
  responseTransferLimits: DEFAULT_RESPONSE_TRANSFER_LIMITS,
  responseStorage: DEFAULT_RESPONSE_STORAGE,
  tls: DEFAULT_TLS_OPTIONS,
  proxy: null,
  networkSafety: DEFAULT_NETWORK_SAFETY,
});
