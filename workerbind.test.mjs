// SPDX-License-Identifier: Apache-2.0
// Worker binding (task-pm-04): every per-task worker is BOUND by its task record's directives
// (acceptance criteria as a checklist, restrictions as rules, skills verbatim), and routing is
// FAIL-CLOSED on skills — an unknown skill blocks the task by name, a known skill imposes its
// slot/review effect, an agentSlot pins the worker stage or blocks loudly. No directives at all
// → byte-identical prompts and routes to before (migration-safe). Pure logic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_SKILLS, CAPABILITY_SLOTS, checkTaskDirectives, routeTask, makeCatalog } from "./ce-core.mjs";
import { workerPartPrompt, parsePlannedTasks } from "./plan-tasks.mjs";

const LOCAL = { id: "local-a", kind: "local", provider: "ollama", model: "qwen2.5:7b", costSource: "local-compute", funder: "local" };
const FREE = { id: "free-a", kind: "opencode-free", provider: "opencode-free", model: "some-free", costSource: "free", funder: "free" };
const ctx = (assignments, connections = [LOCAL, FREE]) => ({
  agents: [{ id: "eng", department: "technical", role: "engineer", capabilities: {} }],
  assignments, connections, catalog: makeCatalog([]),
});
const workerOf = (r) => r.plan.find((n) => String(n.node).replace(/\d+$/, "") === "worker");

// ── 1. PROMPT BINDING ──────────────────────────────────────────────────────────────────────────

const BASE_PROMPT = `OBJ

The plan and decisions (shared, binding on every worker):
PLAN

YOUR PART (task 1/2): STEP
Complete ONLY your part, fully, and stay inside the shared decisions.`;

test("workerPartPrompt without a binding is BYTE-IDENTICAL to the pre-directives prompt", () => {
  const args = { objective: "OBJ", planOutput: "PLAN", part: "STEP", index: 1, total: 2 };
  assert.equal(workerPartPrompt(args), BASE_PROMPT);
  assert.equal(workerPartPrompt({ ...args, task: null }), BASE_PROMPT);
  assert.equal(workerPartPrompt({ ...args, task: {} }), BASE_PROMPT);
  assert.equal(workerPartPrompt({ ...args, task: { acceptanceCriteria: [], skills: [], restrictions: {} } }), BASE_PROMPT);
});

test("workerPartPrompt renders the task's AC (checklist), restrictions (rules), skills — VERBATIM", () => {
  const p = workerPartPrompt({ objective: "OBJ", planOutput: "PLAN", part: "STEP", index: 2, total: 3,
    task: { acceptanceCriteria: ["schema reviewed", "`exports work` — verbatim, unchanged"],
      restrictions: { network: false, maxFiles: 3 }, skills: ["node-esm", "review"] } });
  assert.ok(p.startsWith(`OBJ\n\nThe plan and decisions (shared, binding on every worker):\nPLAN\n\nYOUR PART (task 2/3): STEP\nComplete ONLY your part, fully, and stay inside the shared decisions.`));
  assert.ok(p.includes("Skills this task requires: node-esm, review"));
  assert.ok(p.includes("- [ ] schema reviewed\n- [ ] `exports work` — verbatim, unchanged"));
  assert.ok(p.includes("- network: false\n- maxFiles: 3"));
});

test("workerPartPrompt: each directive section renders only when non-empty", () => {
  const acOnly = workerPartPrompt({ objective: "O", planOutput: "P", part: "S", index: 1, total: 1,
    task: { acceptanceCriteria: ["it compiles"] } });
  assert.ok(acOnly.includes("- [ ] it compiles"));
  assert.ok(!acOnly.includes("Skills this task requires") && !acOnly.includes("Restrictions —"));
  const skillsOnly = workerPartPrompt({ objective: "O", planOutput: "P", part: "S", index: 1, total: 1,
    task: { skills: ["docs"] } });
  assert.ok(skillsOnly.includes("Skills this task requires: docs"));
  assert.ok(!skillsOnly.includes("- [ ]"));
});

// ── parsePlannedTasks: directives carried, sanitized, never thrown ─────────────────────────────

test("parsePlannedTasks: titles-only blocks behave exactly as before", () => {
  const steps = parsePlannedTasks('```tasks\n[{"title": "step one"}, {"title": "step two"}]\n```');
  assert.deepEqual(steps, [{ title: "step one" }, { title: "step two" }]);
  assert.deepEqual(parsePlannedTasks("no block at all"), []);
  assert.deepEqual(parsePlannedTasks('```tasks\n[{"title": "only one"}]\n```'), []);
});

