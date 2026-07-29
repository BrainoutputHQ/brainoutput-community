#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// The safety properties of the discovery slice. If these pass and everything else fails, the tool
// is merely useless. If these fail, the tool is dangerous. They are therefore the tests that
// matter most, and they assert refusals rather than features.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createApproval, checkAllowed, parseCidr, cidrContains, approvalExpired,
  describeApproval, FORBIDDEN, APPROVED_PORTS, INTENSITY, SYNC_MODES,
} from "./scope.mjs";
import { sanitize, classify, guardPrompt, explanationPayload, acceptExplanation } from "./firewall.mjs";
import { runPrivileged, createAudit, PRIVILEGED_ALLOWLIST } from "./privileged.mjs";

const approval = createApproval({ cidrs: ["192.168.10.0/28"], hosts: ["printer.local"], approvedBy: "founder", allowActive: true });

// ── scope ───────────────────────────────────────────────────────────────────────────────────────

test("CIDR containment is exact for v4 and v6, and refuses what it cannot parse", () => {
  assert.equal(cidrContains("192.168.10.0/28", "192.168.10.5"), true);
  assert.equal(cidrContains("192.168.10.0/28", "192.168.10.16"), false);  // just outside a /28
  assert.equal(cidrContains("10.0.0.0/8", "10.255.255.255"), true);
  assert.equal(cidrContains("0.0.0.0/0", "8.8.8.8"), true);
  assert.equal(cidrContains("2001:db8::/32", "2001:db8:1234::1"), true);
  assert.equal(cidrContains("2001:db8::/32", "2001:db9::1"), false);
  assert.equal(cidrContains("2001:db8:abcd::/48", "2001:db8:abcd:1::1"), true);
  assert.equal(cidrContains("2001:db8:abcd::/48", "2001:db8:abce::1"), false);
  // a non-nibble-aligned prefix must still be exact
  assert.equal(cidrContains("192.168.10.0/30", "192.168.10.3"), true);
  assert.equal(cidrContains("192.168.10.0/30", "192.168.10.4"), false);
  // garbage must NEVER read as "contained"
  for (const bad of ["not-a-cidr", "192.168.1.0/33", "999.1.1.1/24", "", "::/129", "10.0.0.0/-1"])
    assert.equal(parseCidr(bad), null, `${bad} must not parse`);
  for (const bad of ["not-a-cidr", "192.168.1.0/33"]) assert.equal(cidrContains(bad, "192.168.1.1"), false);
  assert.equal(cidrContains("192.168.10.0/28", "not-an-ip"), false);
});

test("REFUSAL: a target outside every approved range is denied", () => {
  assert.equal(checkAllowed(approval, { target: "192.168.10.5", port: 80, method: "active" }).allowed, true);
  const out = checkAllowed(approval, { target: "192.168.11.5", port: 80, method: "active" });
  assert.equal(out.allowed, false);
  assert.match(out.reason, /outside every approved range/);
  // …and the neighbouring subnet, and the public internet, and localhost-by-accident
  for (const t of ["192.168.10.16", "8.8.8.8", "127.0.0.1", "0.0.0.0"])
    assert.equal(checkAllowed(approval, { target: t, port: 80, method: "active" }).allowed, false, `${t} must be refused`);
  // an explicitly named host IS allowed even though it is not in a CIDR
  assert.equal(checkAllowed(approval, { target: "printer.local", port: 631, method: "active" }).allowed, true);
});

test("REFUSAL: forbidden actions are denied in every mode, including act", () => {
  const acting = createApproval({ cidrs: ["192.168.10.0/28"], approvedBy: "founder", mode: "act", allowActive: true });
  for (const action of FORBIDDEN) {
    assert.equal(checkAllowed(approval, { action, target: "192.168.10.5" }).allowed, false, `${action} in observe`);
    const r = checkAllowed(acting, { action, target: "192.168.10.5" });
    assert.equal(r.allowed, false, `${action} must be refused even in act mode`);
    assert.match(r.reason, /never permitted/);
  }
});

