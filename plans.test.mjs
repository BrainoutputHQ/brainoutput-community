// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { newPlan, updateDraft, validatePlan, rejectPlan, markMaterialized, planById,
  projectPlans, latestProjectPlan, PLAN_STATUSES, TASK_PRIORITIES } from "./plans.mjs";

const oneDraft = (over = {}) => ({ title: "Wire the store", ...over });
const rt = (plans) => ({ plans });
const draftPlan = (over = {}) => newPlan({ id: "pl1", projectId: "p1",
  objective: "Ship the exporter", decisions: "use the store", reporter: "u1",
  taskDrafts: [oneDraft()], at: 1, ...over });

test("newPlan builds a draft with defaults; lookups read runtime.plans (undefined = empty)", () => {
  const p = draftPlan();
  assert.equal(p.status, "draft");
  assert.equal(p.id, "pl1");
  assert.equal(p.projectId, "p1");
  assert.equal(p.taskIds, null);
  assert.equal(p.createdAt, 1);
  assert.ok(PLAN_STATUSES.includes(p.status));
  assert.deepEqual(TASK_PRIORITIES, ["urgent", "high", "medium", "low", "none"]);
  assert.ok(newPlan({ objective: "x" }).id.startsWith("plan-"));
  assert.equal(planById(rt([p]), "pl1"), p);
  assert.equal(planById(rt([p]), "ghost"), null);
  assert.equal(planById({}, "pl1"), null);
  assert.deepEqual(projectPlans({}, "p1"), []);
  const older = newPlan({ id: "pl0", projectId: "p1", objective: "old", taskDrafts: [oneDraft()] });
  const other = newPlan({ id: "pl9", projectId: "p2", objective: "other", taskDrafts: [oneDraft()] });
  const runtime = rt([older, p, other]);
  assert.deepEqual(projectPlans(runtime, "p1").map((x) => x.id), ["pl0", "pl1"]);
  assert.equal(latestProjectPlan(runtime, "p1"), p);
  assert.equal(latestProjectPlan(runtime, "p2"), other);
  assert.equal(latestProjectPlan(runtime, "p3"), null);
});

test("task drafts carry every directive field with defaults applied", () => {
  const p = newPlan({ objective: "x", taskDrafts: [oneDraft()] });
  assert.deepEqual(p.taskDrafts[0], { title: "Wire the store", objective: "Wire the store",
    skills: [], agentSlot: null, restrictions: {}, priority: "none", dependsOn: [],
    acceptanceCriteria: [] });
  const full = newPlan({ objective: "x", taskDrafts: [
    { title: "A", objective: "build A", skills: ["node"], agentSlot: "dev-1",
      restrictions: { network: false }, priority: "high", dependsOn: [1],
      acceptanceCriteria: ["tests pass"] },
    oneDraft(),
  ] });
  assert.deepEqual(full.taskDrafts[0], { title: "A", objective: "build A", skills: ["node"],
    agentSlot: "dev-1", restrictions: { network: false }, priority: "high", dependsOn: [1],
    acceptanceCriteria: ["tests pass"] });
});

test("the status machine allows only draft→validated→materialized and draft→rejected", () => {
  const runtime = rt([draftPlan()]);
  const v = validatePlan(runtime, "pl1", { at: 2 });
  assert.equal(v.status, "validated");
  assert.equal(v.validatedAt, 2);
  const m = markMaterialized(rt([v]), "pl1", ["t1", "t2"], { at: 3 });
  assert.equal(m.status, "materialized");
  assert.equal(m.materializedAt, 3);
  const r = rejectPlan(runtime, "pl1", { at: 4 });
  assert.equal(r.status, "rejected");
  assert.equal(r.rejectedAt, 4);
  // every other transition throws
  assert.throws(() => validatePlan(rt([v]), "pl1"), /validated/);
  assert.throws(() => rejectPlan(rt([v]), "pl1"), /validated/);
  assert.throws(() => updateDraft(rt([v]), "pl1", { objective: "y" }), /draft/);
  assert.throws(() => markMaterialized(runtime, "pl1", ["t1"]), /validated/);
  assert.throws(() => validatePlan(rt([m]), "pl1"), /draft/);
  assert.throws(() => rejectPlan(rt([m]), "pl1"), /draft/);
  assert.throws(() => updateDraft(rt([m]), "pl1", { objective: "y" }), /draft/);
  assert.throws(() => markMaterialized(rt([m]), "pl1", ["t3"]), /validated/);
  assert.throws(() => validatePlan(rt([r]), "pl1"), /draft/);
  assert.throws(() => updateDraft(rt([r]), "pl1", { objective: "y" }), /draft/);
  assert.throws(() => markMaterialized(rt([r]), "pl1", ["t3"]), /validated/);
  for (const fn of [updateDraft, validatePlan, rejectPlan, markMaterialized])
    assert.throws(() => fn(runtime, "ghost", {}), /no plan/);
});

test("updateDraft edits a draft and re-validates; unknown fields cannot leak in", () => {
  const runtime = rt([draftPlan()]);
  const up = updateDraft(runtime, "pl1", { objective: "Ship v2", context: "greenfield",
    decisions: "esm only", taskDrafts: [oneDraft({ priority: "urgent" }), oneDraft({ title: "B", dependsOn: [0] })], at: 9 });
  assert.equal(up.objective, "Ship v2");
  assert.equal(up.context, "greenfield");
  assert.equal(up.decisions, "esm only");
  assert.equal(up.taskDrafts.length, 2);
  assert.equal(up.taskDrafts[0].priority, "urgent");
  assert.deepEqual(up.taskDrafts[1].dependsOn, [0]);
  assert.equal(up.updatedAt, 9);
  assert.equal(up.status, "draft");
  assert.throws(() => updateDraft(runtime, "pl1", { objective: " " }), /objective/);
  assert.throws(() => updateDraft(runtime, "pl1", { taskDrafts: [oneDraft({ priority: "banana" })] }), /priority/);
  const noLeak = updateDraft(runtime, "pl1", { status: "validated", taskIds: ["hack"] });
  assert.equal(noLeak.status, "draft");
  assert.equal(noLeak.taskIds, null);
});

