#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Community persistence CLI (milestone 3). Simplest reliable local store; credentials excluded
// from exports. Data dir: $BO_CE_DATA or ~/.local/share/bo-community.
//   bo-ce-store migrate <config.json>   import the current JSON config into the durable store
//   bo-ce-store export [out.json]       write the company definition (NO secrets) to stdout/file
//   bo-ce-store import <in.json>        load a company definition from a file
//   bo-ce-store backup <out.json>       WHOLE store: company + runtime + the key that decrypts
//                                       credentials — this is what moves an install to another machine
//   bo-ce-store restore <in.json> [--force]  restore a bundle (refuses to overwrite without --force)
//   bo-ce-store show                    summarize what's persisted
import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "./store.mjs";

const [cmd, arg] = process.argv.slice(2);
const s = new Store();
switch (cmd) {
  case "backup": {
    const out = process.argv[3];
    const bundle = new Store().backupBundle();
    const json = JSON.stringify(bundle, null, 2);
    if (out) { writeFileSync(out, json, { mode: 0o600 }); console.error(`Wrote ${out} (${Object.keys(bundle.files).length} files).`); }
    else console.log(json);
    console.error(`⚠ This bundle CONTAINS the key that decrypts your stored credentials. Treat it like a password.`);
    break;
  }
  case "restore": {
    const inFile = process.argv[3];
    if (!inFile) { console.error("usage: bo-ce-store restore <in.json> [--force]"); process.exit(2); }
    try {
      const r = new Store().restoreBundle(JSON.parse(readFileSync(inFile, "utf8")), { force: process.argv.includes("--force") });
      console.error(`Restored ${r.restored.join(", ")} into ${r.dir}`);
    } catch (e) {
      console.error(`✗ ${e.message}`);            // a clear sentence, not a stack trace
      process.exit(1);
    }
    break;
  }
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