test("REFUSAL: observe mode denies anything that would change something", () => {
  const r = checkAllowed(approval, { action: "write-config", target: "192.168.10.5" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /observe/);
});

test("REFUSAL: unapproved ports and unapproved active probing", () => {
  assert.equal(checkAllowed(approval, { target: "192.168.10.5", port: 23, method: "active" }).allowed, false);   // telnet
  assert.equal(checkAllowed(approval, { target: "192.168.10.5", port: 3306, method: "active" }).allowed, false); // mysql
  assert.ok(APPROVED_PORTS[631] && APPROVED_PORTS[9100]);  // the printer ports we do allow
  const passiveOnly = createApproval({ cidrs: ["192.168.10.0/28"], approvedBy: "founder" });   // allowActive defaults false
  const r = checkAllowed(passiveOnly, { target: "192.168.10.5", port: 80, method: "active" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /active probing was not approved/);
});

test("REFUSAL: an expired approval stops being an approval", () => {
  const a = createApproval({ cidrs: ["192.168.10.0/28"], approvedBy: "founder", at: 0, ttlMs: 1000, allowActive: true });
  assert.equal(checkAllowed(a, { target: "192.168.10.5", port: 80, method: "active" }, 500).allowed, true);
  assert.equal(approvalExpired(a, 2000), true);
  assert.match(checkAllowed(a, { target: "192.168.10.5", port: 80, method: "active" }, 2000).reason, /expired/);
  assert.equal(checkAllowed(null, { target: "192.168.10.5" }).allowed, false);
});

test("an approval refuses to be created from a range it cannot parse, or one too large for the intensity", () => {
  assert.throws(() => createApproval({ cidrs: ["not-a-cidr"], approvedBy: "f" }), /not a CIDR I can parse/);
  assert.throws(() => createApproval({ cidrs: ["10.0.0.0/8"], approvedBy: "f" }), /allows 256|Narrow the range/);
  assert.throws(() => createApproval({ cidrs: [], approvedBy: null }), /who gave it/);
  assert.throws(() => createApproval({ approvedBy: "f", mode: "destroy" }), /unknown mode/);
  assert.throws(() => createApproval({ approvedBy: "f", sync: "everything" }), /unknown sync/);
  // the approval is frozen — nothing may widen it after a human agreed to it
  assert.throws(() => { "use strict"; approval.cidrs.push("0.0.0.0/0"); }, TypeError);
  assert.throws(() => { "use strict"; approval.allowActive = true; }, TypeError);
});

test("collector allow-listing, defaults and the human-readable summary", () => {
  const a = createApproval({ cidrs: ["192.168.10.0/28"], collectors: ["cpu", "memory"], approvedBy: "f", allowActive: true });
  assert.equal(checkAllowed(a, { collector: "cpu", target: "192.168.10.5" }).allowed, true);
  assert.equal(checkAllowed(a, { collector: "dhcp-lease", target: "192.168.10.5" }).allowed, false);
  assert.equal(approval.mode, "observe");            // read-only by default
  assert.equal(approval.sync, "local-only");         // nothing leaves by default
  assert.equal(SYNC_MODES[0], "local-only");
  assert.ok(INTENSITY.gentle.concurrency <= INTENSITY.standard.concurrency);
  const d = describeApproval(approval);
  assert.match(d, /read-only/);
  assert.match(d, /192\.168\.10\.0\/28/);
});

// ── AI firewall ─────────────────────────────────────────────────────────────────────────────────

test("REFUSAL: credentials and personal data never reach a model, local or external", () => {
  const dirty = [
    "snmp_community: public123",
    "password: hunter2",
    "api_key=sk-abcdef0123456789abcdef",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "admin@example.com",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "$6$rounds$abcdefghijklmnop",
  ].join("\n");
  const { text, redacted } = sanitize(dirty);
  for (const leak of ["hunter2", "public123", "sk-abcdef0123456789abcdef", "admin@example.com", "MIIEow"])
    assert.ok(!text.includes(leak), `sanitize leaked ${leak}`);
  assert.ok(redacted.length >= 4);
  assert.equal(classify(dirty), "sensitive");
  // and sensitive content is refused outright for external inference
  const g = guardPrompt({ text: dirty, destination: "external" });
  assert.equal(g.allowed, false);
  assert.match(g.reason, /may not leave the machine/);
});

test("REFUSAL: internal topology is blocked from external inference unless explicitly approved", () => {
  const topo = "host 192.168.1.10 mac aa:bb:cc:dd:ee:ff gateway 192.168.1.1";
  assert.equal(classify(topo), "internal");
  assert.equal(guardPrompt({ text: topo, destination: "local" }).allowed, true);
  const blocked = guardPrompt({ text: topo, destination: "external" });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /external inference is blocked/);
  assert.equal(guardPrompt({ text: topo, destination: "external", allowExternalInternal: true }).allowed, true);
});

test("a model is handed ONLY findings that exist and the evidence they cite — and is told so", () => {
  const observations = [
    { id: "O-1", kind: "net", subject: "gateway", value: "unreachable", collector: "ping", method: "active", at: 0 },
    { id: "O-2", kind: "net", subject: "unrelated", value: "x", collector: "c", method: "passive", at: 0 },
  ];
  const findings = [{ id: "F-1", severity: "high", title: "Gateway unreachable", evidence: ["O-1"], confidence: 0.9 }];
  const p = explanationPayload({ findings, observations });
  assert.ok(p.text.includes("O-1"));
  assert.ok(!p.text.includes("O-2"), "uncited evidence must not be sent");
  assert.match(p.instruction, /must NOT invent scan results/);
  // whole logs must never be shipped: the payload is bounded
  const huge = explanationPayload({ findings, observations: [{ ...observations[0], value: "x".repeat(50000) }], maxChars: 500 });
  assert.ok(huge.text.length <= 500);
  assert.equal(huge.truncated, true);
});

test("a model that invents a finding is caught and stripped of authority", () => {
  const findings = [{ id: "F-1", severity: "high", title: "Gateway unreachable", evidence: ["O-1"], confidence: 0.9 }];
  const good = acceptExplanation({ findings, explanation: "F-1 is likely a cabling fault." });
  assert.equal(good.trustworthy, true);
  const bad = acceptExplanation({ findings, explanation: "F-1 and also F-99 show a failing switch." });
  assert.equal(bad.trustworthy, false);
  assert.deepEqual(bad.invented, ["F-99"]);
  assert.match(bad.note, /carries no authority/);
});

// ── privilege boundary ──────────────────────────────────────────────────────────────────────────

test("REFUSAL: only allow-listed, read-only privileged commands can run at all", async () => {
  const audit = createAudit();
  const exec = async () => ({ stdout: "ok", code: 0 });
  const r = await runPrivileged("rm-rf-everything", { exec, privileged: true, audit: audit.record });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an allow-listed/);
  // every entry in the allowlist must itself be read-only
  for (const [name, spec] of Object.entries(PRIVILEGED_ALLOWLIST)) {
    const line = `${spec.cmd} ${spec.args.join(" ")}`;
    assert.doesNotMatch(line, /\b(rm|dd|mkfs|reboot|shutdown)\b/, `${name} is not read-only`);
    assert.doesNotMatch(line, /systemctl\s+(start|stop|restart)/, `${name} would change service state`);
  }
});