test("bounds are enforced at creation and on edit", () => {
  const drafts25 = Array.from({ length: 25 }, (_, i) => oneDraft({ title: `t${i}` }));
  assert.throws(() => newPlan({ objective: "x", taskDrafts: drafts25 }), /24/);
  assert.throws(() => newPlan({ objective: "x", taskDrafts: [oneDraft({ title: "t".repeat(121) })] }), /120/);
  assert.throws(() => newPlan({ objective: "x", taskDrafts: [oneDraft({
    acceptanceCriteria: Array.from({ length: 21 }, (_, i) => `ac${i}`) })] }), /20/);
  assert.throws(() => newPlan({ objective: "x", taskDrafts: [oneDraft({
    acceptanceCriteria: ["a".repeat(501)] })] }), /500/);
  assert.throws(() => newPlan({ objective: "o".repeat(4001) }), /4000/);
  assert.throws(() => newPlan({ objective: "x", decisions: "d".repeat(4001) }), /4000/);
  assert.throws(() => newPlan({ objective: " " }), /objective/);
  const runtime = rt([draftPlan()]);
  assert.throws(() => updateDraft(runtime, "pl1", { taskDrafts: drafts25 }), /24/);
  assert.equal(newPlan({ objective: "o".repeat(4000) }).objective.length, 4000);
  assert.equal(newPlan({ objective: "x", taskDrafts: [oneDraft({ title: "t".repeat(120) })] })
    .taskDrafts[0].title.length, 120);
});

test("validatePlan checks the draft graph: drafts exist, dependsOn in range, no self-deps, known priorities", () => {
  const noDrafts = newPlan({ id: "pl0", objective: "x" });
  assert.throws(() => validatePlan(rt([noDrafts]), "pl0"), /task drafts/);
  // plans born via newPlan are always sane — inject broken records like a corrupted store would
  const badIndex = { ...draftPlan({ id: "pl2" }), taskDrafts: [oneDraft({ dependsOn: [1] })] };
  assert.throws(() => validatePlan(rt([badIndex]), "pl2"), /does not exist/);
  const selfDep = { ...draftPlan({ id: "pl3" }), taskDrafts: [oneDraft({ dependsOn: [0] })] };
  assert.throws(() => validatePlan(rt([selfDep]), "pl3"), /itself/);
  const badPrio = { ...draftPlan({ id: "pl4" }), taskDrafts: [oneDraft({ priority: "banana" })] };
  assert.throws(() => validatePlan(rt([badPrio]), "pl4"), /priority/);
  const noTitle = { ...draftPlan({ id: "pl5" }), taskDrafts: [oneDraft({ title: " " })] };
  assert.throws(() => validatePlan(rt([noTitle]), "pl5"), /title/);
  // and the same bad input is rejected at birth
  assert.throws(() => newPlan({ objective: "x", taskDrafts: [oneDraft({ dependsOn: [7] })] }), /does not exist/);
  assert.throws(() => newPlan({ objective: "x", taskDrafts: [oneDraft({ dependsOn: [0] })] }), /itself/);
  assert.throws(() => newPlan({ objective: "x", taskDrafts: [oneDraft({ priority: "banana" })] }), /priority/);
  const ok = validatePlan(rt([draftPlan()]), "pl1");
  assert.equal(ok.status, "validated");
});

test("markMaterialized records the created task ids and freezes the plan", () => {
  const v = validatePlan(rt([draftPlan()]), "pl1");
  const m = markMaterialized(rt([v]), "pl1", ["task-a", "task-b"], { at: 5 });
  assert.deepEqual(m.taskIds, ["task-a", "task-b"]);
  assert.equal(m.status, "materialized");
  assert.throws(() => updateDraft(rt([m]), "pl1", { objective: "sneaky edit" }), /draft/);
  assert.throws(() => validatePlan(rt([m]), "pl1"), /draft/);
  assert.throws(() => rejectPlan(rt([m]), "pl1"), /draft/);
});

test("immutability: neither the runtime nor the caller's objects are mutated", () => {
  const input = { title: "Wire the store", dependsOn: [], skills: ["node"] };
  const inputSnapshot = JSON.stringify(input);
  const p = newPlan({ id: "pl1", projectId: "p1", objective: "Ship", taskDrafts: [input], at: 1 });
  assert.equal(JSON.stringify(input), inputSnapshot);
  const runtime = rt([p]);
  const snapshot = JSON.stringify(runtime);
  const up = updateDraft(runtime, "pl1", { objective: "Ship v2" });
  const v = validatePlan(runtime, "pl1");
  const m = markMaterialized(rt([v]), "pl1", ["t1"]);
  rejectPlan(runtime, "pl1");
  assert.equal(JSON.stringify(runtime), snapshot);
  assert.notEqual(up, p);
  assert.notEqual(v, p);
  assert.notEqual(m, p);
  assert.notEqual(up.taskDrafts, p.taskDrafts);
  p.taskDrafts[0].skills.push("mutated");
  assert.deepEqual(up.taskDrafts[0].skills, ["node"]);
});
