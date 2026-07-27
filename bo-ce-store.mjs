#!/usr/bin/env node
// Community persistence CLI (milestone 3). Simplest reliable local store; credentials excluded
// from exports. Data dir: $BO_CE_DATA or ~/.local/share/bo-community.
//   bo-ce-store migrate <config.json>   import the current JSON config into the durable store
//   bo-ce-store export [out.json]       write the company definition (NO secrets) to stdout/file
//   bo-ce-store import <in.json>        load a company definition from a file
//   bo-ce-store show                    summarize what's persisted
import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "./store.mjs";

const [cmd, arg] = process.argv.slice(2);
const s = new Store();
switch (cmd) {
  case "migrate": {
    if (!arg) { console.error("usage: migrate <config.json>"); process.exit(1); }
    s.migrateFromConfig(JSON.parse(readFileSync(arg, "utf8")));
    console.log(`migrated → ${s.dir} (${s.def.agents.length} agents, ${s.def.departments.length} departments, ${s.def.modelConnections.length} connections)`);
    break;
  }
  case "export": {
    const def = s.exportDefinition();
    const out = JSON.stringify(def, null, 2) + "\n";
    if (arg) { writeFileSync(arg, out); console.log(`exported company definition (no credentials) → ${arg}`); }
    else process.stdout.write(out);
    break;
  }
  case "import": {
    if (!arg) { console.error("usage: import <in.json>"); process.exit(1); }
    s.importDefinition(JSON.parse(readFileSync(arg, "utf8")));
    console.log(`imported → ${s.dir}`);
    break;
  }
  case "show": {
    console.log(`data dir: ${s.dir}`);
    console.log(`company: ${s.def.company.name || "(unnamed)"} · funded inference: ${s.def.company.brainoutputFundedInference}`);
    console.log(`departments: ${s.def.departments.join(", ") || "-"}`);
    console.log(`agents: ${s.def.agents.map((a) => a.id).join(", ") || "-"}`);
    console.log(`connections: ${s.def.modelConnections.map((c) => `${c.id}(${c.costSource})`).join(", ") || "-"}`);
    console.log(`runtime: ${s.runtime.projects.length} projects · ${s.runtime.tasks.length} tasks · ${s.runtime.executions.length} executions · ${s.runtime.approvals.length} approvals`);
    break;
  }
  default:
    console.error("usage: bo-ce-store <migrate|export|import|show> [arg]"); process.exit(1);
}
