#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — unified launcher (2026-07-27).
// A configurable AI company that runs entirely on YOUR free / local / BYOK models.
// It never uses a BrainOutput account, BrainOutput's own hosted paid models, or any paid BrainOutput model.
//   bo-community doctor    check prerequisites (Node, a local/free/BYOK model source)
//   bo-community setup     load the starter company into your local store
//   bo-community serve     start the web dashboard (http://127.0.0.1:4177)
//   bo-community onboard   interactive/CLI first-run onboarding
//   bo-community demo      run the three sample workflows headless
//   bo-community store …   migrate/export/import/show the local store
//   bo-community discover  approve a scope, then inventory this host + an approved network
//   bo-community inventory show what is known, and how fresh the evidence is
//   bo-community diagnose  deterministic checks, then an optional model EXPLANATION
//   bo-community opportunities  AI opportunities, with assumptions always visible
//   bo-community twin      the Infrastructure Twin: assets and dependencies
//   bo-community ask       ad-hoc question from the CLI — saved as a shell thread
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { Store } from "./store.mjs";
import { ossCompanyPlaybook, validatePlaybook } from "./playbooks.mjs";
import { substituteInstalled } from "./onboarding.mjs";
import { describeLocation } from "./runtimes.mjs";
import { buildKnowledgeSource } from "./knowledge.mjs";
import { searchRag } from "./rag.mjs";
import { newConversation, addMessage } from "./chat.mjs";
import { findProject } from "./projects.mjs";
import { selectModel, makeCatalog } from "./ce-core.mjs";
import { runNode } from "./adapters.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const run = (script, args = []) => spawn(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" });

function probe(host, port, path) {
  return new Promise((res) => { const r = request({ host, port, path, timeout: 2000 }, (x) => { x.setEncoding("utf8"); let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res(d)); }); r.on("error", () => res("")); r.on("timeout", () => { r.destroy(); res(""); }); r.end(); });
}

async function doctor() {
  console.log("BrainOutput Community — prerequisites\n" + "=".repeat(40));
  const [maj] = process.versions.node.split(".").map(Number);
  console.log(`${maj >= 18 ? "✓" : "✗"} Node ${process.versions.node} (need ≥18)`);
  const ollama = await probe("127.0.0.1", 11434, "/api/tags");
  let localModels = [];
  try { localModels = (JSON.parse(ollama).models || []).map((m) => m.name); } catch {}
  console.log(`${localModels.length ? "✓" : "○"} Local models (ollama): ${localModels.join(", ") || "none — install ollama + `ollama pull qwen3-30b-a3b`, or use a free/BYOK model"}`);
  const byok = ["USER_OWN_ANTHROPIC_KEY", "USER_OWN_OPENAI_KEY", "USER_OWN_OPENROUTER_KEY"].filter((k) => process.env[k]);
  console.log(`${byok.length ? "✓" : "○"} BYOK keys present: ${byok.join(", ") || "none set (optional)"}`);
  // Which models does the shipped example expect, and does this machine have them?
  try {
    const starter = JSON.parse(readFileSync(join(HERE, "samples", "starter-company.json"), "utf8"));
    const wanted = [...new Set((starter.modelConnections || []).filter((c) => c.funder === "local").map((c) => c.model))];
    const missing = wanted.filter((m) => !localModels.includes(m));
    if (missing.length) {
      console.log(`○ Example (appliance-class) models not installed here: ${missing.join(", ")}`);
      console.log(`  BrainOutput will fit the example to what you have. To run it as designed:`);
      for (const m of missing) console.log(`     ollama pull ${m}`);
    } else if (wanted.length) console.log(`✓ Every model the example expects is installed`);
  } catch {}
  console.log(`\nNeeds NONE of: a BrainOutput account, BrainOutput credits, Claude, Kimi, the hosted agent fleet.`);
  if (localModels.length || byok.length) {
    console.log(`\nReady. Next:`);
    console.log(`  bo-community setup && bo-community serve   # your company + the dashboard`);
    console.log(`  bo-community demo                          # three workflows on your own models`);
  } else {
    console.log(`\nNo model connected yet — that is fine, two things already work:`);
    console.log(`  bo-community twin-demo    # the whole Work Twin walkthrough, no model required`);
    console.log(`  bo-community write-demo   # how an approved write actually happens`);
    console.log(`\nWhen you want real inference, pick ONE:`);
    console.log(`  • local  : install ollama, then  ollama pull qwen3-30b-a3b`);
    console.log(`  • free   : bo-community serve → Connect a model → "Use free models"`);
    console.log(`  • your own key: export USER_OWN_ANTHROPIC_KEY=…  (or OPENAI/OPENROUTER)`);
  }
}

