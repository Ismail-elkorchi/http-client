import { isIP } from "node:net";
import { HttpConfigurationError } from "./errors.ts";
import type {
  NetworkSafetyDecision,
  NetworkSafetyOptions,
} from "./types.ts";

const PUBLIC_V4_EXCEPTIONS: readonly CidrV4[] = [
  cidr4("192.0.0.9", 32),
  cidr4("192.0.0.10", 32),
];

const BLOCKED_V4: readonly CidrV4[] = [
  cidr4("0.0.0.0", 8),
  cidr4("10.0.0.0", 8),
  cidr4("100.64.0.0", 10),
  cidr4("127.0.0.0", 8),
  cidr4("169.254.0.0", 16),
  cidr4("172.16.0.0", 12),
  cidr4("192.0.0.0", 24),
  cidr4("192.0.2.0", 24),
  cidr4("192.88.99.0", 24),
  cidr4("192.168.0.0", 16),
  cidr4("198.18.0.0", 15),
  cidr4("198.51.100.0", 24),
  cidr4("203.0.113.0", 24),
  cidr4("224.0.0.0", 4),
  cidr4("240.0.0.0", 4),
];

const PRIVATE_V4: readonly CidrV4[] = [
  cidr4("10.0.0.0", 8),
  cidr4("172.16.0.0", 12),
  cidr4("192.168.0.0", 16),
];

const PUBLIC_V6_BASE = cidr6("2000::", 3);
const PUBLIC_NAT64 = cidr6("64:ff9b::", 96);
const PRIVATE_V6 = cidr6("fc00::", 7);
const IETF_ASSIGNMENTS = cidr6("2001::", 23);

const PUBLIC_IETF_EXCEPTIONS: readonly CidrV6[] = [
  cidr6("2001:1::1", 128),
  cidr6("2001:1::2", 128),
  cidr6("2001:1::3", 128),
  cidr6("2001:3::", 32),
  cidr6("2001:4:112::", 48),
  cidr6("2001:20::", 28),
  cidr6("2001:30::", 28),
];

const BLOCKED_GLOBAL_V6: readonly CidrV6[] = [
  cidr6("2001:db8::", 32),
  cidr6("2002::", 16),
  cidr6("3fff::", 20),
];

export function decideIp(
  rawIp: string,
  options: NetworkSafetyOptions,
): NetworkSafetyDecision {
  if (typeof rawIp !== "string") {
    throw new HttpConfigurationError("IP address must be a string.");
  }
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.enabled !== "boolean" ||
    typeof options.allowLocalhost !== "boolean" ||
    typeof options.allowPrivateNetworks !== "boolean"
  ) {
    throw new HttpConfigurationError(
      "Network safety options are invalid.",
    );
  }
  if (!options.enabled) {
    return isIP(rawIp) === 0
      ? denied("Invalid IP address", rawIp)
      : allowed(rawIp);
  }
  const mapped = mappedIpv4(rawIp);
  if (mapped !== null) return decideIpv4(mapped, rawIp, options);
  const family = isIP(rawIp);
  if (family === 4) return decideIpv4(rawIp, rawIp, options);
  if (family !== 6) return denied("Invalid IP address", rawIp);

  if (rawIp === "::1") {
    return options.allowLocalhost
      ? allowed(rawIp)
      : denied("Loopback network address blocked", rawIp);
  }
  const value = ipv6Value(rawIp);
  if (value === null) return denied("Invalid IPv6 address", rawIp);
  if (inV6(value, PRIVATE_V6)) {
    return options.allowPrivateNetworks
      ? allowed(rawIp)
      : denied("Private network address blocked", rawIp);
  }
  if (inV6(value, PUBLIC_NAT64)) {
    const embedded = ipv4FromInteger(Number(value & 0xffffffffn));
    return isPublicIpv4(embedded)
      ? allowed(rawIp)
      : denied("IPv4-IPv6 translation target is not public", rawIp);
  }
  if (!inV6(value, PUBLIC_V6_BASE)) {
    return denied("Non-global IPv6 address blocked", rawIp);
  }
  if (
    inV6(value, IETF_ASSIGNMENTS) &&
    !PUBLIC_IETF_EXCEPTIONS.some((range) => inV6(value, range))
  ) {
    return denied("Non-global IETF protocol address blocked", rawIp);
  }
  if (BLOCKED_GLOBAL_V6.some((range) => inV6(value, range))) {
    return denied("Special-purpose IPv6 address blocked", rawIp);
  }
  return allowed(rawIp);
}

