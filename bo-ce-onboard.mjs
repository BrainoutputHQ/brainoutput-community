#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — first-run onboarding driver (product architecture 2026-07-27).
// Runs the 10-step flow. Detects the user's LOCAL (ollama) and BYOK models — never BrainOutput's
// account. Interactive when attached to a TTY; otherwise reads answers from --answers <file> or
// falls back to a built-in sample. Writes a deployable, DORMANT company config and renders the UI.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";
import { request } from "node:http";
import { workTwinOnboarding, detectConnections, generateOrg, recommendAssignments, applyOverrides, confirmZeroFunded, buildCompanyConfig, renderAgentView, ROLE_TEMPLATES, onboardingModelPaths, payerLabel, regularOnboardingSteps, advancedOnboardingFields, onboardingExample } from "./onboarding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

// Step 1 probe: user's local models (ollama) + user-namespaced BYOK keys. NOT BrainOutput's keys.
function probeOllama() {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: 11434, path: "/api/tags", timeout: 3000 }, (res) => {
      res.setEncoding("utf8"); let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const models = (JSON.parse(d).models || []).map((m) => ({
            name: m.name, provider: "ollama",
            contextSize: /32k|32000/.test(m.name) ? 32000 : 8192,
            coding: true, multilingual: true, vision: /vl|vision|llava/i.test(m.name),
          }));
          resolve(models);
        } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([])); req.on("timeout", () => { req.destroy(); resolve([]); });
    req.end();
  });
}
const BYOK_ENV = { "user-anthropic": "USER_OWN_ANTHROPIC_KEY", "user-openai": "USER_OWN_OPENAI_KEY", "user-openrouter": "USER_OWN_OPENROUTER_KEY" };
function detectByok() {
  const out = {};
  for (const [prov, envName] of Object.entries(BYOK_ENV)) out[prov] = { present: !!process.env[envName], envName, subscription: prov === "user-anthropic" };
  return out;
}

async function getAnswers() {
  const f = arg("--answers");
  if (f) return JSON.parse(readFileSync(f, "utf8"));
  if (!process.stdin.isTTY) // non-interactive default: BrainOutput's three-department slice
    return { companyDoes: "a small software product studio", departments: ["technical", "customer-service", "finance"], overrides: {} };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const companyDoes = await rl.question("2) What does your company do? ");
  const all = Object.keys(ROLE_TEMPLATES);
  const pick = await rl.question(`3) Which departments? (comma-separated from: ${all.join(", ")})\n   > `);
  await rl.question("4) Which systems/knowledge sources are available? (noted; press enter) ");
  rl.close();
  return { companyDoes, departments: pick.split(",").map((s) => s.trim()).filter((s) => all.includes(s)), overrides: {} };
}

const line = (s = "") => console.log(s);
const money = { free: "FREE", "local-compute": "your local compute", "user-subscription": "your subscription", "user-api-account": "your API account" };

const ADVANCED = process.argv.includes("--advanced");
const SHOW_EXAMPLE = process.argv.includes("--example");

function printExample() {
  const ex = onboardingExample();
  line("BrainOutput Community Edition — onboarding EXAMPLE\n" + "=".repeat(52));
  line(ex.note + "\n");
  for (const a of ex.agents) {
    line(`▸ ${a.role} (${a.department}) — ${a.runtime.runtime}`);
    line(`    ${a.note}`);
    line(`    runs: ${ex.where.find((w) => w.id === a.id).runs}`);
    line(`    tools: ${a.tools.join(", ")} · permissions: ${a.permissions.join(", ")}` + (Object.keys(a.approvalThresholds).length ? ` · approval: ${Object.keys(a.approvalThresholds).join(", ")}` : ""));
  }
  line("\nEvery agent on a DIFFERENT runtime; every one user/free/local; all dormant until work exists.");
}

