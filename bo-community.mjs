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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { Store } from "./store.mjs";
import { ossCompanyPlaybook, validatePlaybook } from "./playbooks.mjs";
import { substituteInstalled } from "./onboarding.mjs";
import { describeLocation } from "./runtimes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const run = (script, args = []) => spawn(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" });

function probe(host, port, path) {
  return new Promise((res) => { const r = request({ host, port, path, timeout: 2000 }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res(d)); }); r.on("error", () => res("")); r.on("timeout", () => { r.destroy(); res(""); }); r.end(); });
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
  default:
    console.log("BrainOutput Community Edition — runs on YOUR own models (free, local, subscription, or BYOK).\n");
    console.log("usage: bo-community <doctor|setup|serve|onboard|demo|store|playbook|write-demo|twin-demo>");
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