function decideIpv4(
  ip: string,
  reportedIp: string,
  options: NetworkSafetyOptions,
): NetworkSafetyDecision {
  const value = ipv4Value(ip);
  if (value === null) return denied("Invalid IPv4 address", reportedIp);
  if (inV4(value, cidr4("127.0.0.0", 8))) {
    return options.allowLocalhost
      ? allowed(reportedIp)
      : denied("Loopback network address blocked", reportedIp);
  }
  if (PRIVATE_V4.some((range) => inV4(value, range))) {
    return options.allowPrivateNetworks
      ? allowed(reportedIp)
      : denied("Private network address blocked", reportedIp);
  }
  return isPublicIpv4(ip)
    ? allowed(reportedIp)
    : denied("Special-purpose IPv4 address blocked", reportedIp);
}

function isPublicIpv4(ip: string): boolean {
  const value = ipv4Value(ip);
  if (value === null) return false;
  if (PUBLIC_V4_EXCEPTIONS.some((range) => inV4(value, range))) return true;
  return !BLOCKED_V4.some((range) => inV4(value, range));
}

interface CidrV4 {
  readonly base: number;
  readonly mask: number;
}

interface CidrV6 {
  readonly base: bigint;
  readonly mask: bigint;
}

function cidr4(address: string, prefix: number): CidrV4 {
  const value = ipv4Value(address) ?? 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: value & mask, mask };
}

function inV4(value: number, range: CidrV4): boolean {
  return (value & range.mask) >>> 0 === range.base >>> 0;
}

function ipv4Value(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = (value << 8) | byte;
  }
  return value >>> 0;
}

function ipv4FromInteger(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function cidr6(address: string, prefix: number): CidrV6 {
  const value = ipv6Value(address) ?? 0n;
  const mask =
    prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return { base: value & mask, mask };
}

function inV6(value: bigint, range: CidrV6): boolean {
  return (value & range.mask) === range.base;
}

function ipv6Value(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  const sides = ip.toLowerCase().split("::");
  if (sides.length > 2) return null;
  const left = ipv6Groups(sides[0] ?? "");
  const right = ipv6Groups(sides[1] ?? "");
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 1 && missing !== 0)) return null;
  const all = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (all.length !== 8) return null;
  return all.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function ipv6Groups(part: string): readonly number[] | null {
  if (part === "") return [];
  const rawGroups = part.split(":");
  const last = rawGroups.at(-1);
  if (last?.includes(".") === true) {
    const ipv4 = ipv4Value(last);
    if (ipv4 === null) return null;
    rawGroups.splice(
      -1,
      1,
      ((ipv4 >>> 16) & 0xffff).toString(16),
      (ipv4 & 0xffff).toString(16),
    );
  }
  const values = rawGroups.map((group) =>
    /^[0-9a-f]{1,4}$/u.test(group) ? Number.parseInt(group, 16) : -1,
  );
  return values.some((value) => value < 0 || value > 0xffff) ? null : values;
}

function mappedIpv4(ip: string): string | null {
  const value = ipv6Value(ip);
  if (value === null) return null;
  const mappedPrefix = value >> 32n;
  if (mappedPrefix !== 0xffffn) return null;
  return ipv4FromInteger(Number(value & 0xffffffffn));
}

function allowed(ip: string): NetworkSafetyDecision {
  return {
    allowed: true,
    reason: null,
    checkedIp: ip,
    rejectionKind: null,
  };
}

function denied(reason: string, ip: string): NetworkSafetyDecision {
  return {
    allowed: false,
    reason,
    checkedIp: ip,
    rejectionKind: "policy",
  };
}
