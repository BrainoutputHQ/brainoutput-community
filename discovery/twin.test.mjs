#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Tests for discovery/twin.mjs — the infrastructure twin.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.mjs";
import { createTwin, ingest, correlate, isStale, freshness, topology, inventory, saveTwin, loadTwin,
  DEFAULT_STALE_AFTER_MS } from "./twin.mjs";

const T0 = 1_760_000_000_000;
const obs = (id, value, at = T0, kind = "arp-entry") =>
  ({ id, kind, subject: value.ip || value.mac || id, value,
     collector: "test", method: "passive", platform: "linux", at, confidence: 1 });

// ── 1. THE DHCP test: same IP, different MACs → TWO assets, never one ──────────────────────────
test("same IP with different MACs produces TWO assets (DHCP reassignment)", () => {
  let twin = createTwin({ site: "hq", at: T0 });
  twin = ingest(twin, [
    obs("o1", { mac: "AA:BB:CC:00:00:01", ip: "10.0.0.50", hostname: "laptop-a" }),
    // A day later DHCP handed 10.0.0.50 to a DIFFERENT machine.
    obs("o2", { mac: "AA:BB:CC:00:00:02", ip: "10.0.0.50", hostname: "printer-b" }, T0 + 3600_000),
  ], { now: T0 + 3600_000 });
  assert.equal(twin.assets.length, 2, "an IP alone must never fuse two machines");
  assert.equal(twin.assets[0].identifiers.mac, "aabbcc000001");
  assert.equal(twin.assets[1].identifiers.mac, "aabbcc000002");
  // Both legitimately hold the address in their history; neither absorbed the other.
  assert.deepEqual(twin.assets[0].identifiers.ip, ["10.0.0.50"]);
  assert.deepEqual(twin.assets[1].identifiers.ip, ["10.0.0.50"]);

  // And the raw correlate() call agrees: second observation must CREATE, not merge.
  const r = correlate(twin.assets.slice(0, 1),
    obs("o2", { mac: "aabbcc000002", ip: "10.0.0.50" }));
  assert.equal(r.decision, "created");
  assert.equal(r.assets.length, 2);
});

// ── 2. Same MAC, different IP → ONE asset carrying both addresses ───────────────────────────────
test("same MAC with a different IP merges into ONE asset with both IPs", () => {
  let twin = createTwin({ site: "hq", at: T0 });
  twin = ingest(twin, [
    obs("o1", { mac: "aa:bb:cc:00:00:01", ip: "10.0.0.50", hostname: "laptop-a" }),
    obs("o2", { mac: "aa-bb-cc-00-00-01", ip: "10.0.0.77" }, T0 + 3600_000),
  ], { now: T0 + 3600_000 });
  assert.equal(twin.assets.length, 1);
  assert.deepEqual(twin.assets[0].identifiers.ip, ["10.0.0.50", "10.0.0.77"]);
  assert.deepEqual(twin.assets[0].observations, ["o1", "o2"]);
  assert.equal(twin.assets[0].lastSeen, T0 + 3600_000);
  assert.equal(twin.assets[0].firstSeen, T0);
});

// ── 3. Stale evidence is flagged stale, never reported as current ──────────────────────────────
test("stale observations are reported as stale, never as current", () => {
  let twin = createTwin({ site: "hq", at: T0 });
  twin = ingest(twin, [obs("o1", { mac: "aabbcc000001", ip: "10.0.0.50" })], { now: T0 });
  const old = twin.observations[0];
  const now = T0 + 2 * DEFAULT_STALE_AFTER_MS;
  assert.equal(isStale(old, { now }), true);
  assert.equal(isStale(old, { now: T0 + 1000 }), false);
  const f = freshness(twin, { now });
  assert.equal(f.fresh, 0);
  assert.equal(f.stale, 1);
  assert.deepEqual(f.staleObservations.map((s) => s.id), ["o1"]);
});

// ── 4. Round-trip through the Store survives a restart ─────────────────────────────────────────
test("a twin round-trips through the Store and survives reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "bo-twin-"));
  let twin = createTwin({ site: "hq", at: T0 });
  twin = ingest(twin, [
    obs("o1", { mac: "aabbcc000001", ip: "10.0.0.50", hostname: "laptop-a" }),
    obs("o2", { mac: "aabbcc000002", ip: "10.0.0.1", hostname: "gw" }),
    obs("o3", { mac: "aabbcc000001", ip: "10.0.0.50", gateway: "10.0.0.1" }, T0, "gateway"),
  ], { now: T0 });
  saveTwin(new Store(dir), twin);

  // A NEW Store instance over the same directory simulates a restart.
  const loaded = loadTwin(new Store(dir), { site: "hq" });
  assert.deepEqual(loaded, twin);
  assert.equal(loadTwin(new Store(dir), { site: "nowhere" }), null);
});

// ── 5. Conflicting evidence sets `uncertain`, never silently picks one ─────────────────────────
test("conflicting hard identifiers keep BOTH assets and set uncertain", () => {
  let twin = createTwin({ site: "hq", at: T0 });
  twin = ingest(twin, [
    obs("o1", { mac: "aabbcc000001", serial: "SN-111", ip: "10.0.0.50" }),
    // Same MAC but a different serial: two devices (or a spoof). Guessing which is real would
    // silently corrupt every finding, so both are kept and both are flagged.
    obs("o2", { mac: "aabbcc000001", serial: "SN-222", ip: "10.0.0.51" }, T0 + 1000),
  ], { now: T0 + 1000 });
  assert.equal(twin.assets.length, 2);
  assert.ok(twin.assets[0].uncertain, "the original asset must be flagged too");
  assert.ok(twin.assets[1].uncertain);
  assert.match(twin.assets[1].uncertain, /conflicting serial/);
  // The conflict is visible in the printable inventory, not buried in a field nobody reads.
  assert.match(inventory(twin), /UNCERTAIN/);
});

// ── derived views: topology resolves dependency edges by evidence ──────────────────────────────
test("topology links a host to its gateway/dns through evidence", () => {
  let twin = createTwin({ site: "hq", at: T0 });
  twin = ingest(twin, [
    obs("o1", { mac: "aabbcc000001", ip: "10.0.0.50", hostname: "laptop-a" }),
    obs("o2", { mac: "aabbcc000002", ip: "10.0.0.1", hostname: "gw" }),
    obs("o3", { mac: "aabbcc000001", ip: "10.0.0.50", gateway: "10.0.0.1" }, T0, "gateway"),
    obs("o4", { mac: "aabbcc000001", ip: "10.0.0.50", dns: "10.0.0.1" }, T0, "dns"),
    obs("o5", { mac: "aabbcc000001", ip: "10.0.0.50", dns: "8.8.8.8" }, T0, "dns"),
  ], { now: T0 });
  const g = topology(twin);
  assert.equal(g.nodes.length, 2);
  const host = twin.assets.find((a) => a.identifiers.hostname === "laptop-a");
  const gw = twin.assets.find((a) => a.identifiers.hostname === "gw");
  assert.deepEqual(
    g.edges.filter((e) => e.to === gw.id).map((e) => e.kind).sort(), ["dns", "gateway"]);
  assert.equal(g.edges.every((e) => e.from === host.id && e.evidence), true);
  // A resolver we never identified stays unresolved — reported, not invented as an asset.
  const ext = g.edges.find((e) => e.toRef === "8.8.8.8");
  assert.ok(ext && ext.to === null);
});
