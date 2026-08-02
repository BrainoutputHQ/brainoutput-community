// SPDX-License-Identifier: Apache-2.0
// Plan flow (task-pm-03): the durable Plan artifact with the owner-validation gate.
// A plan drafts → the owner refines it in the thread → explicit validation → materialization
// writes REAL tasks (directive fields + planId + dependsOn translated from indexes to ids).
// The API REFUSES to materialize an unvalidated plan (409) — that refusal is pinned here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4377;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-planflow-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

const DRAFTS = [
  { title: "Design the schema", priority: "high", skills: ["db"], acceptanceCriteria: ["schema reviewed"] },
  { title: "Build the exporter", objective: "build the exporter module", priority: "urgent",
    skills: ["node"], agentSlot: "dev-1", restrictions: { network: false },
    dependsOn: [0], acceptanceCriteria: ["exports work"] },
  { title: "Verify end to end", dependsOn: [0, 1] },
];

test("THE GATE: draft → materialize 409 → validate → materialize 200 → real tasks, plan frozen", async () => {
  const p = await post("/api/project", { name: "plan-gate" });
  const pid = p.body.project.id;

  const created = await post("/api/plan/new", { objective: "Ship the exporter", projectId: pid,
    decisions: "esm only, zero-dep", taskDrafts: DRAFTS });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  const plan = created.body.plan;
  assert.equal(plan.status, "draft");
  assert.equal(plan.projectId, pid);
  assert.equal(plan.taskDrafts.length, 3);

  // PINNED: an unvalidated (draft) plan is REFUSED — no tasks may ever come of it.
  const refused = await post("/api/plan/materialize", { id: plan.id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /draft/);
  assert.equal((await state()).tasks.filter((t) => t.planId === plan.id).length, 0, "no task leaked");

  const validated = await post("/api/plan/validate", { id: plan.id });
  assert.equal(validated.status, 200);
  assert.equal(validated.body.plan.status, "validated");

  const done = await post("/api/plan/materialize", { id: plan.id });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.equal(done.body.plan.status, "materialized");
  assert.equal(done.body.tasks.length, 3);
  assert.deepEqual(done.body.plan.taskIds, done.body.tasks.map((t) => t.id));

  // The tasks are real spine tasks on the project, carrying EVERY directive field + the plan link.
  const st = await state();
  const onSpine = st.tasks.filter((t) => t.planId === plan.id);
  assert.equal(onSpine.length, 3);
  const [a, b, c] = done.body.tasks;
  for (const t of [a, b, c]) {
    assert.equal(t.projectId, pid);
    assert.equal(t.planId, plan.id);
    assert.equal(t.status, "todo");
    assert.equal(t.reporter, "you");
    assert.ok(onSpine.some((x) => x.id === t.id), "persisted via the store");
  }
  assert.equal(b.objective, "build the exporter module");
  assert.deepEqual(b.skills, ["node"]);
  assert.equal(b.agentSlot, "dev-1");
  assert.deepEqual(b.restrictions, { network: false });
  assert.equal(b.priority, "urgent");
  assert.deepEqual(b.acceptanceCriteria, ["exports work"]);
  // dependsOn INDEXES became the created task ids.
  assert.deepEqual(b.dependsOn, [a.id]);
  assert.deepEqual(c.dependsOn, [a.id, b.id]);
  assert.deepEqual(a.dependsOn, []);

  // A materialized plan is FROZEN: no edit, no re-validate, no second materialization.
  assert.equal((await post("/api/plan/update", { id: plan.id, objective: "sneaky edit" })).status, 400);
  assert.equal((await post("/api/plan/validate", { id: plan.id })).status, 400);
  const again = await post("/api/plan/materialize", { id: plan.id });
  assert.equal(again.status, 409);
  assert.equal((await state()).tasks.filter((t) => t.planId === plan.id).length, 3, "no duplicate tasks");
});

test("draft-only editing: update works on a draft, fails on validated/rejected; bad input → 400", async () => {
  const p = await post("/api/project", { name: "plan-edit" });
  const pid = p.body.project.id;

  const created = await post("/api/plan/new", { objective: "First version", projectId: pid,
    taskDrafts: [{ title: "only step" }] });
  const plan = created.body.plan;

  const upd = await post("/api/plan/update", { id: plan.id, objective: "Second version",
    decisions: "keep it simple", taskDrafts: [{ title: "step one" }, { title: "step two", dependsOn: [0] }] });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.plan.objective, "Second version");
  assert.equal(upd.body.plan.decisions, "keep it simple");
  assert.equal(upd.body.plan.taskDrafts.length, 2);
  assert.equal(upd.body.plan.status, "draft", "an edit never validates silently");

  // validation errors from plans.mjs map to 400
  assert.equal((await post("/api/plan/new", { objective: " " })).status, 400);
  assert.equal((await post("/api/plan/new", { objective: "x",
    taskDrafts: [{ title: "t", priority: "banana" }] })).status, 400);
  assert.equal((await post("/api/plan/update", { id: "ghost" })).status, 400);
  assert.equal((await post("/api/plan/validate", { id: "ghost" })).status, 400);
  assert.equal((await post("/api/plan/materialize", { id: "ghost" })).status, 404);

  // validated: no more edits, and rejecting is off the table too
  await post("/api/plan/validate", { id: plan.id });
  assert.equal((await post("/api/plan/update", { id: plan.id, objective: "nope" })).status, 400);
  assert.equal((await post("/api/plan/reject", { id: plan.id })).status, 400);

  // rejected: terminal, no edits
  const rej = await post("/api/plan/new", { objective: "Throwaway", projectId: pid,
    taskDrafts: [{ title: "x step" }] });
  assert.equal((await post("/api/plan/reject", { id: rej.body.plan.id })).status, 200);
  assert.equal((await post("/api/plan/update", { id: rej.body.plan.id, objective: "nope" })).status, 400);
  assert.equal((await post("/api/plan/materialize", { id: rej.body.plan.id })).status, 409);
});

