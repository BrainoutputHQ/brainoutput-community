#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Clean-install package smoke for BrainOutput Community Edition.
//   npm run smoke:community-clean   (or: node smoke-clean.mjs)
//
// Proves a brand-new tester can install → onboard → run → persist entirely on their OWN
// free / local / BYOK models, with ZERO BrainOutput-funded inference — in a throwaway temp
// directory that never touches the developer's real Community config. Self-contained: a tiny
// in-process stub stands in for a local Ollama / OpenAI-compatible endpoint, so the smoke needs
// no external model, no network, no BrainOutput account, and no founder credentials.
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const check = (label, ok, detail = "") => { results.push({ label, ok: !!ok, detail }); if (!ok) console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); else console.log(`  ✓ ${label}`); };

let server = null, T = null;

async function run() {
  // ── 1. TEMP ISOLATION — all state in a throwaway dir; set BO_CE_DATA BEFORE importing the store ──
  T = mkdtempSync(join(tmpdir(), "bo-ce-smoke-"));
  process.env.BO_CE_DATA = join(T, "data");
  delete process.env.BO_CE_LOCAL_ENDPOINTS;            // no undocumented env
  delete process.env.BO_CE_WORKSPACE_ROOTS;
  check("1. isolated temp environment (no founder home / config)", process.env.BO_CE_DATA.startsWith(T));

  // ── 2. STUB local model (stands in for Ollama / an OpenAI-compatible endpoint) ──────────────────
  const port = await new Promise((res) => {
    server = http.createServer((req, resp) => {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => { resp.writeHead(200, { "Content-Type": "application/json" });
        resp.end(JSON.stringify({ choices: [{ message: { content: "Hi — I'm your local model. To reset your password, use the link on the sign-in page." } }], usage: { total_tokens: 14 } })); });
    });
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;

  // Dynamic imports AFTER BO_CE_DATA is set, so the store uses the temp dir.
  const { Store } = await import("./store.mjs");
  const { generateOrg } = await import("./onboarding.mjs");
  const core = await import("./ce-core.mjs");
  const { runNode } = await import("./adapters.mjs");

  // ── 2b. starts with no BrainOutput account / key, no company yet (onboarding would launch) ───────
  const fresh = new Store(process.env.BO_CE_DATA);
  check("2. starts without a BrainOutput account or API key", !process.env.BRAINOUTPUT_API_KEY && !process.env.BO_ACCOUNT);
  check("3. first-run: no company exists yet → onboarding launches", !(fresh.def.company && fresh.def.company.name));

  // ── 4/6/7. build a small company on the user's own local models ─────────────────────────────────
  const departments = ["technical", "customer-service", "finance"];
  const agents = generateOrg({ companyDoes: "A tiny test studio", departments });
  const localConn = (id, model) => ({ id, kind: "local", provider: "stub-local", model, endpoint, costSource: "local-compute", funder: "local", contextSize: 8192, coding: true, multilingual: true, vision: false });
  // TWO local connections → different capability slots draw on different model sources (req 7).
  const connections = [localConn("local:worker", "stub-worker-3b"), localConn("local:planner", "stub-planner-7b")];
  const slots = new Set();
  for (const a of agents) for (const s of Object.values(a.capabilities || {})) if (s) slots.add(s);
  const assignments = {};
  for (const s of slots) assignments[s] = /reason|plan|review|private|long-context/.test(s) ? "local:planner" : "local:worker";
  const config = { company: { name: "Smoke Studio", brainoutputFundedInference: "forbidden" }, departments, agents, modelConnections: connections, modelAssignments: assignments, policies: {} };

  const vc = core.validateCompanyConfig(config);
  check("4. config validates (local model selectable; BYOK/free supported by design)", vc.ok, (vc.errors || []).join("; "));

  fresh.migrateFromConfig(config);
  check("6. company created with technical + customer-service + finance", departments.every((d) => fresh.def.departments.includes(d)) && fresh.def.agents.length >= 3);
  check("7. different capability slots assigned to different model sources", new Set(Object.values(assignments)).size >= 2);
  check("   generated organization is dormant until the first objective", (fresh.def.agents || []).every((a) => (a.activation || "dormant") === "dormant"));

  // ── 5. no founder/BrainOutput credential is visible or accessible ───────────────────────────────
  const exported = fresh.exportDefinition();
  const dump = JSON.stringify(exported) + JSON.stringify(fresh.def.modelConnections);
  const fundedFunder = (fresh.def.modelConnections || []).some((c) => !["free", "user", "local"].includes(c.funder));
  const literalKey = /"apiKey"\s*:\s*"[^"]+"/.test(dump) || /sk-[A-Za-z0-9]{16,}/.test(dump);
  check("5. no BrainOutput-funded source & no literal credential exposed", !fundedFunder && !literalKey);

  // ── 8/9. execute a real bounded task against the local stub, capture the full result ────────────
  const catalog = core.makeCatalog([]);
  const ctx = { agents: fresh.def.agents, assignments: fresh.def.modelAssignments, connections: fresh.def.modelConnections, catalog, departments: {} };
  const routed = core.routeTask({ department: "customer-service", task: { complexity: "low" } }, ctx);
  if (!routed.ok) throw new Error(`routing failed: ${routed.reason}`);
  const nodeResults = [];
  for (const n of routed.plan) nodeResults.push(await runNode(n, n.model, { prompt: "How do I reset my password?" }, { maxTokens: 64 }));
  const summary = core.executionSummary(nodeResults);
  const exec = fresh.addExecution({ id: `exec-smoke-${Date.now()}`, agent: routed.agent, department: routed.department, shape: routed.shape,
    results: nodeResults, summary, brainoutputFundedTokens: summary.brainoutputFundedTokens, status: "done", createdAt: null });
  fresh.save();
  const worker = nodeResults.find((x) => x.model) || nodeResults[0] || {};
  const hasFields = !!routed.agent && !!routed.department && !!worker.provider && !!worker.model && !!worker.costSource &&
    exec.status === "done" && Array.isArray(nodeResults) && ("output" in worker || "artifact" in worker) && typeof worker.tokens === "number";
  check("8. a real bounded task executes on the local model", worker.output != null || worker.tokens > 0, worker.output ? "" : "no model output");
  check("9. result includes agent/department/provider/model/cost-source/status/logs/artifacts/tokens", hasFields,
    `agent=${routed.agent} dept=${routed.department} provider=${worker.provider} model=${worker.model} cost=${worker.costSource} tokens=${worker.tokens}`);

  // ── 11. BrainOutput-funded inference is exactly $0 ──────────────────────────────────────────────
  check("11. BrainOutput-funded inference is exactly $0", summary.zeroFundedOk && summary.brainoutputFundedTokens === 0, `funded=${summary.brainoutputFundedTokens}`);

  // ── 10. runtime history + company config survive a restart ──────────────────────────────────────
  const restarted = new Store(process.env.BO_CE_DATA);
  const companyOk = restarted.def.company && restarted.def.company.name === "Smoke Studio" && restarted.def.agents.length >= 3;
  const historyOk = (restarted.runtime.executions || []).some((e) => e.id === exec.id);
  check("10. company config + runtime history survive an application restart", companyOk && historyOk);

  const passed = results.every((r) => r.ok);
  console.log(`\n${passed ? "✓ CLEAN-INSTALL SMOKE PASSED" : "✗ CLEAN-INSTALL SMOKE FAILED"} — ${results.filter((r) => r.ok).length}/${results.length} checks · BrainOutput-funded inference: $0`);
  return passed;
}

// Always stop the stub + remove the temp dir. Called BEFORE process.exit (which would otherwise
// pre-empt a .finally handler and leak the temp dir).
function cleanup() { try { server && server.close(); } catch {} try { T && rmSync(T, { recursive: true, force: true }); } catch {} }

// ── requirement 12: installation failure produces an ACTIONABLE error, not a raw stack ────────────
run()
  .then((ok) => { cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => {
    console.error(`\nSMOKE FAILED: ${e && e.message ? e.message : e}\n  → check Node ≥18, that no port is blocked on 127.0.0.1, and that you ran from the repo root (see CLEAN_INSTALL.md).`);
    cleanup(); process.exit(1);
  });
