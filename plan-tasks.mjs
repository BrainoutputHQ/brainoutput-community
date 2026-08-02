// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — plan → spine tasks (2026-08-01, focus (1)).
// A planner's job must LAND: the planner stage is asked for a fenced task block, its steps become
// REAL subtasks on the project's spine, workers execute them one by one, and each report flips a
// task to done — progress you can watch move, not one monolithic blob at the end.
// The parse contract is deterministic and bounded; an unusable plan falls back to one worker.
// Since task-pm-04 every per-task worker is BOUND by its task record's directives: the planner
// may attach skills/acceptanceCriteria/restrictions to a step, they land on the spine task, and
// workerPartPrompt renders them verbatim into that worker's prompt.
import { KNOWN_SKILLS } from "./ce-core.mjs";

export const PLAN_TASKS_INSTRUCTION = `

You are the PLANNER. Reply in exactly this form:
DECISIONS: <one or two lines of shared choices every step must respect — stack, style, names>
\`\`\`tasks
[{"title": "step one"}, {"title": "step two", "skills": ["node-esm"], "acceptanceCriteria": ["done means …"]}]
\`\`\`
Rules: 2 to 6 steps; each step is one concrete, completable task; titles under 80 characters; no nesting, no commentary inside the block. Optional per step: "skills" (only from: ${Object.keys(KNOWN_SKILLS).join(", ")}), "acceptanceCriteria" (1-3 short, checkable items), "restrictions" (an object, e.g. {"network": false}).`;

/** The shared context every per-task worker gets — without it each worker re-invents the stack
 *  (a real run produced React+Vite, "vanilla HTML", and Next.js for ONE dashboard).
 *  The optional `task` binding is the spine task record's directives: acceptance criteria render
 *  as the checklist the worker MUST satisfy, restrictions as binding rules, skills verbatim.
 *  Omitted/empty directives → byte-identical to the pre-directives prompt. */
export function workerPartPrompt({ objective, planOutput, part, index, total, task = null }) {
  const base = `${objective}

The plan and decisions (shared, binding on every worker):
${planOutput}

YOUR PART (task ${index}/${total}): ${part}
Complete ONLY your part, fully, and stay inside the shared decisions.`;
  const skills = Array.isArray(task?.skills) ? task.skills.filter((s) => typeof s === "string" && s) : [];
  const criteria = Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria.filter((c) => typeof c === "string" && c) : [];
  const restrictions = task?.restrictions && typeof task.restrictions === "object" && !Array.isArray(task.restrictions)
    ? Object.entries(task.restrictions) : [];
  if (!skills.length && !criteria.length && !restrictions.length) return base;
  const val = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
  return `${base}

TASK DIRECTIVES (binding on YOUR part — from the task record):${skills.length ? `
Skills this task requires: ${skills.join(", ")}` : ""}${criteria.length ? `

Acceptance criteria — your part is done only when EVERY item holds:
${criteria.map((c) => `- [ ] ${c}`).join("\n")}` : ""}${restrictions.length ? `

Restrictions — binding rules; never violate them:
${restrictions.map(([k, v]) => `- ${k}: ${val(v)}`).join("\n")}` : ""}`;
}

/** Sanitize the OPTIONAL directive fields of one planner-emitted step. Planner output is
 *  untrusted: anything out of shape is dropped (never throws), caps mirror tasks.mjs so the
 *  result always passes newTask. Titles-only steps keep working exactly as before. */
function directiveFields(raw = {}) {
  const d = {};
  const acceptanceCriteria = (Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria : [])
    .map((c) => String(c).trim()).filter((c) => c && c.length <= 500).slice(0, 20);
  if (acceptanceCriteria.length) d.acceptanceCriteria = acceptanceCriteria;
  const skills = [...new Set((Array.isArray(raw.skills) ? raw.skills : [])
    .map((s) => String(s).trim()).filter(Boolean))].slice(0, 12);
  if (skills.length) d.skills = skills;
  if (raw.restrictions && typeof raw.restrictions === "object" && !Array.isArray(raw.restrictions)) {
    const entries = Object.entries(raw.restrictions)
      .filter(([k, v]) => k && (v === null || ["string", "number", "boolean"].includes(typeof v)))
      .slice(0, 12);
    if (entries.length) d.restrictions = Object.fromEntries(entries);
  }
  return d;
}

/** Parse the planner's task block. Returns ≥2 steps ({ title, ...directives }), or [] (caller
 *  falls back to one worker). Directive fields are optional and sanitized; a titles-only block
 *  yields exactly the { title } shapes it always did. */
export function parsePlannedTasks(output = "", { max = 6 } = {}) {
  const text = String(output || "");
  const block = text.match(/```tasks\s*([\s\S]*?)```/);
  let steps = [];
  if (block) {
    try {
      const arr = JSON.parse(block[1]);
      if (Array.isArray(arr))
        steps = arr.map((x) => (typeof x === "string" ? { title: x }
          : x && typeof x === "object" ? { title: x.title, ...directiveFields(x) } : {})).filter((s) => s.title);
    } catch { /* fall through to the line fallback */ }
  }
  if (steps.length < 2) {
    const lines = [...text.matchAll(/^\s*(?:\d{1,2}[.)]|[-•*])\s+(.{4,80}?)\s*$/gm)].map((m) => ({ title: m[1] }));
    if (lines.length >= 2) steps = lines;
  }
  const seen = new Set();
  steps = steps
    .map((s) => ({ ...s, title: String(s.title).trim() }))
    .filter((s) => s.title.length >= 3 && s.title.length <= 80)
    .filter((s) => (seen.has(s.title) ? false : (seen.add(s.title), true)));
  return steps.length >= 2 ? steps.slice(0, max) : [];
}
