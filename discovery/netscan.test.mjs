#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { sweep, vendorFromMac, deviceType } from "./netscan.mjs";
import { createApproval, APPROVED_PORTS } from "./scope.mjs";

const ALL_PORTS = Object.keys(APPROVED_PORTS).map(Number);

const approval = (over = {}) => createApproval({
  cidrs: ["10.0.0.0/29"], allowActive: true, approvedBy: "unit-test", intensity: "standard", ...over,
});

const closedConnect = async () => false;

// ── THE test: an out-of-scope host must be refused and must never reach `connect` ────────────

test("probe to a host outside the approved CIDR is refused and never reaches connect", async () => {
  const a = approval(); // approves 10.0.0.0/29 only
  const calls = [];
  const connect = async ({ host, port }) => { calls.push({ host, port }); return false; };

  const res = await sweep({ approval: a, cidrs: ["10.0.0.0/29", "10.9.9.0/30"], connect });

  assert.equal(calls.filter((c) => c.host.startsWith("10.9.9.")).length, 0,
    "connect was called for an out-of-scope host");
  const refusedOutside = res.refused.filter((r) => r.target.startsWith("10.9.9."));
  assert.ok(refusedOutside.length > 0, "no refused entry recorded for out-of-scope hosts");
  assert.ok(refusedOutside.every((r) => typeof r.reason === "string" && r.reason.length > 0));
});

test("a port not in APPROVED_PORTS is refused and never probed", async () => {
  const a = approval();
  const calls = [];
  const connect = async ({ host, port }) => { calls.push({ host, port }); return false; };

  const res = await sweep({ approval: a, cidrs: ["10.0.0.0/29"], connect, ports: [23, 80] });

  assert.equal(calls.filter((c) => c.port === 23).length, 0, "telnet was probed");
  assert.ok(calls.some((c) => c.port === 80), "approved port 80 should have been probed");
  assert.ok(res.refused.some((r) => r.port === 23), "no refused entry for port 23");
});

test("concurrency cap is respected", async () => {
  const a = approval({ cidrs: ["10.0.0.0/24"] });
  let active = 0, maxSeen = 0;
  const connect = async () => {
    active++; maxSeen = Math.max(maxSeen, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; return false;
  };

  await sweep({ approval: a, cidrs: ["10.0.0.0/24"], connect });

  assert.ok(maxSeen <= a.limits.concurrency, `concurrency ${maxSeen} exceeded ${a.limits.concurrency}`);
  assert.ok(maxSeen > 1, "suspiciously serial run — the test is not exercising concurrency");
});

test("portsPerHost cap is respected", async () => {
  const a = approval({ intensity: "gentle" }); // portsPerHost = 8
  const perHost = new Map();
  const connect = async ({ host }) => { perHost.set(host, (perHost.get(host) ?? 0) + 1); return false; };

  await sweep({ approval: a, cidrs: ["10.0.0.0/29"], connect, ports: ALL_PORTS });

  assert.ok(ALL_PORTS.length > a.limits.portsPerHost, "test needs more approved ports than the cap");
  for (const [host, n] of perHost) assert.ok(n <= a.limits.portsPerHost, `${host} got ${n} probes`);
  assert.ok(perHost.size > 0);
});

test("an aborted sweep stops early", async () => {
  const a = approval({ cidrs: ["10.0.0.0/24"] });
  const controller = new AbortController();
  let calls = 0;
  const connect = async () => { if (++calls === 3) controller.abort(); return false; };

  const res = await sweep({ approval: a, cidrs: ["10.0.0.0/24"], connect, signal: controller.signal });

  assert.equal(res.aborted, true);
  assert.ok(calls < 100, `sweep kept probing after abort (${calls} calls)`);
});

test("IPv6 ranges are never enumerated — only named hosts and ARP neighbours are probed", async () => {
  const a = approval({
    cidrs: ["2001:db8::/120"], hosts: ["2001:db8::5"], intensity: "gentle",
  });
  const calls = [];
  const connect = async ({ host }) => { calls.push(host); return true; };

  const res = await sweep({
    approval: a, cidrs: ["2001:db8::/120"], connect,
    arpTable: [
      { ip: "2001:db8::9", mac: "b8:27:eb:00:11:22" },
      { ip: "2001:db9::9", mac: "b8:27:eb:33:44:55" }, // outside scope
    ],
  });

  const probed = new Set(calls);
  assert.deepEqual(probed, new Set(["2001:db8::5", "2001:db8::9"]));
  assert.ok(res.refused.some((r) => r.target === "2001:db9::9"), "out-of-scope ARP entry not refused");
});

test("open ports, ARP vendor and device typing land in observations and hosts", async () => {
  const a = approval();
  const connect = async ({ port }) => [631, 9100].includes(port);
  const res = await sweep({
    approval: a, cidrs: ["10.0.0.0/29"], connect,
    arpTable: [{ ip: "10.0.0.1", mac: "00:80:77:aa:bb:cc" }],
    resolveHostname: async () => "office-printer",
  });

  const host = res.hosts.find((h) => h.ip === "10.0.0.1");
  assert.deepEqual(host.openPorts, [631, 9100]);
  assert.equal(host.vendor, "Brother");
  assert.equal(host.device.type, "printer");
  assert.ok(res.observations.every((o) => o.id && o.kind && o.collector === "netscan" && o.at > 0));
  assert.ok(res.observations.some((o) => o.kind === "port-open" && o.subject === "10.0.0.1:9100"));
});

// ── vendorFromMac / deviceType ───────────────────────────────────────────────────────────────

test("vendorFromMac resolves known prefixes and returns null when unknown", () => {
  assert.equal(vendorFromMac("b8:27:eb:11:22:33"), "Raspberry Pi");
  assert.equal(vendorFromMac("B8-27-EB-11-22-33"), "Raspberry Pi");
  assert.equal(vendorFromMac("001B.63ab.cdef"), "Apple");
  assert.equal(vendorFromMac("02:00:00:de:ad:be"), null);
  assert.equal(vendorFromMac(null), null);
});

test("deviceType classifies conservatively", () => {
  assert.equal(deviceType({ ports: [631, 9100] }).type, "printer");
  assert.equal(deviceType({ ports: [9100], vendor: "Epson" }).type, "printer");
  assert.equal(deviceType({ hostname: "core-sw-01" }).type, "switch");
  assert.equal(deviceType({ hostname: "edge-router" }).type, "router");
  assert.equal(deviceType({ ports: [3389, 445] }).type, "workstation");
  assert.equal(deviceType({ ports: [22, 80, 443] }).type, "server");
  assert.equal(deviceType({ ports: [161] }).type, "unknown");
  assert.equal(deviceType({}).type, "unknown");
  for (const { confidence } of [deviceType({}), deviceType({ ports: [9100] })])
    assert.ok(confidence >= 0 && confidence <= 1);
});
