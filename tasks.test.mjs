// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { newTask, newSubtask, setTaskStatus, reportMissionToTask, subtasksOf,
  taskTree, taskProgress, TASK_STATUSES } from "./tasks.mjs";

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
