import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NETWORK_SAFETY,
  NetworkSafetyPolicy,
  decideIp,
  evaluateNetworkAddresses,
  parseContentLength,
} from "../dist/index.js";

test("parses only canonical safe-integer Content-Length values", () => {
  assert.equal(parseContentLength("0"), 0);
  assert.equal(parseContentLength("42"), 42);
  assert.equal(parseContentLength("01"), null);
  assert.equal(parseContentLength("-1"), null);
  assert.equal(parseContentLength("1.5"), null);
  assert.equal(parseContentLength("9007199254740992"), null);
});

test("classifies current IANA IPv4 special-purpose ranges", () => {
  const expected = new Map([
    ["0.1.2.3", false],
    ["100.64.0.1", false],
    ["192.0.0.9", true],
    ["192.0.0.10", true],
    ["192.0.0.11", false],
    ["192.31.196.1", true],
    ["192.52.193.1", true],
    ["192.88.99.1", false],
    ["192.175.48.1", true],
    ["198.18.0.1", false],
    ["203.0.113.1", false],
    ["8.8.8.8", true],
  ]);
  for (const [address, allowed] of expected) {
    assert.equal(decideIp(address, DEFAULT_NETWORK_SAFETY).allowed, allowed);
  }
});

test("classifies current IANA IPv6 special-purpose ranges", () => {
  const expected = new Map([
    ["64:ff9b::808:808", true],
    ["64:ff9b::a00:1", false],
    ["64:ff9b:1::1", false],
    ["100:0:0:1::1", false],
    ["2001:1::1", true],
    ["2001:1::4", false],
    ["2001:3::1", true],
    ["2001:db8::1", false],
    ["3fff::1", false],
    ["5f00::1", false],
    ["fec0::1", false],
    ["2606:4700:4700::1111", true],
  ]);
  for (const [address, allowed] of expected) {
    assert.equal(decideIp(address, DEFAULT_NETWORK_SAFETY).allowed, allowed);
  }
});

test("rejects mixed DNS answers or pins only safe addresses by policy", () => {
  const addresses = [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const rejected = evaluateNetworkAddresses(
    "mixed.example",
    addresses,
    DEFAULT_NETWORK_SAFETY,
  );
  assert.equal(rejected.decision.allowed, false);
  const filtered = evaluateNetworkAddresses("mixed.example", addresses, {
    ...DEFAULT_NETWORK_SAFETY,
    mixedAddressPolicy: "use-safe-addresses-only",
  });
  assert.equal(filtered.decision.allowed, true);
  assert.deepEqual(filtered.addresses, [{ address: "8.8.8.8", family: 4 }]);
  assert.deepEqual(filtered.rejectedAddresses, [
    { address: "127.0.0.1", family: 4 },
  ]);
});

test("bounds DNS cache entries and updates recency on a cache hit", async () => {
  const calls = new Map();
  const resolver = async (hostname) => {
    calls.set(hostname, (calls.get(hostname) ?? 0) + 1);
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const policy = new NetworkSafetyPolicy(
    {
      ...DEFAULT_NETWORK_SAFETY,
      maxDnsCacheEntries: 2,
      dnsCacheTtlMs: 60_000,
    },
    resolver,
  );
  await policy.resolveHostname("a.example");
  await policy.resolveHostname("b.example");
  await policy.resolveHostname("a.example");
  await policy.resolveHostname("c.example");
  await policy.resolveHostname("b.example");
  assert.equal(calls.get("a.example"), 1);
  assert.equal(calls.get("b.example"), 2);
  assert.equal(calls.get("c.example"), 1);
});

test("bounds DNS resolution time", async () => {
  const policy = new NetworkSafetyPolicy(
    { ...DEFAULT_NETWORK_SAFETY, dnsTimeoutMs: 10 },
    async () => await new Promise(() => {}),
  );
  const startedAt = performance.now();
  const result = await policy.resolveHostname("slow.example");
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.reason, "DNS lookup timed out");
  assert.ok(performance.now() - startedAt < 100);
});