test("parsePlannedTasks: planner-emitted directives are carried (sanitized) onto the step", () => {
  const steps = parsePlannedTasks("```tasks\n" + JSON.stringify([
    { title: "design the schema", skills: ["research", 42, "research"], acceptanceCriteria: ["schema reviewed", 7, ""], restrictions: { network: false, bad: { nested: 1 } } },
    { title: "build the exporter", acceptanceCriteria: "not-an-array", skills: "nope" },
  ]) + "\n```");
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { title: "design the schema", skills: ["research", "42"],
    acceptanceCriteria: ["schema reviewed", "7"], restrictions: { network: false } });
  assert.deepEqual(steps[1], { title: "build the exporter" });   // malformed directives dropped
});

// ── 2. KNOWN_SKILLS: small, honest, every effect lands in the REAL slot system ─────────────────

test("KNOWN_SKILLS: every skill has a real routing effect on existing slots", () => {
  const keys = Object.keys(KNOWN_SKILLS);
  for (const k of ["node-esm", "browser-js", "review", "docs", "research", "connectors", "i18n", "ops"])
    assert.ok(keys.includes(k), `vocabulary covers ${k}`);
  for (const [skill, effect] of Object.entries(KNOWN_SKILLS)) {
    const slots = Object.keys(effect);
    assert.ok(slots.length >= 1, `${skill} has an effect`);
    if (effect.workerSlot) assert.ok(CAPABILITY_SLOTS.includes(effect.workerSlot), `${skill} → existing slot`);
    if ("requireReview" in effect) assert.equal(typeof effect.requireReview, "boolean");
  }
});

// ── 3. SKILLS ROUTING is fail-closed ───────────────────────────────────────────────────────────

