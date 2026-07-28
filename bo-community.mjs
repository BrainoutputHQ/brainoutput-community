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
  console.log(`${localModels.length ? "✓" : "○"} Local models (ollama): ${localModels.join(", ") || "none — install ollama + `ollama pull qwen2.5:3b`, or use a free/BYOK model"}`);
  const byok = ["USER_OWN_ANTHROPIC_KEY", "USER_OWN_OPENAI_KEY", "USER_OWN_OPENROUTER_KEY"].filter((k) => process.env[k]);
  console.log(`${byok.length ? "✓" : "○"} BYOK keys present: ${byok.join(", ") || "none set (optional)"}`);
  console.log(`\nNeeds NONE of: a BrainOutput account, BrainOutput credits, Claude, Kimi, the hosted agent fleet.`);
  console.log(localModels.length || byok.length ? "\nReady. Next: bo-community setup && bo-community serve" : "\nConnect at least one model source (local/free/BYOK), then: bo-community setup");
}

function setup() {
  const starter = JSON.parse(readFileSync(join(HERE, "samples", "starter-company.json"), "utf8"));
  const s = new Store().migrateFromConfig(starter);
  console.log(`Loaded starter company "${s.def.company.name}" → ${s.dir}`);
  console.log(`  departments: ${s.def.departments.join(", ")}`);
  console.log(`  agents: ${s.def.agents.length} (dormant) · connections: ${s.def.modelConnections.length} · runs on your own models`);
  console.log(`\nNext:\n  bo-community serve      # web dashboard → http://127.0.0.1:4177\n  bo-community demo       # run the 3 sample workflows headless`);
}

switch (cmd) {
  case "doctor": await doctor(); break;
  case "setup": setup(); break;
  case "serve": run("web-server.mjs", rest); break;
  case "onboard": run("bo-ce-onboard.mjs", rest); break;
  case "demo": run("bo-ce.mjs", rest); break;
  case "store": run("bo-ce-store.mjs", rest); break;
  default:
    console.log("BrainOutput Community Edition — runs on YOUR own models (free, local, subscription, or BYOK).\n");
    console.log("usage: bo-community <doctor|setup|serve|onboard|demo|store>");
}
