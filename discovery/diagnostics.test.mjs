#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import {
  finding, checkPrinter, checkDns, checkGateway, checkDuplicateIp, checkSubnet,
  runAllChecks, remediationPlan,
} from "./diagnostics.mjs";

const obs = (id, kind, subject, value) => ({ id, kind, subject, value, collector: "test", method: "active", platform: "network", at: 1000, confidence: 0.9 });

const FIXTURE = [
  obs("o1", "printer-reachable", "prt-01", { reachable: true, ip: "10.0.0.50" }),
  obs("o2", "dns-resolution", "prt-01", { name: "prt-01.office", ip: "10.0.0.99", ok: true, latencyMs: 4 }),
  obs("o3", "toner-level", "prt-01", 4),
  obs("o4", "printer-reachable", "prt-02", { reachable: false, ip: "10.0.0.51" }),
  obs("o5", "paper-status", "prt-02", "jam"),
  obs("o6", "print-queue", "prt-01", { paused: true, port: "WSD-9f", expectedPort: "IP_10.0.0.50" }),
  obs("o7", "device-error", "prt-02", "E-59 fuser error"),
  obs("o8", "snmp-status", "prt-02", "warming-up-stuck"),
  obs("o9", "arp-entry", "10.0.0.50", { ip: "10.0.0.50", mac: "aa:bb:cc:dd:ee:01" }),
  obs("o10", "arp-entry", "10.0.0.50", { ip: "10.0.0.50", mac: "aa:bb:cc:dd:ee:02" }),
  obs("o11", "gateway-reachable", "gw", { reachable: false, ip: "10.0.0.1" }),
  obs("o12", "default-route", "laptop-7", { present: false }),
  obs("o13", "host-address", "host-1", { ip: "10.0.9.20", prefixLength: 24 }),
  obs("o14", "gateway", "gw", { ip: "10.0.0.1", prefixLength: 24 }),
  obs("o15", "dns-forwarder", "upstream", { reachable: false, ip: "192.0.2.53" }),
  obs("o16", "dns-resolution", "slow-name", { name: "files.office", ok: true, latencyMs: 1400 }),
  obs("o17", "dns-resolution", "broken-name", { name: "gone.office", ok: false, error: "NXDOMAIN" }),
];

test("finding() enforces its invariants", () => {
  assert.throws(() => finding({ title: "x" }), /evidence/);
  assert.throws(() => finding({ title: "x", evidence: ["o1"] }), /alternative/);
  assert.throws(() => finding({ title: "x", evidence: ["o1"], alternativeCauses: ["a"] }), /verification/);
  assert.throws(() => finding({
    title: "x", evidence: ["o1"], alternativeCauses: ["a"], nextVerification: "v",
    remediation: { requiresApproval: false },
  }), /approval/);
  const f = finding({ title: "x", evidence: ["o1"], alternativeCauses: ["a"], nextVerification: "v" });
  assert.equal(f.remediation.requiresApproval, true);
});

test("duplicate-IP detection fires on same IP with different MACs, severity high", () => {
  const fs = checkDuplicateIp(FIXTURE);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "high");
  assert.match(fs[0].title, /10\.0\.0\.50/);
  assert.deepEqual([...fs[0].evidence].sort(), ["o10", "o9"]);
  // same MAC twice -> no finding
  assert.equal(checkDuplicateIp([FIXTURE[8], FIXTURE[8]]).length, 0);
});

test("printer checks cover unreachable, DNS/IP inconsistency, toner, paper, error, queue, SNMP", () => {
  const fs = checkPrinter(FIXTURE);
  const titles = fs.map((f) => f.title).join("\n");
  assert.match(titles, /prt-02 is unreachable/);
  assert.match(titles, /resolves to 10\.0\.0\.99 but 10\.0\.0\.50/);
  assert.match(titles, /toner low/);
  assert.match(titles, /paper jam/);
  assert.match(titles, /device error/);
  assert.match(titles, /queue for prt-01 is paused/);
  assert.match(titles, /port 'WSD-9f' instead of 'IP_10\.0\.0\.50'/);
  assert.match(titles, /SNMP status/);
  const mismatch = fs.find((f) => /resolves to/.test(f.title));
  assert.deepEqual(mismatch.evidence, ["o1", "o2"]);
});

test("dns, gateway and subnet checks fire", () => {
  assert.ok(checkDns(FIXTURE).some((f) => /failed for gone\.office/.test(f.title)));
  assert.ok(checkDns(FIXTURE).some((f) => /forwarder 192\.0\.2\.53/.test(f.title)));
  assert.ok(checkDns(FIXTURE).some((f) => /slow \(1400ms\)/.test(f.title)));
  assert.ok(checkGateway(FIXTURE).some((f) => /gateway 10\.0\.0\.1 is unreachable/.test(f.title)));
  assert.ok(checkGateway(FIXTURE).some((f) => /no default route/.test(f.title)));
  assert.ok(checkSubnet(FIXTURE).some((f) => /not in the gateway's subnet/.test(f.title)));
});

test("every finding from runAllChecks carries evidence, alternativeCauses and nextVerification", () => {
  const all = runAllChecks(FIXTURE);
  assert.ok(all.length >= 10, `expected many findings, got ${all.length}`);
  for (const f of all) {
    assert.ok(Array.isArray(f.evidence) && f.evidence.length > 0, `${f.id} has no evidence`);
    assert.ok(f.evidence.every((e) => FIXTURE.some((o) => o.id === e)), `${f.id} cites unknown evidence`);
    assert.ok(Array.isArray(f.alternativeCauses) && f.alternativeCauses.length >= 1, `${f.id} has no alternative cause`);
    assert.equal(typeof f.nextVerification, "string");
    assert.ok(f.nextVerification.length > 0);
    assert.equal(f.remediation.requiresApproval, true);
    assert.ok(f.confidence >= 0 && f.confidence <= 1);
  }
  // sorted by severity: critical < high < medium < low < info
  const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  for (let i = 1; i < all.length; i++)
    assert.ok(RANK[all[i].severity] >= RANK[all[i - 1].severity], "findings not sorted by severity");
});

test("remediationPlan orders steps, requires approval everywhere and executes nothing", () => {
  const all = runAllChecks(FIXTURE);
  const plan = remediationPlan(all);

  assert.ok(plan.length > 0);
  plan.forEach((s, i) => {
    assert.equal(s.order, i + 1);
    assert.equal(s.requiresApproval, true, `step ${s.order} does not require approval`);
    assert.equal(typeof s.action, "string", "a plan step must be a description, never a callable");
    assert.ok(all.some((f) => f.id === s.findingId));
    for (const v of Object.values(s)) assert.notEqual(typeof v, "function", "plan contains something executable");
  });
  // high-severity findings are planned before low-severity ones
  const ranks = plan.map((s) => ({ critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s.severity]));
  const highEnd = ranks.lastIndexOf(1), lowStart = ranks.indexOf(3);
  if (highEnd !== -1 && lowStart !== -1) assert.ok(highEnd < lowStart, "plan is not severity-ordered");

  // the module exposes no executor: plan steps are inert data, frozen
  assert.ok(Object.isFrozen(plan));
  assert.throws(() => { plan[0].requiresApproval = false; }, TypeError);
});