async function setup() {
  const starter = JSON.parse(readFileSync(join(HERE, "samples", "starter-company.json"), "utf8"));
  // The starter names appliance-class models. Fit it to what this machine actually has, out loud.
  let installed = [];
  try { installed = (JSON.parse(await probe("127.0.0.1", 11434, "/api/tags")).models || []).map((m) => m.name); } catch {}
  const sub = substituteInstalled(starter.modelConnections, installed);
  starter.modelConnections = sub.connections;
  const s = new Store().migrateFromConfig(starter);
  if (sub.substitutions.length) {
    console.log(`Fitted the starter company to the models you have installed:`);
    for (const x of sub.substitutions) console.log(`   • ${x.role.padEnd(9)} ${x.wanted}  →  ${x.used}`);
    console.log(`   (the example is sized for a 128 GB appliance — \`ollama pull <model>\` for the originals)`);
  } else if (!installed.length) {
    console.log(`No local models detected. Connect one in the dashboard, or: ollama pull qwen3-30b-a3b`);
  }
  console.log(`Loaded starter company "${s.def.company.name}" → ${s.dir}`);
  console.log(`  departments: ${s.def.departments.join(", ")}`);
  console.log(`  agents: ${s.def.agents.length} (dormant) · connections: ${s.def.modelConnections.length} · runs on your own models`);
  console.log(`\nNext:`);
  console.log(`  bo-community serve       # dashboard → http://127.0.0.1:4177  (setup, then chat)`);
  console.log(`  bo-community demo        # three sample workflows on your own models`);
  console.log(`  bo-community twin-demo   # the Work Twin walkthrough — needs no model at all`);
}

switch (cmd) {
  case "doctor": await doctor(); break;
  case "setup": await setup(); break;
  case "serve": run("web-server.mjs", rest); break;
  case "onboard": run("bo-ce-onboard.mjs", rest); break;
  case "demo": run("bo-ce.mjs", rest); break;
  case "store": run("bo-ce-store.mjs", rest); break;
  case "playbook": playbook(); break;
  case "write-demo": run("bo-ce-write.mjs", rest); break;
  case "twin-demo": run("bo-ce-twin.mjs", rest); break;
  // Discovery & diagnostics. These were listed in the header comment above and had NO dispatch
  // case, so `bo-community discover` printed the usage line and did nothing.
  case "discover": case "inventory": case "diagnose": case "opportunities": case "twin":
    run("discovery/run.mjs", [cmd, ...rest]); break;
  case "ask": await ask(rest); break;
  case "connect": await connectBridge(rest); break;
  default:
    console.log("BrainOutput Community Edition — runs on YOUR own models (free, local, subscription, or BYOK).\n");
    console.log("usage: bo-community <doctor|setup|serve|onboard|demo|store|playbook|discover|inventory|diagnose|opportunities|twin|ask|connect|write-demo|twin-demo>");
}

/**
 * bo connect — the local bridge. Pair this computer with a workspace (hosted trial / cloud / or
 * your own `serve` instance) so the workspace can use LOCAL models and GRANTED folders only.
 * Outbound-only; the code is single-use and short-lived; revoke anytime from the workspace.
 *   bo-community connect --url https://w….trial.brainoutput.com --code K7F2-9Q3M --name "Dimitri's laptop" --allow /home/me/docs
 */
async function connectBridge(args) {
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const url = (opt("--url") || "").replace(/\/+$/, "");
  const code = opt("--code");
  const name = opt("--name") || `${process.env.USER || process.env.USERNAME || "my"}'s computer`;
  const allow = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--allow" && args[i + 1]) allow.push(args[i + 1]);
  if (!url || !code) {
    console.log("usage: bo-community connect --url <workspace-url> --code <pairing-code> [--name <name>] [--allow <folder>]…");
    console.log("Get the code from your workspace: Settings → Sources → This computer → Pair a device.");
    process.exit(1);
  }
  const post = async (path, body) => {
    const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Number(body.holdMs || 5000) + 15000) });
    return r.json();
  };
  console.log(`BrainOutput bridge — pairing with ${url} …`);
  const { bridgePair, bridgeLoop, makeLocalExec } = await import("./local-bridge.mjs");
  let node;
  try { node = await bridgePair({ url, code, name, grants: allow, post }); }
  catch (e) { console.error(`✗ pairing failed: ${e.message}`); process.exit(1); }
  console.log(`✓ paired as '${name}' (${node.nodeId})` + (allow.length ? ` — granted folders: ${allow.join(", ")}` : " — no folders granted (models only)"));
  const exec = makeLocalExec({ allow });
  try { const { models } = await exec("list-models", {});
    console.log(`✓ local models: ${models.join(", ") || "none (install ollama to add some)"}`);
    await post("/api/local/result", { nodeId: node.nodeId, credential: node.credential, callId: "announce", models }).catch(() => {});
  } catch { console.log("○ no local ollama found — the bridge still serves granted folders"); }
  console.log("listening… (Ctrl-C to stop; the workspace shows this device while connected)");
  await bridgeLoop({ url, nodeId: node.nodeId, credential: node.credential, exec, post,
    onError: (e) => console.error(`  bridge note: ${String(e.message || e).slice(0, 120)}`) });
}

