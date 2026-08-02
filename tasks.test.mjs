// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { newTask, newSubtask, setTaskStatus, reportMissionToTask, subtasksOf,
  taskTree, taskProgress, assertTaskDeps, blockersOf, isBlocked,
  TASK_STATUSES, TASK_PRIORITIES } from "./tasks.mjs";

const rt = () => ({ tasks: [
  { id: "t1", projectId: "p1", parentId: null, title: "Build the converter", status: "in-progress", result: null },
  { id: "t1a", projectId: "p1", parentId: "t1", title: "PDF → text", status: "done", result: { ok: true } },
  { id: "t1b", projectId: "p1", parentId: "t1", title: "PDF → images", status: "todo", result: null },
  { id: "t2", projectId: "p1", parentId: null, title: "Landing page", status: "done", result: { ok: true } },
  { id: "t3", projectId: "p2", parentId: null, title: "Other project task", status: "todo", result: null },
] });

test("tasks need a title and a known status", () => {
  assert.ok(newTask({ title: "x" }).id);
  assert.throws(() => newTask({ title: " " }), /title/);
  assert.throws(() => newTask({ title: "x", status: "banana" }), /status/);
  assert.ok(TASK_STATUSES.includes("blocked"));
});

test("subtasks attach to a parent and inherit its project; depth is bounded", () => {
  const sub = newSubtask(rt(), "t1", { title: "OCR fallback" });
  assert.equal(sub.parentId, "t1");
  assert.equal(sub.projectId, "p1");
  assert.throws(() => newSubtask(rt(), "t1a", { title: "too deep" }), /depth/);
  assert.throws(() => newSubtask(rt(), "ghost", { title: "x" }), /no task/);
});

test("status moves are validated and timestamped", () => {
  const t = setTaskStatus(rt(), "t1b", "in-progress", { at: 42 });
  assert.equal(t.status, "in-progress");
  assert.equal(t.updatedAt, 42);
  assert.throws(() => setTaskStatus(rt(), "t1b", "flying"), /status/);
  assert.throws(() => setTaskStatus(rt(), "ghost", "done"), /no task/);
});

test("a mission reports INTO its task: done with artifacts, or blocked with the failure", () => {
  const ok = reportMissionToTask(rt(), "t1b", { missionId: "m1", ok: true, summary: "converted 3 files", artifacts: ["a.pdf", "b.pdf"], at: 7 });
  assert.equal(ok.status, "done");
  assert.equal(ok.missionId, "m1");
  assert.deepEqual(ok.result, { ok: true, summary: "converted 3 files", artifacts: ["a.pdf", "b.pdf"], at: 7 });

  const bad = reportMissionToTask(rt(), "t1b", { missionId: "m2", ok: false, summary: "model offline" });
  assert.equal(bad.status, "blocked");
  assert.equal(bad.result.ok, false);
});

