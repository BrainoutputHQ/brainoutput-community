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
// Directive priorities (Plane-style). "none" is the default — an unprioritized task is a
// normal task; the enum exists so triage ("what first?") is data, not chat memory.
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const MAX_DEPTH = 2;
const MAX_ACCEPTANCE = 20, MAX_ACCEPTANCE_CHARS = 500, MAX_SKILLS = 12;
// Worker escalation (task-pm-05): a worker question is short, an answer is bounded too.
const MAX_QUESTION_CHARS = 500, MAX_ANSWER_CHARS = 2000;

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

export function newTask({ id, projectId = null, parentId = null, title, assignee = null,
  objective = null, status = "todo", reporter = null, at = null,
  acceptanceCriteria = [], skills = [], agentSlot = null, restrictions = {},
  priority = "none", dependsOn = [], planId = null } = {}) {
  const t = String(title || objective || "").trim();
  if (!t) throw new Error("a task needs a title");
  if (!TASK_STATUSES.includes(status)) throw new Error(`unknown task status '${status}'`);
  if (!TASK_PRIORITIES.includes(priority)) throw new Error(`unknown task priority '${priority}'`);
  if (!isStringArray(acceptanceCriteria)) throw new Error("acceptanceCriteria must be an array of strings");
  if (acceptanceCriteria.length > MAX_ACCEPTANCE) throw new Error(`acceptanceCriteria is capped at ${MAX_ACCEPTANCE} items`);
  if (acceptanceCriteria.some((c) => c.length > MAX_ACCEPTANCE_CHARS)) throw new Error(`acceptanceCriteria items are capped at ${MAX_ACCEPTANCE_CHARS} chars`);
  if (!isStringArray(skills)) throw new Error("skills must be an array of strings");
  if (skills.length > MAX_SKILLS) throw new Error(`skills is capped at ${MAX_SKILLS} items`);
  if (!isStringArray(dependsOn)) throw new Error("dependsOn must be an array of task ids");
  if (agentSlot !== null && typeof agentSlot !== "string") throw new Error("agentSlot must be a string or null");
  if (planId !== null && typeof planId !== "string") throw new Error("planId must be a string or null");
  if (typeof restrictions !== "object" || restrictions === null || Array.isArray(restrictions))
    throw new Error("restrictions must be an object");
  // Issue parameters (Plane-style): assignee = who is in charge, reporter = who asked.
  return { id: id || `task-${Date.now().toString(36)}`, projectId, parentId, title: t,
    objective: objective || t, assignee, reporter, status, missionId: null, result: null,
    acceptanceCriteria: [...acceptanceCriteria], skills: [...skills], agentSlot,
    restrictions: { ...restrictions }, priority, dependsOn: [...dependsOn], planId,
    createdAt: at, updatedAt: at };
}

const byId = (runtime, id) => (runtime.tasks || []).find((t) => t.id === id) || null;

/**
 * Validate a task's dependsOn against the runtime: every referenced id must be an existing
 * task, and a task may never depend on itself. newTask cannot check this (it is pure and
 * has no runtime), so callers that DO have the runtime — newSubtask, the API layer — run
 * this before persisting.
 */
export function assertTaskDeps(runtime, task) {
  for (const depId of task.dependsOn || []) {
    if (depId === task.id) throw new Error(`'${task.title}' cannot depend on itself`);
    if (!byId(runtime, depId)) throw new Error(`'${task.title}' depends on unknown task '${depId}'`);
  }
  return task;
}

/** Add a subtask under `parentId`. A subtask may not itself parent subtasks (bounded depth). */
export function newSubtask(runtime, parentId, fields = {}) {
  const parent = byId(runtime, parentId);
  if (!parent) throw new Error(`no task '${parentId}'`);
  if (parent.parentId) throw new Error(`'${parent.title}' is itself a subtask — depth is ${MAX_DEPTH - 1} level, keep the tree readable`);
  return assertTaskDeps(runtime, newTask({ ...fields, parentId, projectId: fields.projectId ?? parent.projectId }));
}

/** The OPEN tasks (status !== "done") this task depends on — its current blockers. */
export const blockersOf = (runtime, task) =>
  (task.dependsOn || []).map((id) => byId(runtime, id)).filter((t) => t && t.status !== "done");

export const isBlocked = (runtime, task) => blockersOf(runtime, task).length > 0;

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

/**
 * WORKER ESCALATION (task-pm-05): a worker may pause its task with ONE question instead of
 * guessing. The task flips to blocked with the question pending on the record — other spine
 * tasks keep running; the planner or the owner answers; the worker re-runs with the answer.
 * Migration-safe: qna/pendingQuestion only appear on a record once a question was asked.
 */
export function askTaskQuestion(runtime, id, question, { at = null } = {}) {
  const task = byId(runtime, id);
  if (!task) throw new Error(`no task '${id}'`);
  const q = String(question || "").trim();
  if (!q) throw new Error("a task question needs text");
  if (q.length > MAX_QUESTION_CHARS) throw new Error(`a task question is capped at ${MAX_QUESTION_CHARS} characters`);
  if (task.pendingQuestion) throw new Error(`task '${id}' already has a pending question`);
  return { ...task, status: "blocked", pendingQuestion: { question: q, at }, updatedAt: at };
}

/**
 * Answer a task's pending question: appended to the durable qna history ({question, answer,
 * by, at}), the pending question clears, and the task goes back to in-progress so its worker
 * stage re-runs with the answer in its prompt. `by` is "owner" or "planner" (auto-answer).
 */
export function answerTaskQuestion(runtime, id, answer, { by = "owner", at = null } = {}) {
  const task = byId(runtime, id);
  if (!task) throw new Error(`no task '${id}'`);
  const a = String(answer || "").trim();
  if (!a) throw new Error("a task answer needs text");
  if (a.length > MAX_ANSWER_CHARS) throw new Error(`a task answer is capped at ${MAX_ANSWER_CHARS} characters`);
  if (!task.pendingQuestion) throw new Error(`task '${id}' has no pending question`);
  const qna = [...(Array.isArray(task.qna) ? task.qna : []),
    { question: task.pendingQuestion.question, answer: a, by: String(by || "owner"), at }];
  return { ...task, status: "in-progress", pendingQuestion: null, qna, updatedAt: at };
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
