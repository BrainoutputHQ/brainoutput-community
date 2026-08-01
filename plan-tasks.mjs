// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — plan → spine tasks (2026-08-01, focus (1)).
// A planner's job must LAND: the planner stage is asked for a fenced task block, its steps become
// REAL subtasks on the project's spine, workers execute them one by one, and each report flips a
// task to done — progress you can watch move, not one monolithic blob at the end.
// The parse contract is deterministic and bounded; an unusable plan falls back to one worker.
export const PLAN_TASKS_INSTRUCTION = `

You are the PLANNER. Reply in exactly this form:
DECISIONS: <one or two lines of shared choices every step must respect — stack, style, names>
\`\`\`tasks
[{"title": "step one"}, {"title": "step two"}]
\`\`\`
Rules: 2 to 6 steps; each step is one concrete, completable task; titles under 80 characters; no nesting, no commentary inside the block.`;

/** The shared context every per-task worker gets — without it each worker re-invents the stack
 *  (a real run produced React+Vite, "vanilla HTML", and Next.js for ONE dashboard). */
export function workerPartPrompt({ objective, planOutput, part, index, total }) {
  return `${objective}

The plan and decisions (shared, binding on every worker):
${planOutput}

YOUR PART (task ${index}/${total}): ${part}
Complete ONLY your part, fully, and stay inside the shared decisions.`;
}

/** Parse the planner's task block. Returns ≥2 titles, or [] (caller falls back to one worker). */
export function parsePlannedTasks(output = "", { max = 6 } = {}) {
  const text = String(output || "");
  const block = text.match(/```tasks\s*([\s\S]*?)```/);
  let titles = [];
  if (block) {
    try {
      const arr = JSON.parse(block[1]);
      if (Array.isArray(arr)) titles = arr.map((x) => (typeof x === "string" ? x : x?.title)).filter(Boolean);
    } catch { /* fall through to the line fallback */ }
  }
  if (titles.length < 2) {
    const lines = [...text.matchAll(/^\s*(?:\d{1,2}[.)]|[-•*])\s+(.{4,80}?)\s*$/gm)].map((m) => m[1]);
    if (lines.length >= 2) titles = lines;
  }
  titles = [...new Set(titles.map((t) => String(t).trim()).filter((t) => t.length >= 3 && t.length <= 80))];
  return titles.length >= 2 ? titles.slice(0, max).map((title) => ({ title })) : [];
}