(async () => {
  if (SHOW_EXAMPLE) { printExample(); return; }
  const MODE = ADVANCED ? "ADVANCED MODE" : "REGULAR MODE";
  line(`BrainOutput Community Edition — first-run onboarding · ${MODE}\n` + "=".repeat(60));
  line("Runs on your own models — you always choose who pays for each model.\n");
  line("Steps:");
  for (const s of regularOnboardingSteps()) line(`   ${s}`);
  if (ADVANCED) line(`\nAdvanced knobs per agent: ${advancedOnboardingFields().join(" · ")}`);
  line("");
  // Step 1 — choose how to run your models (5 runtimes; a local CLI is NOT a local model).
  line("1) How would you like to run your models?");
  for (const p of onboardingModelPaths())
    line(`   ${p.default ? "▸" : " "} ${p.label}${p.default ? "  (recommended)" : ""} — ${p.payer} · ${p.where}`);
  line("");
  // Step 1 — detect/connect
  const localModels = await probeOllama();
  const { connections } = detectConnections({ localModels, byokKeys: detectByok(), freeAvailable: true });
  line(`1) Model sources detected:`);
  if (!connections.length) line("   (none — connect a local model, add a BYOK key, or pick a free model)");
  for (const c of connections) line(`   • ${c.id} — ${c.provider}/${c.model} · pays: ${money[c.costSource]}`);

  // Steps 2-4 — company + departments + knowledge
  const answers = await getAnswers();
  line(`\n2) Company: ${answers.companyDoes}`);
  line(`3) Departments: ${answers.departments.join(", ")}`);
  line(`4) Knowledge sources: ${(answers.knowledge || ["(none specified)"]).join(", ")}`);

  // Step 5 — generate the minimum useful org
  const agents = generateOrg(answers);
  line(`\n5) Generated the minimum useful org — ${agents.length} agent(s), all DORMANT:`);
  for (const a of agents) line(`   • ${a.id} (${a.role})`);

  // Steps 6-7 — recommend a model per slot + show who pays
  const rec = recommendAssignments(agents, connections);
  line(`\n6/7) Recommended model per capability slot (and who pays):`);
  for (const slot of rec.slotsUsed) {
    const v = rec.view[slot];
    line(v.needsConfiguration
      ? `   • ${slot}: UNCONFIGURED → offer [${v.options.join("/")}] (never a paid fallback)`
      : `   • ${slot}: ${v.provider}/${v.model} · pays: ${money[v.costSource]}`);
  }

  // Step 8 — user overrides (from answers.overrides in non-interactive mode)
  const assignments = applyOverrides(rec.assignments, answers.overrides || {}, connections);
  if (Object.keys(answers.overrides || {}).length) line(`\n8) Applied ${Object.keys(answers.overrides).length} override(s).`);
  else line(`\n8) No overrides (every assignment is user-overridable).`);

  // Step 9 — confirm every model is your own
  const z = confirmZeroFunded(assignments, connections);
  line(`\n9) Model ownership check: ${z.ok ? "✓ every model is free / your subscription / your account / local" : "✗ " + z.offenders.join(", ")}`);
  if (!z.ok) process.exit(1);

  // Step 10 — deploy dormant + write config
  const cfg = buildCompanyConfig(answers, connections, agents, assignments);
  const outDir = join(HERE, "generated"); mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "company.generated.json");
  writeFileSync(outFile, JSON.stringify(cfg, null, 2) + "\n");
  line(`\n10) Deployed ${cfg.agents.length} agent(s) DORMANT → ${outFile}`);

  // UI view
  line(`\n${"=".repeat(52)}\nAgent view:`);
  for (const a of agents) {
    const v = renderAgentView(a, assignments, connections);
    line(`\n▸ ${v.id} — ${v.department}/${v.role} [${v.activation}]`);
    for (const [k, m] of Object.entries(v.models)) line(`    ${k}: ${m}`);
    line(`    tools: ${v.tools.join(", ") || "-"} · permissions: ${v.permissions.join(", ") || "-"}`);
    if (Object.keys(v.approvals).length) line(`    human approval required for: ${Object.keys(v.approvals).join(", ")}`);
  }
  // Step 11 — the Work Twin (optional, read-only by default)
  const wt = workTwinOnboarding();
  line(`\n${"=".repeat(52)}\n${wt.title}`);
  line(wt.explain);
  for (const o of wt.options) line(`   • ${o.label}${o.needs ? ` — needs ${o.needs}` : ""}`);
  line(`\n   Permissions (default mode: ${wt.defaultMode})`);
  for (const p of wt.permissionScreen) line(`     - ${p}`);
  line(`   Create it in the dashboard: bo-community serve → Work Twin tab.`);

  line(`\n✓ Onboarding complete. Agents are dormant; execution context is created only when work exists.`);
})();
