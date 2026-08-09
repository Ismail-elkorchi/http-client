import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpConfigurationError } from "../dist/index.js";
import { DEFAULT_NETWORK_SAFETY } from "../dist/defaults.js";
import { decideIp } from "../dist/ip-policy.js";
import {
  evaluateNetworkAddresses,
  NetworkSafetyPolicy,
} from "../dist/network-policy.js";

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

test("limits private-network opt-in to private-use address space", () => {
  const options = {
    ...DEFAULT_NETWORK_SAFETY,
    allowPrivateNetworks: true,
  };
  for (const address of ["10.0.0.1", "172.16.0.1", "192.168.0.1", "fc00::1"]) {
    assert.equal(decideIp(address, options).allowed, true);
  }
  for (const address of ["100.64.0.1", "169.254.0.1", "fe80::1"]) {
    assert.equal(decideIp(address, options).allowed, false);
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
  assert.equal(
    decideIp("127.0.0.1", {
      ...DEFAULT_NETWORK_SAFETY,
      enabled: false,
    }).allowed,
    true,
  );
  assert.equal(
    evaluateNetworkAddresses(
      "empty.example",
      [],
      { ...DEFAULT_NETWORK_SAFETY, enabled: false },
    ).decision.allowed,
    false,
  );
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
  assert.equal(performance.now() - startedAt < 500, true);
});

test("preserves invalid resolver output as a contract error", async () => {
  const policy = new NetworkSafetyPolicy(
    DEFAULT_NETWORK_SAFETY,
    async () => [{ address: "not-an-ip", family: 4 }],
  );
  await assert.rejects(
    policy.resolveHostname("invalid.example"),
    HttpConfigurationError,
  );
});

test("rejects invalid address inventories at the network-policy boundary", () => {
  assert.throws(() =>
    evaluateNetworkAddresses(
      "invalid.example",
      [{ address: "127.0.0.1", family: 6 }],
      DEFAULT_NETWORK_SAFETY,
    ),
  );
  assert.throws(() =>
    evaluateNetworkAddresses(
      "sparse.example",
      new Array(1),
      DEFAULT_NETWORK_SAFETY,
    ),
  );
});

test("snapshots approved resolver addresses before pinning", () => {
  const address = { address: "8.8.8.8", family: 4 };
  const resolution = evaluateNetworkAddresses(
    "mutable.example",
    [address],
    DEFAULT_NETWORK_SAFETY,
  );
  address.address = "127.0.0.1";
  assert.deepEqual(resolution.addresses, [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.equal(Object.isFrozen(resolution), true);
  assert.equal(Object.isFrozen(resolution.addresses), true);
  assert.equal(Object.isFrozen(resolution.addresses[0]), true);
});

test("coalesces concurrent DNS lookups", async () => {
  let calls = 0;
  const policy = new NetworkSafetyPolicy(
    DEFAULT_NETWORK_SAFETY,
    async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ address: "8.8.8.8", family: 4 }];
    },
  );
  const [first, second] = await Promise.all([
    policy.resolveHostname("shared.example"),
    policy.resolveHostname("shared.example"),
  ]);
  assert.equal(first.decision.allowed, true);
  assert.equal(second.decision.allowed, true);
  assert.equal(calls, 1);
});

test("cancels owned DNS work when the policy closes", async () => {
  let resolverSignal = null;
  const policy = new NetworkSafetyPolicy(
    { ...DEFAULT_NETWORK_SAFETY, dnsTimeoutMs: 1_000 },
    async (_hostname, signal) => {
      resolverSignal = signal;
      return await new Promise(() => {});
    },
  );
  const resolution = policy.resolveHostname("pending.example");
  await new Promise((resolve) => setTimeout(resolve, 5));
  policy.close(new Error("shutdown"));
  const result = await resolution;
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.rejectionKind, "dns");
  assert.equal(resolverSignal?.aborted, true);
});