test("/api/state carries plans (and the i18n catalogs stay at parity)", async () => {
  const st = await state();
  assert.ok(Array.isArray(st.plans), "plans flow through /api/state");
  assert.ok(st.plans.length >= 2, "the plans created above are there");
  const one = st.plans.find((p) => p.objective === "Ship the exporter");
  assert.equal(one.status, "materialized");
  assert.equal(one.taskIds.length, 3);

  const { LOCALES, missingKeys } = await import("./i18n.mjs");
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
});

test("plan mode in a project thread drafts a Plan card — mission flow untouched, nothing auto-materializes", async () => {
  const p = await post("/api/project", { name: "plan-mode-proj" });
  const pid = p.body.project.id;

  // No model is configured in this workspace: the planner pass is skipped honestly, the draft
  // still lands (objective only — the owner/Brain fills the steps later).
  const send = await post("/api/chat/send", { scope: "company", mode: "plan",
    text: "set up the customer portal end-to-end", projectId: pid });
  assert.equal(send.status, 200, JSON.stringify(send.body).slice(0, 300));
  assert.ok(send.body.mission, "the mission draft (existing flow) still happens");
  const plan = send.body.plan;
  assert.ok(plan, "a DRAFT plan card lands too");
  assert.equal(plan.status, "draft");
  assert.equal(plan.projectId, pid);
  assert.equal(plan.conversationId, send.body.conversation.id);
  assert.match(send.body.conversation.messages.at(-1).text, /also drafted a plan/);

  // The gate holds for chat-drafted plans exactly the same.
  const refused = await post("/api/plan/materialize", { id: plan.id });
  assert.equal(refused.status, 409);
  // …and a plan with no task drafts cannot be validated into existence either.
  assert.equal((await post("/api/plan/validate", { id: plan.id })).status, 400);
});

test("refinement loop: a normal message in a draft-plan thread — honest without a model, draft untouched", async () => {
  const p = await post("/api/project", { name: "plan-refine" });
  const pid = p.body.project.id;
  const send = await post("/api/chat/send", { scope: "company", mode: "ask", text: "let us plan the portal", projectId: pid });
  const convId = send.body.conversation.id;

  const created = await post("/api/plan/new", { objective: "Portal plan", projectId: pid,
    conversationId: convId, taskDrafts: [{ title: "first step" }] });
  assert.equal(created.status, 200);
  const planId = created.body.plan.id;

  // A work-imperative message must NOT auto-draft a mission here — the thread is planning.
  const refine = await post("/api/chat/send", { conversationId: convId, mode: "ask",
    text: "create a QA step for the plan" });
  assert.equal(refine.status, 200);
  assert.equal(refine.body.mission, null, "no mission hijack while a draft plan is open");
  const reply = refine.body.conversation.messages.at(-1).text;
  assert.match(reply, /needs a conversation model/, reply);
  assert.match(reply, /validate the draft as-is/, reply);

  // The draft is unchanged — and it CAN still be validated as-is (the owner gate works model-free).
  const st = await state();
  const after = st.plans.find((x) => x.id === planId);
  assert.equal(after.status, "draft");
  assert.equal(after.taskDrafts.length, 1);
  const ok = await post("/api/plan/validate", { id: planId });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.status, "validated");
});

