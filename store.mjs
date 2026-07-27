// BrainOutput Community Edition — durable local persistence (2026-07-27).
// The simplest reliable store: JSON files with atomic writes (temp + rename). Two files:
//   definition.json — company, departments, agents, model connections, capability assignments,
//                     policies. EXPORTABLE, and contains NO secrets (connections only reference a
//                     user env-var NAME via apiKeyEnv, never a key value).
//   runtime.json    — projects, tasks, executions, artifacts, approvals (local runtime state).
// Credentials never live here — they stay in the user's environment/local, separate from any
// exported company definition. ESM, zero-dep.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIR = process.env.BO_CE_DATA || join(process.env.HOME || ".", ".local", "share", "bo-community");

const EMPTY_DEF = { company: { name: "", brainoutputFundedInference: "forbidden" }, departments: [], agents: [], modelConnections: [], modelAssignments: {}, policies: {} };
const EMPTY_RUNTIME = { projects: [], tasks: [], executions: [], artifacts: [], approvals: [] };

// Fields that must NEVER be written into a connection (defense in depth — apiKeyEnv is a NAME, not a key).
const SECRET_FIELDS = ["apiKey", "key", "token", "secret", "password"];
function stripSecrets(conn) {
  const c = { ...conn };
  for (const f of SECRET_FIELDS) delete c[f];
  return c;
}

export class Store {
  constructor(dir = DEFAULT_DIR) {
    this.dir = dir;
    this.defPath = join(dir, "definition.json");
    this.runtimePath = join(dir, "runtime.json");
    mkdirSync(dir, { recursive: true });
    this.def = this._read(this.defPath, EMPTY_DEF);
    this.runtime = this._read(this.runtimePath, EMPTY_RUNTIME);
  }
  _read(p, fallback) { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : structuredClone(fallback); } catch { return structuredClone(fallback); } }
  _atomicWrite(p, obj) { const tmp = `${p}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n"); renameSync(tmp, p); }
  saveDefinition() { this.def.modelConnections = (this.def.modelConnections || []).map(stripSecrets); this._atomicWrite(this.defPath, this.def); return this; }
  saveRuntime() { this._atomicWrite(this.runtimePath, this.runtime); return this; }
  save() { return this.saveDefinition().saveRuntime(); }

  // ── definition setters ────────────────────────────────────────────────────────────────────
  setCompany(company) { this.def.company = { brainoutputFundedInference: "forbidden", ...company }; return this; }
  setDepartments(list) { this.def.departments = [...list]; return this; }
  setAgents(list) { this.def.agents = list.map((a) => ({ activation: "dormant", ...a })); return this; }
  setConnections(list) { this.def.modelConnections = list.map(stripSecrets); return this; }
  setAssignments(map) { this.def.modelAssignments = { ...map }; return this; }
  setPolicies(p) { this.def.policies = { ...p }; return this; }

  // ── runtime records (append/update by id) ───────────────────────────────────────────────────
  _upsert(coll, rec) { const i = this.runtime[coll].findIndex((x) => x.id === rec.id); if (i >= 0) this.runtime[coll][i] = { ...this.runtime[coll][i], ...rec }; else this.runtime[coll].push(rec); return rec; }
  addProject(rec) { return this._upsert("projects", rec); }
  addTask(rec) { return this._upsert("tasks", rec); }
  addExecution(rec) { return this._upsert("executions", rec); }
  addArtifact(rec) { return this._upsert("artifacts", rec); }
  addApproval(rec) { return this._upsert("approvals", rec); }

  // ── migration from the current JSON config (demo/company.json or an onboarding output) ───────
  migrateFromConfig(cfg) {
    this.setCompany(cfg.company || { name: cfg.name || "My Company" });
    this.setDepartments(cfg.departments || [...new Set((cfg.agents || []).map((a) => a.department))]);
    this.setAgents(cfg.agents || []);
    this.setConnections(cfg.modelConnections || []);
    this.setAssignments(cfg.modelAssignments || {});
    this.setPolicies(cfg.policies || {});
    return this.saveDefinition();
  }

  // ── export / import a COMPLETE company definition, excluding credentials ──────────────────────
  exportDefinition() {
    return {
      _format: "bo-community-company/v1",
      company: this.def.company,
      departments: this.def.departments,
      agents: this.def.agents,
      // connections carry only the env-var NAME (apiKeyEnv), never a secret value
      modelConnections: (this.def.modelConnections || []).map(stripSecrets),
      modelAssignments: this.def.modelAssignments,
      policies: this.def.policies,
    };
  }
  importDefinition(def) {
    if (def._format && def._format !== "bo-community-company/v1") throw new Error(`unknown company format: ${def._format}`);
    this.setCompany(def.company || {});
    this.setDepartments(def.departments || []);
    this.setAgents(def.agents || []);
    this.setConnections(def.modelConnections || []);   // stripSecrets applies
    this.setAssignments(def.modelAssignments || {});
    this.setPolicies(def.policies || {});
    return this.saveDefinition();
  }
}
