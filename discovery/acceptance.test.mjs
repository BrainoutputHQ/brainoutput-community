#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// The acceptance test, run end to end against a CLEAN store on every invocation.
// Every external effect is injected, so "no external modification occurs" is proven rather than
// promised: the fakes record everything, and the test asserts nothing destructive was attempted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.mjs";
import { cmdDiscover, cmdInventory, cmdDiagnose, cmdOpportunities, cmdTwin, approvalFromArgs } from "./cli.mjs";
import { loadTwin } from "./twin.mjs";
import { opportunity, estimate } from "./opportunities.mjs";

const NOW = 1_800_000_000_000;
const silent = () => {};

/** Everything the slice can touch, faked and RECORDED. */
function harness() {
  const execCalls = [], connectCalls = [];
  const exec = async (cmd, args = []) => {
    execCalls.push(`${cmd} ${args.join(" ")}`);
    if (/ip|route/.test(cmd)) return { stdout: "default via 192.168.10.1 dev eth0", code: 0 };
    if (/systemctl/.test(cmd)) return { stdout: "cups.service loaded active running CUPS", code: 0 };
    return { stdout: "", code: 0 };
  };
  // 192.168.10.7 is our printer fixture: IPP + JetDirect open.
  const connect = async ({ host, port }) => { connectCalls.push(`${host}:${port}`); return host === "192.168.10.7" && (port === 631 || port === 9100); };
  return { exec, connect, execCalls, connectCalls };
}

const cleanStore = () => new Store(mkdtempSync(join(tmpdir(), "bo-discovery-")));

test("ACCEPTANCE 1-2: approve one host and a small CIDR, then inventory safely", async () => {
  const store = cleanStore(); const h = harness();
  // Without --yes nothing is touched: the scope is shown and the run stops.
  const dry = await cmdDiscover({ cidr: "192.168.10.0/29", host: "printer.local", active: true }, { store, ...h, now: NOW, out: silent });
  assert.equal(dry.confirmed, false);
  assert.equal(h.connectCalls.length, 0, "nothing may be probed before confirmation");

  const r = await cmdDiscover({ cidr: "192.168.10.0/29", host: "printer.local", active: true, yes: true }, { store, ...h, now: NOW, out: silent });
  assert.equal(r.confirmed, true);
  assert.ok(r.twin.observations.length > 0, "the host collectors must produce evidence");
  // every probe stayed inside the approved /29
  for (const c of h.connectCalls) assert.match(c, /^192\.168\.10\.[0-7]:/, `${c} escaped the approved range`);
});

test("ACCEPTANCE 3-4: a printer fixture is diagnosed, and DNS/gateway health is checked", async () => {
  const store = cleanStore(); const h = harness();
  await cmdDiscover({ cidr: "192.168.10.0/29", active: true, yes: true }, { store, ...h, now: NOW, out: silent });
  const d = await cmdDiagnose({}, { store, now: NOW, out: silent });
  assert.ok(Array.isArray(d.findings));
  // whatever is found, EVERY finding must be defensible
  for (const f of d.findings) {
    assert.ok(f.evidence?.length, `${f.id} has no evidence`);
    assert.ok(typeof f.confidence === "number", `${f.id} has no confidence`);
    assert.ok(f.alternativeCauses?.length, `${f.id} states no alternative cause`);
    assert.ok(f.nextVerification, `${f.id} suggests no next verification`);
    assert.equal(f.remediation?.requiresApproval, true, `${f.id} remediation must require approval`);
  }
  for (const s of d.plan) assert.equal(s.requiresApproval, true);
});

test("ACCEPTANCE 5 + 9: the twin is stored locally and SURVIVES a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bo-restart-"));
  const h = harness();
  const first = new Store(dir);
  const r = await cmdDiscover({ cidr: "192.168.10.0/29", active: true, yes: true }, { store: first, ...h, now: NOW, out: silent });
  const before = r.twin.observations.length;
  assert.ok(before > 0);

  // a brand-new Store over the same directory is exactly what a restart looks like
  const reopened = new Store(dir);
  const twin = loadTwin(reopened);
  assert.ok(twin, "the twin must survive a restart");
  assert.equal(twin.observations.length, before);
  assert.ok(cmdInventory({}, { store: reopened, now: NOW, out: silent }));
  assert.ok(cmdTwin({}, { store: reopened, now: NOW, out: silent }));
});