test("materialize is validate-then-write: forward refs resolve, a failure leaks ZERO tasks", async () => {
  const p = await post("/api/project", { name: "plan-atomic" });
  const pid = p.body.project.id;

  // Forward references: draft 0 depends on a LATER draft (legal per plans.mjs — only self-deps
  // are banned). Every created task's dependsOn must point at real created task ids.
  const fwd = await post("/api/plan/new", { objective: "Forward refs", projectId: pid, taskDrafts: [
    { title: "integrate the api", dependsOn: [1] },
    { title: "build the api", dependsOn: [2] },
    { title: "design the api" },
  ] });
  assert.equal(fwd.status, 200, JSON.stringify(fwd.body).slice(0, 300));
  await post("/api/plan/validate", { id: fwd.body.plan.id });
  const done = await post("/api/plan/materialize", { id: fwd.body.plan.id });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  const [t0, t1, t2] = done.body.tasks;
  assert.deepEqual(t0.dependsOn, [t1.id], "forward ref: draft 0 → task 1");
  assert.deepEqual(t1.dependsOn, [t2.id], "forward ref: draft 1 → task 2");
  assert.deepEqual(t2.dependsOn, []);

  // A failure mid-creation must persist NOTHING and leave the plan validated (not stuck). This
  // draft passes plans.mjs (skills uncapped there) but newTask rejects it (skills capped at 12) —
  // the throw lands after earlier drafts were built, exactly the partial-write trap.
  const bad = await post("/api/plan/new", { objective: "Will fail at tasks.mjs", projectId: pid, taskDrafts: [
    { title: "fine step" },
    { title: "bad step", skills: Array.from({ length: 13 }, (_, i) => `s${i}`) },
  ] });
  assert.equal(bad.status, 200, "plans.mjs accepts it — the failure happens in tasks.mjs");
  assert.equal((await post("/api/plan/validate", { id: bad.body.plan.id })).status, 200);
  const before = (await state()).tasks.length;
  const failed = await post("/api/plan/materialize", { id: bad.body.plan.id });
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /skills/);
  const after = await state();
  assert.equal(after.tasks.length, before, "ZERO tasks leaked by the failed materialization");
  assert.equal(after.tasks.filter((t) => t.planId === bad.body.plan.id).length, 0);
  const still = after.plans.find((x) => x.id === bad.body.plan.id);
  assert.equal(still.status, "validated", "the plan is not stuck — still validated");
  assert.equal(still.taskIds, null, "no materialization recorded");
});

test("parsePlanDraft: deterministic, bounded, fail-closed", async () => {
  const { parsePlanDraft } = await import("./chat.mjs");
  assert.equal(parsePlanDraft(""), null);
  assert.equal(parsePlanDraft("no block here"), null);
  assert.equal(parsePlanDraft("```tasks\nnot json\n```"), null);
  assert.equal(parsePlanDraft('```tasks\n[{"title":"ab"}]\n```'), null, "too-short titles leave nothing");

  const good = parsePlanDraft('OBJECTIVE: ship it\nDECISIONS: esm only\n```tasks\n[{"title":"first step","priority":"high","skills":["node"],"dependsOn":[]},{"title":"second step","dependsOn":[0]}]\n```');
  assert.equal(good.objective, "ship it");
  assert.equal(good.decisions, "esm only");
  assert.equal(good.taskDrafts.length, 2);
  assert.deepEqual(good.taskDrafts[1].dependsOn, [0]);
  assert.equal(good.taskDrafts[0].priority, "high");
  assert.deepEqual(good.taskDrafts[0].skills, ["node"]);

  // clamped: over the max, out-of-range indexes, self-deps, unknown priorities — never a throw
  const wild = parsePlanDraft("```tasks\n" + JSON.stringify([
    ...Array.from({ length: 8 }, (_, i) => ({ title: `step ${i}`, dependsOn: [i, 7], priority: "banana" })),
  ]) + "\n```");
  assert.equal(wild.taskDrafts.length, 6);
  for (const [i, d] of wild.taskDrafts.entries()) {
    assert.equal(d.priority, "none");
    assert.ok(d.dependsOn.every((x) => x >= 0 && x < 6 && x !== i), "indexes re-clamped to the final list");
  }
});
