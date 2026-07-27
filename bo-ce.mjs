#!/usr/bin/env node
// BrainOutput Community Edition — vertical-slice demo (product architecture 2026-07-27).
// One objective per department → identify the agent → smallest execution graph → run on the
// user's configured (here: local, $0) models → results with model/provider/tokens/cost-source/
// artifacts → prove ZERO BrainOutput-funded inference. Pass --dry to skip real inference.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routeTask, makeCatalog, costReport } from "./ce-core.mjs";
import { executePlan } from "./adapters.mjs";
import { DEPARTMENT_TEMPLATES } from "./departments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfgArgI = process.argv.indexOf("--config");
const cfgPath = cfgArgI > 0 ? process.argv[cfgArgI + 1] : join(HERE, "demo", "company.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const DRY = process.argv.includes("--dry");

// Refreshable free-model catalog (health-checked). The free profile picks only from here.
const catalog = makeCatalog([
  { provider: "opencode-free", model: "(current free coding model)", available: true, health: "ok", funder: "free", codingCategory: "good", reasoningCategory: "medium", toolSupport: true, multilingual: true, contextSize: 128000, privacyNotice: "provider data-use applies" },
]);
const ctx = { agents: cfg.agents, assignments: cfg.modelAssignments, connections: cfg.modelConnections, catalog, departments: DEPARTMENT_TEMPLATES };

async function scenario(title, objective, req, inputs) {
  const r = routeTask(req, ctx);
  console.log(`\n=== ${title} ===`);
  console.log(`objective: ${objective}`);
  if (!r.ok) { console.log(`  routing failed: ${r.reason}`); return { funded: 0 }; }
  console.log(`agent: ${r.agent} (dept ${r.department}) · graph: ${r.shape} · nodes: ${r.plan.map((n) => n.node + (n.model?.model ? `[${n.model.model}]` : n.tool ? `[tool:${n.tool}]` : n.gate ? "[approval]" : n.model?.needsConfiguration ? "[UNCONFIGURED]" : "")).join(" → ")}`);
  const results = await executePlan(r.plan, inputs, { dryRun: DRY, maxTokens: 300 });
  const rep = costReport(results);
  for (const n of rep.nodes) {
    const res = results.find((x) => x.node === n.node);
    const src = n.model ? `${n.provider}/${n.model} · cost-source=${n.costSource} · tokens=${n.tokens}` : res?.needsConfiguration ? `UNCONFIGURED → offer [${res.options.join("/")}] (never paid)` : res?.gate ? "HUMAN APPROVAL required (no model)" : `deterministic tool · tokens=0`;
    console.log(`  • ${n.node}: ${src}`);
    if (res?.deterministic && res.output) console.log(`      ↳ tool result: ${JSON.stringify(res.output)}`);
    else if (res?.output) console.log(`      ↳ ${String(res.output).replace(/\s+/g, " ").slice(0, 160)}`);
  }
  console.log(`  cost sources: ${JSON.stringify(rep.byCostSource)} · BrainOutput-funded tokens: ${rep.brainoutputFundedTokens}`);
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

const totalFunded = runs.reduce((s, r) => s + (r.funded || 0), 0);
console.log(`\n================ SUMMARY ================`);
console.log(`BrainOutput-funded inference tokens across ALL scenarios: ${totalFunded}`);
console.log(totalFunded === 0 ? "✓ Community invariant HELD: $0 BrainOutput-funded inference." : "✗ INVARIANT VIOLATED");
process.exit(totalFunded === 0 ? 0 : 1);
