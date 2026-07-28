#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — vertical-slice demo (product architecture 2026-07-27).
// One objective per department → identify the agent → smallest execution graph → run on the
// user's configured (here: local, $0) models → results with model/provider/tokens/cost-source/
// artifacts → prove ZERO BrainOutput-funded inference. Pass --dry to skip real inference.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routeTask, makeCatalog, costReport, validateCompanyConfig } from "./ce-core.mjs";
import { executePlan } from "./adapters.mjs";
import { DEPARTMENT_TEMPLATES } from "./departments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfgArgI = process.argv.indexOf("--config");
const cfgPath = cfgArgI > 0 ? process.argv[cfgArgI + 1] : join(HERE, "demo", "company.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const DRY = process.argv.includes("--dry");

// Preflight: validate the whole company config before any routing/execution. Errors are fatal.
const pre = validateCompanyConfig(cfg);
for (const w of pre.warnings) console.log(`preflight warning: ${w}`);
if (!pre.ok) {
  for (const e of pre.errors) console.error(`preflight ERROR: ${e}`);
  console.error(`✗ company config invalid (${cfgPath}); fix the errors above and re-run.`);
  process.exit(2);
}
console.log(`preflight: company config OK (${pre.errors.length} errors, ${pre.warnings.length} warnings)`);

// Refreshable free-model catalog (health-checked). The free profile picks only from here.
const catalog = makeCatalog([
  { provider: "opencode-free", model: "(current free coding model)", available: true, health: "ok", funder: "free", codingCategory: "good", reasoningCategory: "medium", toolSupport: true, multilingual: true, contextSize: 128000, privacyNotice: "provider data-use applies" },
]);
const ctx = { agents: cfg.agents, assignments: cfg.modelAssignments, connections: cfg.modelConnections, catalog, departments: DEPARTMENT_TEMPLATES, policies: cfg.policies || {} };

async function scenario(title, objective, req, inputs, execOpts = {}) {
  const r = routeTask(req, ctx);
  console.log(`\n=== ${title} ===`);
  console.log(`objective: ${objective}`);
  if (!r.ok) { console.log(`  routing failed: ${r.reason}`); return { funded: 0 }; }
  console.log(`agent: ${r.agent} (dept ${r.department}) · graph: ${r.shape} · nodes: ${r.plan.map((n) => n.node + (n.model?.model ? `[${n.model.model}]` : n.tool ? `[tool:${n.tool}]` : n.gate ? "[approval]" : n.model?.needsConfiguration ? "[UNCONFIGURED]" : "")).join(" → ")}`);
  if (r.policies.length) console.log(`policies bound: ${r.policies.join(", ")} (criteria loaded into the reviewer's context)`);
  let results;
  try {
    results = await executePlan(r.plan, inputs, { dryRun: DRY, maxTokens: 300, boundPolicies: r.boundPolicies, task: req.task, ...execOpts });
  } catch (e) {
    console.log(`  ✗ model call failed: ${e.code || e.message} — connect a local/free/BYOK model (see samples/connections.*.json), or re-run with --dry to skip inference.`);
    return { funded: 0 };
  }
  const rep = costReport(results);
  for (const n of rep.nodes) {
    const res = results.find((x) => x.node === n.node);
    const gateStatus = res?.gate ? (res.humanRequired ? `HUMAN APPROVAL required (${res.reason})` : `auto-cleared by reviewer (no human needed)`) : null;
    const src = n.model ? `${n.provider}/${n.model} · cost-source=${n.costSource} · tokens=${n.tokens}` : res?.needsConfiguration ? `UNCONFIGURED → offer [${res.options.join("/")}] (never paid)` : gateStatus || `deterministic tool · tokens=0`;
    console.log(`  • ${n.node}: ${src}`);
    if (res?.review) console.log(`      ↳ reviewer verdict: ${res.review.pass && !res.review.flags.length ? "PASS" : "FLAGGED"}${res.review.flags.length ? " · flags: " + res.review.flags.join("; ") : ""}`);
    else if (res?.deterministic && res.output) console.log(`      ↳ tool result: ${JSON.stringify(res.output)}`);
    else if (res?.output) console.log(`      ↳ ${String(res.output).replace(/\s+/g, " ").slice(0, 160)}`);
    if (res?.brief) console.log(`      ↳ human brief: decision="${res.brief.decision}" · escalatedBecause=${res.brief.escalatedBecause}`);
  }
  console.log(`  cost sources: ${JSON.stringify(rep.byCostSource)} · every model free / local / your own`);
  return { funded: rep.brainoutputFundedTokens };
}

const runs = [];
runs.push(await scenario(
  "A · Technical (premium planner + free/local coding worker)",
  "Add a function `slugify(title)` and a matching unit test.",
  { department: "technical", role: "architect", task: { complexity: "high", decompose: true, parallelWorkers: 1, workerSlot: "coding-free" } },
  { planner: { prompt: "In 3 short bullet steps, plan implementing a slugify(title) function and one unit test. Steps only." },
    worker:  { prompt: "Write a tiny JS `slugify(title)` (lowercase, spaces→dashes, strip non-alphanumerics) and one assert-based test. Code only." } }));

runs.push(await scenario(
  "B · Customer service (routine multilingual worker)",
  "Reply to: '¿Cómo restablezco mi contraseña?'",
  { department: "customer-service", role: "support", task: { complexity: "low" } },
  { worker: { prompt: "A customer wrote in Spanish: '¿Cómo restablezco mi contraseña?'. Reply helpfully in Spanish, 2 sentences." } }));

// Finance: vision extraction is UNCONFIGURED (→ offer options, never paid); reconciliation is a
// deterministic tool (no model); any payment requires human approval.
runs.push(await scenario(
  "C-extract · Finance (vision slot unconfigured → no paid fallback)",
  "Extract line items from an invoice image.",
  { department: "finance", role: "controller", task: { complexity: "low", workerSlot: "vision" } }, {}));
runs.push(await scenario(
  "C-reconcile+pay · Finance (deterministic reconcile + mandatory human approval)",
  "Reconcile the ledger to the bank statement, then pay the balance.",
  { department: "finance", role: "controller", task: { tool: "reconcile", mutatesRealWorld: true, requiresHumanApproval: true } },
  { tool: { ledger: [{ amount: 100 }, { amount: 50 }], statement: [{ amount: 150 }] } }));

// Marketing: publish product copy. The legal-copy-review policy binds (dept=marketing / tag=publish-copy),
// so its criteria load into the reviewer node. The AGENT reviewer validates; the human gate is
// CONDITIONAL — a clean review auto-clears (human stays out); a flagged review escalates WITH a brief.
// Two runs with injected verdicts show both paths deterministically (no live model needed).
runs.push(await scenario(
  "D1 · Marketing (copy review — reviewer PASSES → human auto-cleared out)",
  "Publish the /runtime/ page copy: 'Open source. Run it free, host it, or have us build on it.'",
  { department: "marketing", role: "copywriter", task: { summary: "publish /runtime/ hero copy", tags: ["publish-copy"], workerSlot: "multilingual" } },
  { worker: { prompt: "Write a 1-line honest hero for an open-source AI-company runtime." } },
  { reviewVerdict: { pass: true, flags: [], notes: "claims verifiable; no signed wording touched", recommendation: "safe to approve" } }));

runs.push(await scenario(
  "D2 · Marketing (copy review — reviewer FLAGS → escalates to human with a brief)",
  "Publish copy claiming 'the #1 open-source AI company, MIT-licensed'.",
  { department: "marketing", role: "copywriter", task: { summary: "publish superlative marketing claim", tags: ["publish-copy"], workerSlot: "multilingual" } },
  { worker: { prompt: "Write marketing copy." } },
  { reviewVerdict: { pass: false, flags: ["'#1' is an unverifiable superlative", "license is Apache-2.0, not MIT — 'MIT-licensed' is false"], notes: "two claims fail policy", recommendation: "hold for human decision" } }));

const totalFunded = runs.reduce((s, r) => s + (r.funded || 0), 0);
console.log(`\n================ SUMMARY ================`);
console.log(`Every scenario ran on your own free / local models.`);
console.log(totalFunded === 0 ? "✓ Every scenario ran entirely on your free / local / own models." : "✗ UNEXPECTED PAID TOKENS — see above");
process.exit(totalFunded === 0 ? 0 : 1);