test("the tree nests subtasks under their parents, per project only", () => {
  const tree = taskTree(rt(), "p1");
  assert.deepEqual(tree.map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(tree[0].subtasks.map((s) => s.id), ["t1a", "t1b"]);
  assert.deepEqual(subtasksOf(rt(), "t2"), []);
});

test("progress: a parent with an open subtask is not done — the number cannot lie", () => {
  const p = taskProgress(rt(), "p1");
  // t1 (open subtask t1b → not done), t1a done, t1b open, t2 done → done 2 / 4, t3 excluded
  assert.deepEqual(p, { total: 4, done: 2, blocked: 0, open: 2, pct: 50 });
  const r2 = rt();
  r2.tasks[2].status = "done";   // t1b done
  r2.tasks[0].status = "done";   // t1 itself done → now the whole tree counts
  const p2 = taskProgress(r2, "p1");
  assert.deepEqual([p2.done, p2.total], [4, 4]);
  assert.equal(p2.pct, 100);
});

test("directive fields default when omitted and validate when given", () => {
  const t = newTask({ title: "x" });
  assert.deepEqual(t.acceptanceCriteria, []);
  assert.deepEqual(t.skills, []);
  assert.equal(t.agentSlot, null);
  assert.deepEqual(t.restrictions, {});
  assert.equal(t.priority, "none");
  assert.deepEqual(t.dependsOn, []);
  assert.equal(t.planId, null);
  assert.deepEqual(TASK_PRIORITIES, ["urgent", "high", "medium", "low", "none"]);

  const full = newTask({ title: "x", priority: "urgent", agentSlot: "coder", planId: "plan-1",
    acceptanceCriteria: ["it compiles"], skills: ["node"], restrictions: { network: false },
    dependsOn: ["t1"] });
  assert.equal(full.priority, "urgent");
  assert.equal(full.agentSlot, "coder");
  assert.equal(full.planId, "plan-1");
  assert.deepEqual(full.restrictions, { network: false });

  assert.throws(() => newTask({ title: "x", priority: "whenever" }), /priority/);
});

test("directive field shapes are validated: arrays of strings, bounded sizes", () => {
  assert.throws(() => newTask({ title: "x", acceptanceCriteria: "it works" }), /acceptanceCriteria/);
  assert.throws(() => newTask({ title: "x", acceptanceCriteria: [42] }), /acceptanceCriteria/);
  assert.throws(() => newTask({ title: "x", acceptanceCriteria: Array(21).fill("c") }), /acceptanceCriteria/);
  assert.throws(() => newTask({ title: "x", acceptanceCriteria: ["y".repeat(501)] }), /acceptanceCriteria/);
  assert.ok(newTask({ title: "x", acceptanceCriteria: Array(20).fill("c") }).acceptanceCriteria.length === 20);

  assert.throws(() => newTask({ title: "x", skills: "node" }), /skills/);
  assert.throws(() => newTask({ title: "x", skills: Array(13).fill("s") }), /skills/);

  assert.throws(() => newTask({ title: "x", dependsOn: "t1" }), /dependsOn/);
  assert.throws(() => newTask({ title: "x", dependsOn: [null] }), /dependsOn/);
});

test("assertTaskDeps: unknown ids and self-dependency throw, valid deps pass", () => {
  const t = newTask({ id: "t9", title: "x", dependsOn: ["t1", "t2"] });
  assert.equal(assertTaskDeps(rt(), t), t);
  assert.throws(() => assertTaskDeps(rt(), newTask({ id: "t9", title: "x", dependsOn: ["ghost"] })), /unknown task/);
  assert.throws(() => assertTaskDeps(rt(), newTask({ id: "t9", title: "x", dependsOn: ["t9"] })), /itself/);

  // newSubtask has the runtime, so it enforces deps at creation time.
  const sub = newSubtask(rt(), "t1", { title: "uses t2", dependsOn: ["t2"] });
  assert.deepEqual(sub.dependsOn, ["t2"]);
  assert.throws(() => newSubtask(rt(), "t1", { title: "bad", dependsOn: ["ghost"] }), /unknown task/);
});

test("blockersOf/isBlocked: open deps block, done deps do not", () => {
  const blockedTask = newTask({ id: "t9", title: "x", dependsOn: ["t1b", "t2"] }); // t1b todo, t2 done
  const blockers = blockersOf(rt(), blockedTask);
  assert.deepEqual(blockers.map((b) => b.id), ["t1b"]);
  assert.equal(isBlocked(rt(), blockedTask), true);

  const clearTask = newTask({ id: "t10", title: "y", dependsOn: ["t1a", "t2"] }); // both done
  assert.deepEqual(blockersOf(rt(), clearTask), []);
  assert.equal(isBlocked(rt(), clearTask), false);

  // A task with no dependsOn (old-shape) is never blocked.
  assert.equal(isBlocked(rt(), rt().tasks[0]), false);
  assert.deepEqual(blockersOf(rt(), rt().tasks[0]), []);
});

test("migration: a 2026-07-31-shaped task (no directive fields) behaves exactly as before", () => {
  // Literal old runtime.json record — written before directive fields existed.
  const old = { id: "old-1", projectId: "p1", parentId: null, title: "Legacy task",
    status: "todo", result: null };
  const runtime = { tasks: [old] };

  const moved = setTaskStatus(runtime, "old-1", "in-progress", { at: 9 });
  assert.equal(moved.status, "in-progress");
  assert.equal(moved.updatedAt, 9);
  assert.ok(!Object.values(moved).includes(undefined));

  const reported = reportMissionToTask(runtime, "old-1", { missionId: "m1", ok: true, summary: "shipped", at: 10 });
  assert.equal(reported.status, "done");
  assert.equal(reported.missionId, "m1");
  assert.deepEqual(reported.result, { ok: true, summary: "shipped", artifacts: [], at: 10 });
  assert.ok(!Object.values(reported).includes(undefined));

  // The stored record is untouched (immutability) and still reads through the projections.
  assert.deepEqual(old, { id: "old-1", projectId: "p1", parentId: null, title: "Legacy task",
    status: "todo", result: null });
  assert.deepEqual(taskTree(runtime, "p1").map((t) => t.id), ["old-1"]);
  assert.deepEqual(taskProgress(runtime, "p1"), { total: 1, done: 0, blocked: 0, open: 1, pct: 0 });
  assert.equal(isBlocked(runtime, old), false);
});
