#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — technical execution slice (2026-07-27).
// Routes a technical objective to the configured agent, invokes the PLANNER only when planning is
// needed (planner → compact PLAN.md → worker), and executes the implementation through REAL
// OpenCode on the profile's WORKER model. No the control plane agents. Zero BrainOutput-funded inference.
//   node bo-ce-tech.mjs --config <company.json> --objective "..." [--complex]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routeTask, makeCatalog } from "./ce-core.mjs";
import { chatCompletion } from "./adapters.mjs";
import { runOpenCode } from "./opencode-adapter.mjs";
import { DEPARTMENT_TEMPLATES } from "./departments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const A = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const cfg = JSON.parse(readFileSync(A("--config", join(HERE, "demo", "company.json")), "utf8"));
const objective = A("--objective", "Add a `slugify(title)` function in slugify.js and a matching assert-based test in slugify.test.js.");
const complex = process.argv.includes("--complex");
const ctx = { agents: cfg.agents, assignments: cfg.modelAssignments, connections: cfg.modelConnections, catalog: makeCatalog([]), departments: DEPARTMENT_TEMPLATES };

const r = routeTask({ department: "technical", role: "architect", task: { complexity: complex ? "high" : "low", decompose: complex, workerSlot: "coding-free", plannerSlot: "reasoning-premium" } }, ctx);
if (!r.ok) { console.error("routing failed:", r.reason); process.exit(1); }
const worker = r.plan.find((n) => n.node.startsWith("worker"));
const planner = r.plan.find((n) => n.node === "planner");
if (worker.model?.needsConfiguration) { console.error(`worker slot unconfigured → offer ${worker.model.options.join("/")}; no paid fallback`); process.exit(2); }

const ws = join(HERE, "generated", `ws-${cfg.company?.name?.replace(/\W+/g, "-") || "co"}`);
mkdirSync(ws, { recursive: true });

console.log(`objective: ${objective}`);
console.log(`agent: ${r.agent} · graph: ${r.shape} · worker model: ${worker.model.provider}/${worker.model.model} (cost: ${worker.model.costSource})`);

let plan = "";
if (planner && !planner.model?.needsConfiguration) {
  console.log(`\n[planner ${planner.model.provider}/${planner.model.model}] producing compact PLAN.md …`);
  try {
    const pr = await chatCompletion({ endpoint: planner.model.connection.endpoint, model: planner.model.model, prompt: `Produce a compact 3-step PLAN (bullet points only, no code) to: ${objective}`, maxTokens: 220 });
    plan = pr.content; writeFileSync(join(ws, "PLAN.md"), `# PLAN\n${plan}\n`);
    console.log(plan.replace(/\s+/g, " ").slice(0, 240));
  } catch (e) { console.log(`  planner unavailable (${e.message}); proceeding worker-only`); }
} else {
  console.log(`\n(clear bounded task → planner skipped; invoking worker only)`);
}

const prompt = `${plan ? "Follow PLAN.md in this directory. " : ""}${objective} Use the write tool to create the file(s) with RELATIVE paths in the current working directory (do not use absolute paths). Keep it minimal. When the file(s) exist, stop.`;
console.log(`\n[worker · REAL OpenCode ${worker.model.provider}/${worker.model.model}] executing …`);
const res = await runOpenCode({ connection: worker.model.connection, prompt, workspace: ws, effort: worker.model.connection.effort, timeoutMs: Number(A("--timeout-ms", "240000")), approvedRoots: [join(HERE, "generated")] });

console.log(`\n================ RESULT ================`);
console.log(`exit: ${res.exitCode} · providers actually used: [${res.providersUsed.join(", ") || "none"}] · paid-credential used: ${res.founderCredentialUsed ? "YES ✗" : "NO ✓"}`);
console.log(`model: ${res.provider}/${res.model} · cost source: ${res.costSource} · tokens(out): ${res.tokens}`);
console.log(`changed files: ${res.changedFiles.length ? res.changedFiles.join(", ") : "(none — model may need a stronger local/BYOK model)"}`);
for (const f of res.changedFiles.slice(0, 3)) { try { console.log(`  ── ${f} ──\n${readFileSync(join(ws, f), "utf8").split("\n").slice(0, 12).map((l) => "  " + l).join("\n")}`); } catch {} }
console.log(`\nlog tail:\n${res.log.split("\n").slice(-6).map((l) => "  " + l).join("\n")}`);
const zero = !res.founderCredentialUsed && ["local", "free", "user"].includes(res.funder);
console.log(`\nModel ownership: ${zero ? "✓ free / local / your own" : "✗ VIOLATION"}`);
process.exit(zero ? 0 : 1);