test("without privilege a collector degrades to PARTIAL evidence with a reason, never a silent gap", async () => {
  const audit = createAudit();
  const r = await runPrivileged("dhcp-lease-linux", { exec: async () => ({ stdout: "x", code: 0 }), privileged: false, audit: audit.record });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.equal(r.supported, true);                       // it IS supported — we just lack rights
  assert.match(r.reason, /needs administrator\/root/);
  assert.ok(r.command, "the command must still be shown");
});

test("every privileged command is shown and audited BEFORE it runs, and the record is tamper-evident", async () => {
  const audit = createAudit();
  let ran = false;
  await runPrivileged("arp-table-linux", { exec: async () => { ran = true; return { stdout: "", code: 0 }; }, privileged: true, audit: audit.record });
  const entries = audit.all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "privileged-command");
  assert.match(entries[0].command, /^ip neigh show$/);
  assert.equal(ran, true);
  assert.equal(audit.verify().intact, true);
  // tampering with a recorded command must be detectable
  entries[0].command = "rm -rf /";
  const tampered = createAudit();
  tampered.record({ at: 1, kind: "x", command: "a" });
  tampered.record({ at: 2, kind: "x", command: "b" });
  const all = tampered.all();
  all[0].command = "changed";
  assert.equal(tampered.verify().intact, false);
});