/**
 * Ad-hoc ask from the CLI — the same read-only path as the web chat's Ask mode. The thread is
 * saved (optionally under `--project <name>`) so it appears in the shell and nothing is lost.
 *   bo-community ask "why can't I reach the printer?"
 *   bo-community ask --project office-infra "what did we decide about the vlan?"
 */
async function ask(args) {
  const pi = args.indexOf("--project");
  const projectName = pi >= 0 ? args[pi + 1] : null;
  const question = args.filter((a, i) => a !== "--project" && (pi < 0 || i !== pi + 1)).join(" ").trim();
  if (!question) { console.error('usage: bo-community ask [--project <name>] "<question>"'); process.exit(2); }

  const s = new Store();
  let projectId = null;
  if (projectName) {
    const p = findProject(s.runtime, projectName);
    if (!p) { console.error(`no project '${projectName}'. Projects: ${(s.runtime.projects || []).filter((x) => x.kind === "project").map((x) => x.name).join(", ") || "(none)"}`); process.exit(2); }
    projectId = p.id;
  }

  const hits = searchRag([buildKnowledgeSource(s.def)], question, { topK: 3 });
  let model = null;
  try {
    const a = (s.def.agents || [])[0];
    const slot = a?.capabilities?.worker || a?.capabilities?.planner || "fast-cheap";
    model = { agent: a?.id || null, ...selectModel(slot, { assignments: s.def.modelAssignments, connections: s.def.modelConnections, catalog: makeCatalog([]) }) };
  } catch { /* no model configured — knowledge hits still answer */ }

  let reply = null;
  if (model?.connection) {
    const prompt = `Answer the question using ONLY the context. Be brief.\n\nContext:\n${hits.map((r) => `- ${r.text} (${r.citation})`).join("\n") || "(no matching company knowledge)"}\n\nQuestion: ${question}`;
    try { reply = (await runNode({ node: "chat", slot: model.slot }, model, { prompt }, { maxTokens: 300 })).output || null; } catch {}
  }
  if (!reply) reply = hits.length
    ? `From your company knowledge:\n${hits.map((r) => `• ${r.text}  [${r.citation}]`).join("\n")}`
    : "No matching company knowledge, and no conversation model is configured — connect a free/local/BYOK model.";

  let conv = newConversation({ scope: "company", projectId });
  conv = addMessage(conv, { role: "user", text: question, mode: "ask", at: Date.now() });
  conv = addMessage(conv, { role: "assistant", text: reply, mode: "ask", at: Date.now(),
    meta: { model: model?.model || null, provider: model?.provider || null, costSource: model?.costSource || null, citations: hits.map((r) => r.citation) } });
  s.addConversation({ ...conv, updatedAt: Date.now() }); s.saveRuntime();

  console.log(reply);
  console.log(`\n(saved as ${projectId ? `project '${projectName}'` : "an ad-hoc"} thread — open it in the shell: bo-community serve)`);
}

function playbook() {
  const pb = ossCompanyPlaybook();
  const v = validatePlaybook(pb);
  console.log(`Playbook: ${pb.company.name}\n${"=".repeat(52)}`);
  console.log(pb.note + "\n");
  console.log(`Open-source stack: ${pb.stack.join(" · ")}\n`);
  for (const a of pb.agents) {
    const conns = a.connectors.map((c) => `${c.label} (read-only)`).join(", ");
    console.log(`▸ ${a.role} (${a.department})`);
    console.log(`    runs: ${describeLocation(a.runtime)}`);
    console.log(`    tools: ${conns}` + (Object.keys(a.approvalThresholds).length ? ` · approval: ${Object.keys(a.approvalThresholds).join(", ")}` : ""));
  }
  console.log(`\n${v.ok ? "✓" : "✗"} Every runtime free/local, every connector read-only, every agent dormant — free to start.`);
}
