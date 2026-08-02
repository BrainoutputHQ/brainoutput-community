// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — the task spine (2026-07-30, Directive 6).
// Without bundling a PM suite, a customer still needs real structure: tasks and subtasks
// per project, statuses, and results reported back. A task lives in the same runtime store
// as everything else — backed up, exported, restored with the company. A task may be manual
// (the user adds it) or mission-backed (work the Brain did reports INTO it — that link is
// the "report results to users" path). Pure logic over the runtime object; zero-dep.
//
// Hierarchy: task.parentId → one level of subtasks is enough for an SMB (a subtask cannot
// have subtasks — depth is bounded so trees stay readable and progress stays computable).
export const TASK_STATUSES = ["todo", "in-progress", "blocked", "done"];
const MAX_DEPTH = 2;

export function newTask({ id, projectId = null, parentId = null, title, assignee = null,
  objective = null, status = "todo", reporter = null, at = null } = {}) {
  const t = String(title || objective || "").trim();
  if (!t) throw new Error("a task needs a title");
  if (!TASK_STATUSES.includes(status)) throw new Error(`unknown task status '${status}'`);
  // Issue parameters (Plane-style): assignee = who is in charge, reporter = who asked.
  return { id: id || `task-${Date.now().toString(36)}`, projectId, parentId, title: t,
    objective: objective || t, assignee, reporter, status, missionId: null, result: null,
    createdAt: at, updatedAt: at };
}

const byId = (runtime, id) => (runtime.tasks || []).find((t) => t.id === id) || null;

/** Add a subtask under `parentId`. A subtask may not itself parent subtasks (bounded depth). */
export function newSubtask(runtime, parentId, fields = {}) {
  const parent = byId(runtime, parentId);
  if (!parent) throw new Error(`no task '${parentId}'`);
  if (parent.parentId) throw new Error(`'${parent.title}' is itself a subtask — depth is ${MAX_DEPTH - 1} level, keep the tree readable`);
  return newTask({ ...fields, parentId, projectId: fields.projectId ?? parent.projectId });
}

export function setTaskStatus(runtime, id, status, { at = null } = {}) {
  const task = byId(runtime, id);
  if (!task) throw new Error(`no task '${id}'`);
  if (!TASK_STATUSES.includes(status)) throw new Error(`unknown task status '${status}'`);
  return { ...task, status, updatedAt: at };
}

/**
 * Report a mission result INTO its task: status → done (or blocked on failure) with the
 * result summary + artifact refs. This is the reporting path — the user reads outcomes on
 * the task, not in logs.
 */
export function reportMissionToTask(runtime, taskId, { missionId, ok, summary = null, artifacts = [], at = null } = {}) {
  const task = byId(runtime, taskId);
  if (!task) throw new Error(`no task '${taskId}'`);
  return { ...task, missionId: missionId || task.missionId,
    status: ok ? "done" : "blocked",
    result: { ok: !!ok, summary: summary || (ok ? "done" : "failed"), artifacts: [...artifacts], at },
    updatedAt: at };
}

export const subtasksOf = (runtime, id) => (runtime.tasks || []).filter((t) => t.parentId === id);
export const projectTasks = (runtime, projectId) =>
  (runtime.tasks || []).filter((t) => t.projectId === projectId && !t.parentId);

/** The tree for one project: top-level tasks each carrying their subtasks. */
export function taskTree(runtime, projectId) {
  return projectTasks(runtime, projectId).map((t) => ({ ...t, subtasks: subtasksOf(runtime, t.id) }));
}

/**
 * Progress rollup for "where are we?": done/total over a task AND its subtasks — a parent is
 * never counted done while a subtask is open, so the number can't lie about the project.
 */
export function taskProgress(runtime, projectId) {
  const top = (runtime.tasks || []).filter((t) => t.projectId === projectId && !t.parentId);
  const flat = top.flatMap((t) => [t, ...subtasksOf(runtime, t.id)]);
  const total = flat.length;
  const openSubtask = (t) => subtasksOf(runtime, t.id).some((s) => s.status !== "done");
  const done = flat.filter((t) => t.status === "done" && !openSubtask(t)).length;
  const blocked = flat.filter((t) => t.status === "blocked").length;
  return { total, done, blocked, open: total - done, pct: total ? Math.round((done / total) * 100) : 0 };
}