test("routeTask BLOCKS on an unknown skill — returned, named, never thrown, never dropped", () => {
  const r = routeTask({ department: "technical", task: { skills: ["node-esm", "telekinesis", "mind-reading"] } }, ctx({ "fast-cheap": "local-a" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /'telekinesis'/);
  assert.match(r.reason, /'mind-reading'/);
  assert.ok(!r.reason.includes("'node-esm'"), "the known skill is not blamed");
  assert.match(r.reason, /node-esm/, "the reason names the vocabulary the router DOES know");
});

test("routeTask: known skills route with their effect on the worker stage", () => {
  const research = routeTask({ department: "technical", task: { skills: ["research"] } }, ctx({ "long-context": "local-a" }));
  assert.equal(research.ok, true);
  assert.equal(workerOf(research).slot, "long-context");
  assert.equal(workerOf(research).model.model, "qwen2.5:7b");
  const docs = routeTask({ department: "technical", task: { skills: ["docs"] } }, ctx({ "fast-cheap": "local-a" }));
  assert.equal(workerOf(docs).slot, "fast-cheap");
  const i18n = routeTask({ department: "technical", task: { skills: ["i18n"] } }, ctx({ multilingual: "local-a" }));
  assert.equal(workerOf(i18n).slot, "multilingual");
  const review = routeTask({ department: "technical", task: { skills: ["review"] } }, ctx({ "fast-cheap": "local-a", "high-trust-review": "local-a" }));
  assert.equal(review.shape, "worker-reviewer", "the review skill forces an independent reviewer");
  assert.ok(review.plan.some((n) => n.node === "reviewer" && n.slot === "high-trust-review"));
});

test("precedence: agentSlot > explicit workerSlot > skill preference > agent default", () => {
  const skillOnly = routeTask({ department: "technical", task: { skills: ["research"] } },
    { ...ctx({ "long-context": "local-a" }), agents: [{ id: "e", department: "technical", role: "r", capabilities: { worker: "fast-cheap" } }] });
  assert.equal(workerOf(skillOnly).slot, "long-context", "skill preference beats the agent default");
  const explicit = routeTask({ department: "technical", task: { skills: ["research"], workerSlot: "fast-cheap" } }, ctx({ "fast-cheap": "local-a" }));
  assert.equal(workerOf(explicit).slot, "fast-cheap", "an explicit task slot beats the skill preference");
  assert.equal(workerOf(explicit).model.directiveBlocked, undefined, "no directive block when the skill preference was overridden");
  const pinned = routeTask({ department: "technical", task: { skills: ["research"], workerSlot: "fast-cheap", agentSlot: "private-local" } }, ctx({ "private-local": "local-a" }));
  assert.equal(workerOf(pinned).slot, "private-local", "agentSlot pins the worker stage absolutely");
});

// ── 4. agentSlot: honored or blocked loudly — never a silent substitution ──────────────────────

test("agentSlot honored: the worker stage uses exactly that slot", () => {
  const r = routeTask({ department: "technical", task: { agentSlot: "private-local" } }, ctx({ "private-local": "local-a" }));
  assert.equal(r.ok, true);
  assert.equal(workerOf(r).slot, "private-local");
  assert.equal(workerOf(r).model.model, "qwen2.5:7b");
});

test("agentSlot naming a non-slot is BLOCKED with the value named", () => {
  const r = routeTask({ department: "technical", task: { agentSlot: "dev-1" } }, ctx({}));
  assert.equal(r.ok, false);
  assert.match(r.reason, /agentSlot 'dev-1'/);
  assert.match(r.reason, /capability slot/);
});

test("agentSlot unconfigured → the worker stage is BLOCKED LOUDLY, never silently substituted", () => {
  const r = routeTask({ department: "technical", task: { agentSlot: "private-local" } }, ctx({ "fast-cheap": "local-a" }));
  assert.equal(r.ok, true, "the route exists; the stage is what blocks");
  const w = workerOf(r);
  assert.equal(w.slot, "private-local", "no silent substitution to another slot");
  assert.equal(w.model.needsConfiguration, true);
  assert.equal(w.model.directiveBlocked, true);
  assert.match(w.model.reason, /agentSlot directive/);
  assert.match(w.model.reason, /'private-local'/);
  assert.equal(w.model.connection, undefined, "no model was silently swapped in");
  assert.deepEqual(r.needsConfiguration, ["private-local"]);
});

test("a known skill whose slot is unconfigured → BLOCKED with reason, no silent downgrade", () => {
  const r = routeTask({ department: "technical", task: { skills: ["research"] } }, ctx({ "fast-cheap": "local-a" }));
  const w = workerOf(r);
  assert.equal(w.slot, "long-context", "the required slot is kept — never downgraded to a configured one");
  assert.equal(w.model.needsConfiguration, true);
  assert.equal(w.model.directiveBlocked, true);
  assert.match(w.model.reason, /skill\(s\) research/);
  assert.match(w.model.reason, /'long-context'/);
  assert.equal(w.model.connection, undefined);
});

// ── 5. No directives → byte-identical routing (migration-safe) ─────────────────────────────────

test("empty/absent skills + no agentSlot → routing byte-identical to a directive-less task", () => {
  const c = ctx({ "fast-cheap": "local-a", "coding-free": "local-a" });
  const plain = routeTask({ department: "technical", task: { summary: "x", complexity: "high", decompose: true } }, c);
  const empty = routeTask({ department: "technical", task: { summary: "x", complexity: "high", decompose: true, skills: [], agentSlot: null } }, c);
  assert.deepEqual(empty, plain);
});

// ── 6. The privacy fail-closed invariant composes with directives (and still wins) ─────────────

test("privacy: full-private posture still floors a directive-bound slot — its reason is kept", () => {
  const base = { ...ctx({ "long-context": "free-a" }), settings: { privacy: "private" } };
  const r = routeTask({ department: "technical", task: { skills: ["research"] } }, base);
  const w = workerOf(r);
  assert.equal(w.model.needsConfiguration, true, "confidential work never routes to cloud/free");
  assert.equal(w.model.privacyBlocked, "private");
  assert.match(w.model.reason, /full-private/, "the privacy reason is not overwritten by the directive reason");
  assert.equal(w.model.directiveBlocked, undefined);
});

test("checkTaskDirectives: malformed directive shapes are loud, empty ones pass", () => {
  assert.equal(checkTaskDirectives({}).ok, true);
  assert.equal(checkTaskDirectives({ skills: [], agentSlot: null }).ok, true);
  assert.equal(checkTaskDirectives({ skills: "node-esm" }).ok, false);
  assert.equal(checkTaskDirectives({ agentSlot: 42 }).ok, false);
  assert.equal(checkTaskDirectives({ skills: ["research"], agentSlot: "vision" }).ok, true);
});
