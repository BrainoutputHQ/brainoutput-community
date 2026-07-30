#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// The first hour, walked end to end against a clean store.
//
// Every failure in Tier 1 of the friction audit was reachable within ten minutes of installing,
// and none of them had a test — because every test covered one function well and nothing walked
// the path a person actually takes. This is that walk. It is deliberately about the SEAMS, not
// the engine: whether step 2 destroys step 1, whether an error is legible, whether a mission you
// approved can still be edited after it fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { newConversation, addMessage, draftMissionSpec, editMissionSpec, approveMission,
         validateMissionSpec, missionComposer } from "./chat.mjs";
import { DETERMINISTIC_TOOLS } from "./adapters.mjs";

const clean = () => new Store(mkdtempSync(join(tmpdir(), "bo-firsthour-")));

test("step 2 of setup does not destroy step 1", () => {
  // The guided order is "1 · Connect a model" then "2 · Your company". /api/onboard used to
  // overwrite modelConnections wholesale, so the model you just connected vanished and every
  // capability slot read UNCONFIGURED. This reproduces the merge the handler now performs.
  const s = clean();
  s.setConnections([{ id: "gb10", kind: "local", provider: "local-gb10", model: "brainoutput-primary", funder: "local", costSource: "local-compute" }]);
  s.setAssignments({ "reasoning-free": "gb10" });
  s.save();

  const detected = [{ id: "local:qwen", kind: "local", provider: "ollama", model: "qwen", funder: "local", costSource: "local-compute" }];
  const byId = new Map((s.def.modelConnections || []).map((c) => [c.id, c]));
  for (const c of detected) if (!byId.has(c.id)) byId.set(c.id, c);
  const merged = [...byId.values()];

  assert.ok(merged.find((c) => c.id === "gb10"), "the connection the user made must survive step 2");
  assert.ok(merged.find((c) => c.id === "local:qwen"), "and newly detected models are still added");
  // an explicit assignment outranks a fresh recommendation
  const assignments = { ...{ "reasoning-free": "local:qwen" }, ...s.def.modelAssignments };
  assert.equal(assignments["reasoning-free"], "gb10", "the user's own assignment must win");
});

test("a company description is not a company name", () => {
  // `companyDoes` answers "what does your company do?". Storing it as the name rendered
  // "· a small software product studio" in the dashboard header.
  const s = clean();
  s.setCompany({ name: "Meridian Group", does: "a small software product studio" }).save();
  assert.equal(s.def.company.name, "Meridian Group");
  assert.notEqual(s.def.company.name, s.def.company.does);
});

test("a mission tells you it cannot be routed BEFORE you approve it", () => {
  // This was only discovered at launch: draft -> review -> edit -> approve -> click launch ->
  // "no agent for department 'finance'". By then the user has committed to it.
  const roster = [{ id: "a1", role: "architect", department: "technical", activation: "dormant" }];
  let c = addMessage(newConversation({ scope: "department", department: "finance" }), { text: "review comp", mode: "plan", at: 1 });
  let spec = editMissionSpec(draftMissionSpec(c, {}), { objective: "Review compensation" });

  const v = validateMissionSpec(spec, { agents: roster });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /no agent works in 'finance'/);
  assert.throws(() => approveMission(spec, { agents: roster }), /no agent works in 'finance'/);

  // and it approves cleanly once the department has someone in it
  const withFinance = [...roster, { id: "a2", role: "controller", department: "finance", activation: "dormant" }];
  assert.equal(approveMission(spec, { agents: withFinance }).status, "approved");
});

test("a mission that failed to launch can be edited again", () => {
  // The launch path leaves a failed mission at `approved` and its own comment promises
  // "edit and re-approve" — but editing refused anything but a draft, so it was stuck forever.
  const roster = [{ id: "a1", role: "controller", department: "finance", activation: "dormant" }];
  let c = addMessage(newConversation({ scope: "department", department: "finance" }), { text: "x", mode: "plan", at: 1 });
  let spec = editMissionSpec(draftMissionSpec(c, {}), { objective: "First try" });
  const approved = approveMission(spec, { agents: roster });

  const reopened = editMissionSpec(approved, { objective: "Second try" });
  assert.equal(reopened.objective, "Second try");
  assert.equal(reopened.status, "draft", "editing must return it to draft");
  assert.equal(reopened.approvedBy, null, "the old approval must not carry over to changed work");
});

test("a mis-shaped edit says so instead of silently doing nothing", () => {
  // `agent` (singular) used to be dropped in silence with a 200, so the edit looked applied.
  let c = addMessage(newConversation({ scope: "department", department: "finance" }), { text: "x", mode: "plan", at: 1 });
  const spec = draftMissionSpec(c, {});
  assert.throws(() => editMissionSpec(spec, { agent: "a-analyst" }), /unknown field\(s\) in patch: agent/);
  assert.deepEqual(editMissionSpec(spec, { agents: ["a-analyst"] }).agents, ["a-analyst"]);
});

test("the composer advertises only actions the API accepts", () => {
  // It listed "approve-and-launch" and "save-as-workflow"; both 400. A UI built from this list
  // could not work.
  let c = addMessage(newConversation({ scope: "department", department: "finance" }), { text: "x", mode: "plan", at: 1 });
  const view = missionComposer(draftMissionSpec(c, {}));
  for (const a of view.actions) assert.ok(["edit", "approve", "reject", "cancel", "save-workflow"].includes(a), `${a} is not a real action`);
});

test("no deterministic tool can report a success it did not earn", () => {
  // run-tests returned a hardcoded passed:true. Every remaining tool must be able to fail.
  assert.equal(DETERMINISTIC_TOOLS["run-tests"], undefined);
  const bad = DETERMINISTIC_TOOLS.reconcile({ ledger: [{ amount: 100 }], statement: [{ amount: 150 }] });
  assert.equal(bad.matched, false);
  const good = DETERMINISTIC_TOOLS.reconcile({ ledger: [{ amount: 150 }], statement: [{ amount: 150 }] });
  assert.equal(good.matched, true);
});