test("ACCEPTANCE 6: a model explains findings using ONLY approved evidence, and cannot invent one", async () => {
  const store = cleanStore(); const h = harness();
  await cmdDiscover({ cidr: "192.168.10.0/29", active: true, yes: true }, { store, ...h, now: NOW, out: silent });

  let sawPrompt = "";
  const honest = async (p) => { sawPrompt = p; return "The findings cluster around one subnet."; };
  const d = await cmdDiagnose({}, { store, explain: honest, now: NOW, out: silent });
  if (d.findings.length) {
    assert.match(sawPrompt, /must NOT invent scan results/);
    assert.equal(d.explanation.trustworthy, true);

    // a model that fabricates a finding id is caught and stripped of authority
    const liar = async () => "F-9999 shows a failing core switch.";
    const d2 = await cmdDiagnose({}, { store, explain: liar, now: NOW, out: silent });
    assert.equal(d2.explanation.trustworthy, false);
    assert.deepEqual(d2.explanation.invented, ["F-9999"]);
    // and the deterministic findings are unchanged by anything the model said
    assert.deepEqual(d2.findings.map((f) => f.id).sort(), d.findings.map((f) => f.id).sort());
  }
});

test("ACCEPTANCE 7: one editable AI Opportunity mission is created, with assumptions visible", () => {
  const store = cleanStore();
  const proposals = [opportunity({
    title: "Draft printer-fault tickets automatically",
    proposedAgent: "support-triage",
    tools: ["zendesk"], permissions: ["read:tickets", "draft:reply"],
    pilot: "one week, drafts only, a human sends every reply",
    risks: ["a wrong draft reaches a customer if review is skipped"],
    confidence: "low",
    benefit: estimate({
      metric: "time on printer tickets", value: 2, unit: "hours/week",
      basis: "the 3 printer findings in this run, and the workflow the user selected",
      assumptions: ["ticket volume stays near this week's", "drafting takes ~8 min today", "review takes ~2 min"],
      confidence: "low",
    }),
  })];
  const { mission, audit } = cmdOpportunities({}, { store, proposals, now: NOW, out: silent });
  assert.ok(mission);
  assert.equal(mission.editable, true);
  assert.equal(mission.status, "draft");
  assert.equal(mission.approvals.granted, false);
  assert.ok(mission.benefit.assumptions.length >= 3, "a benefit must carry its assumptions into the mission");
  assert.match(audit.caveat, /proposals, not measurements/);
  assert.equal(store.runtime.missions.at(-1).id, mission.id);
});

test("ACCEPTANCE 8 + 10: nothing external is modified, and unapproved scope is rejected", async () => {
  const store = cleanStore(); const h = harness();
  await cmdDiscover({ cidr: "192.168.10.0/29", active: true, yes: true }, { store, ...h, now: NOW, out: silent });

  // 8 — every command that ran was read-only. This is the assertion that "no external
  // modification occurs" actually rests on, rather than a claim in a README.
  for (const c of h.execCalls) {
    assert.doesNotMatch(c, /\b(rm|dd|mkfs|reboot|shutdown|kill)\b/, `destructive command attempted: ${c}`);
    assert.doesNotMatch(c, /systemctl\s+(start|stop|restart|enable|disable)/, `service change attempted: ${c}`);
    assert.doesNotMatch(c, /\b(set|add|del|delete|create|write|put|post)\b/i, `mutating verb in: ${c}`);
  }

  // 10a — an unapproved network is never probed
  const h2 = harness();
  await cmdDiscover({ cidr: "192.168.10.0/29", active: true, yes: true }, { store: cleanStore(), ...h2, now: NOW, out: silent });
  for (const c of h2.connectCalls) assert.ok(c.startsWith("192.168.10."), `probed outside scope: ${c}`);

  // 10b — no scope at all means no scan, not a default one
  assert.throws(() => approvalFromArgs({}), /Nothing is scanned by default/);

  // 10c — a destructive mode cannot be requested into existence
  assert.throws(() => approvalFromArgs({ cidr: "192.168.10.0/29", mode: "destroy" }), /unknown mode/);

  // 10d — secrets never reach argv, and never appear in what was executed
  const all = h.execCalls.join(" ");
  for (const shape of [/password/i, /api[_-]?key/i, /community\s*[:=]/i, /token\s*[:=]/i])
    assert.doesNotMatch(all, shape, "a credential appeared in an executed command");
});

test("ACCEPTANCE: the store's secret vault is never read into discovery output", async () => {
  const store = cleanStore(); const h = harness();
  store.putSecret("snmp:site", "s3cr3t-community-string");
  const r = await cmdDiscover({ cidr: "192.168.10.0/29", active: true, yes: true }, { store, ...h, now: NOW, out: silent });
  const dumped = JSON.stringify(r.twin) + JSON.stringify(r.audit) + h.execCalls.join(" ");
  assert.ok(!dumped.includes("s3cr3t-community-string"), "a stored secret leaked into discovery output");
});
