// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — the durable Plan artifact (2026-08-01, task-pm-01).
// A Plan is what the planner commits to BEFORE any spine task exists: the refined objective,
// the shared DECISIONS every worker must respect, and task drafts with their dependencies.
// It moves draft → validated → materialized (or draft → rejected) — no other transitions, and
// only a draft may be edited. Materialization records the created spine-task ids and freezes
// the plan forever: an audit trail of WHY those tasks exist. Pure logic over the runtime
// object; zero-dep; the caller persists the returned plan via the Store (runtime.plans).
export const PLAN_STATUSES = ["draft", "validated", "rejected", "materialized"];
export const TASK_PRIORITIES = ["urgent", "high", "medium", "low", "none"];

const MAX_DRAFTS = 24;
const MAX_TITLE = 120;
const MAX_AC_ITEMS = 20;
const MAX_AC_CHARS = 500;
const MAX_CHARS = 4000;   // plan objective and decisions share one bound

const check = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Normalize one task draft to the directive shape (defaults applied) and validate it. */
function normDraft(raw = {}, i, count) {
  const title = String(raw.title || "").trim();
  check(title, `task draft ${i} needs a title`);
  check(title.length <= MAX_TITLE, `task draft ${i} title is over ${MAX_TITLE} characters`);
  const priority = raw.priority ?? "none";
  check(TASK_PRIORITIES.includes(priority), `unknown priority '${priority}' on task draft ${i}`);
  const dependsOn = [...(raw.dependsOn || [])];
  for (const d of dependsOn) {
    check(Number.isInteger(d) && d >= 0 && d < count,
      `task draft ${i} depends on a draft index that does not exist (${d})`);
    check(d !== i, `task draft ${i} cannot depend on itself`);
  }
  const acceptanceCriteria = [...(raw.acceptanceCriteria || [])];
  check(acceptanceCriteria.length <= MAX_AC_ITEMS,
    `task draft ${i} has over ${MAX_AC_ITEMS} acceptance criteria`);
  for (const ac of acceptanceCriteria)
    check(String(ac).length <= MAX_AC_CHARS,
      `acceptance criterion over ${MAX_AC_CHARS} characters on task draft ${i}`);
  return { title, objective: raw.objective || title, skills: [...(raw.skills || [])],
    agentSlot: raw.agentSlot ?? null, restrictions: { ...(raw.restrictions || {}) },
    priority, dependsOn, acceptanceCriteria };
}

/** Validate plan-level fields and every draft; returns the normalized drafts array. */
function checkPlan({ objective, decisions, taskDrafts }, { requireDrafts = false } = {}) {
  const obj = String(objective || "").trim();
  check(obj, "a plan needs an objective");
  check(obj.length <= MAX_CHARS, `plan objective is over ${MAX_CHARS} characters`);
  check(!decisions || String(decisions).length <= MAX_CHARS,
    `plan decisions are over ${MAX_CHARS} characters`);
  const drafts = taskDrafts || [];
  if (requireDrafts) check(drafts.length >= 1, "cannot be validated without task drafts");
  check(drafts.length <= MAX_DRAFTS, `a plan holds at most ${MAX_DRAFTS} task drafts`);
  return drafts.map((d, i) => normDraft(d, i, drafts.length));
}

export function newPlan({ id, projectId = null, objective, context = null, decisions = null,
  taskDrafts = [], reporter = null, at = null } = {}) {
  const drafts = checkPlan({ objective, decisions, taskDrafts });
  return { id: id || `plan-${Date.now().toString(36)}`, projectId,
    objective: String(objective).trim(), context, decisions, taskDrafts: drafts,
    reporter, status: "draft", taskIds: null,
    createdAt: at, updatedAt: at, validatedAt: null, rejectedAt: null, materializedAt: null };
}

export const planById = (runtime, id) => (runtime.plans || []).find((p) => p.id === id) || null;

export const projectPlans = (runtime, projectId) =>
  (runtime.plans || []).filter((p) => p.projectId === projectId);

/** The most recent plan of a project (plans are persisted in creation order). */
export function latestProjectPlan(runtime, projectId) {
  const plans = projectPlans(runtime, projectId);
  return plans.length ? plans[plans.length - 1] : null;
}

/** Edit a draft plan: objective, context, decisions, taskDrafts. Re-validates the result. */
export function updateDraft(runtime, id, fields = {}) {
  const plan = planById(runtime, id);
  check(plan, `no plan '${id}'`);
  check(plan.status === "draft", `plan '${id}' is ${plan.status} — only a draft can be edited`);
  const { at = null, ...edits } = fields;
  const next = { objective: edits.objective ?? plan.objective,
    context: edits.context !== undefined ? edits.context : plan.context,
    decisions: edits.decisions !== undefined ? edits.decisions : plan.decisions,
    taskDrafts: edits.taskDrafts ?? plan.taskDrafts };
  const drafts = checkPlan(next);
  return { ...plan, objective: String(next.objective).trim(), context: next.context,
    decisions: next.decisions, taskDrafts: drafts, updatedAt: at };
}

export function validatePlan(runtime, id, { at = null } = {}) {
  const plan = planById(runtime, id);
  check(plan, `no plan '${id}'`);
  check(plan.status === "draft", `plan '${id}' is ${plan.status} — only a draft can be validated`);
  const drafts = checkPlan(plan, { requireDrafts: true });
  return { ...plan, taskDrafts: drafts, status: "validated", validatedAt: at, updatedAt: at };
}

export function rejectPlan(runtime, id, { at = null } = {}) {
  const plan = planById(runtime, id);
  check(plan, `no plan '${id}'`);
  check(plan.status === "draft", `plan '${id}' is ${plan.status} — only a draft can be rejected`);
  return { ...plan, status: "rejected", rejectedAt: at, updatedAt: at };
}

/** A validated plan lands: record the created spine-task ids and freeze the plan. */
export function markMaterialized(runtime, id, taskIds, { at = null } = {}) {
  const plan = planById(runtime, id);
  check(plan, `no plan '${id}'`);
  check(plan.status === "validated",
    `plan '${id}' is ${plan.status} — only a validated plan can be materialized`);
  return { ...plan, status: "materialized", taskIds: [...(taskIds || [])],
    materializedAt: at, updatedAt: at };
}
