// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — durable local persistence (2026-07-27).
// The simplest reliable store: JSON files with atomic writes (temp + rename). Two files:
//   definition.json — company, departments, agents, model connections, capability assignments,
//                     policies. EXPORTABLE, and contains NO secrets (connections only reference a
//                     user env-var NAME via apiKeyEnv, never a key value).
//   runtime.json    — projects, tasks, executions, artifacts, approvals (local runtime state).
// Credentials never live here — they stay in the user's environment/local, separate from any
// exported company definition. ESM, zero-dep.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { basename } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { join } from "node:path";

const DEFAULT_DIR = process.env.BO_CE_DATA || join(process.env.HOME || ".", ".local", "share", "bo-community");

const EMPTY_DEF = { company: { name: "", brainoutputFundedInference: "forbidden" }, departments: [], agents: [], modelConnections: [], modelAssignments: {}, policies: {}, settings: { mode: "regular" } };
const EMPTY_RUNTIME = { projects: [], tasks: [], executions: [], artifacts: [], approvals: [], conversations: [], missions: [], workTwins: [] };

// Runtime history bounds: runtime.json must not grow without limit. Oldest records are dropped
// first; ACTIVE records (running/pending tasks, pending approvals) are never dropped.
export const HISTORY_LIMITS = { projects: 100, tasks: 200, executions: 200, artifacts: 500, approvals: 200, conversations: 100, missions: 200, workTwins: 50 };
const ACTIVE_STATUS = new Set(["running", "pending"]);

// Fields that must NEVER be written into a connection (defense in depth — apiKeyEnv is a NAME, not a key).
const SECRET_FIELDS = ["apiKey", "key", "token", "secret", "password"];
function stripSecrets(conn) {
  const c = { ...conn };
  for (const f of SECRET_FIELDS) delete c[f];
  return c;
}

export class Store {
  constructor(dir = DEFAULT_DIR, { historyLimits } = {}) {
    this.dir = dir;
    this.defPath = join(dir, "definition.json");
    this.runtimePath = join(dir, "runtime.json");
    this.historyLimits = { ...HISTORY_LIMITS, ...(historyLimits || {}) };
    // The store holds work credentials and indexed mail metadata: keep it private to this user.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
    for (const p of [this.defPath, this.runtimePath]) { try { if (existsSync(p)) chmodSync(p, 0o600); } catch {} }
    this.def = this._read(this.defPath, EMPTY_DEF);
    this.runtime = this._read(this.runtimePath, EMPTY_RUNTIME);
  }
  /**
   * Read a store file. A file that cannot be parsed is NEVER silently treated as empty: falling back
   * quietly means the next save overwrites it, and the user's company — agents, connections,
   * assignments — is gone for good. The unreadable file is preserved beside the store and reported.
   */
  _read(p, fallback) {
    if (!existsSync(p)) return structuredClone(fallback);
    try { return JSON.parse(readFileSync(p, "utf8")); }
    catch (e) {
      const kept = `${p}.corrupt-${Date.now()}`;
      try { renameSync(p, kept); } catch {}
      (this.recovered ||= []).push({ file: basename(p), preservedAs: basename(kept), reason: e.message });
      console.error(`⚠ ${basename(p)} could not be read: ${e.message}`);
      console.error(`  The unreadable file was kept as ${basename(kept)} — nothing was overwritten.`);
      console.error(`  Starting from an empty company. Restore that file, or import a backup with: bo-community store import <file>`);
      return structuredClone(fallback);
    }
  }
  _atomicWrite(p, obj) {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, p);
    try { chmodSync(p, 0o600); } catch {}
  }

  // ── secrets at rest ──────────────────────────────────────────────────────────────────────────
  // A work-source password must never sit in the store as plaintext. It is sealed with AES-256-GCM
  // under a key file kept beside the store at 0600. Prefer `config.passwordEnv` where you can — then
  // no credential is stored at all.
  _secretKey() {
    const kp = join(this.dir, "secret.key");
    if (!existsSync(kp)) writeFileSync(kp, randomBytes(32).toString("base64"), { mode: 0o600 });
    try { chmodSync(kp, 0o600); } catch {}
    return Buffer.from(readFileSync(kp, "utf8").trim(), "base64");
  }
  sealSecret(plain) {
    if (plain == null || plain === "") return null;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this._secretKey(), iv);
    const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
    return { v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
  }
  openSecret(rec) {
    if (rec == null) return null;
    if (typeof rec === "string") return rec;            // legacy plaintext — re-sealed on next write
    const d = createDecipheriv("aes-256-gcm", this._secretKey(), Buffer.from(rec.iv, "base64"));
    d.setAuthTag(Buffer.from(rec.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(rec.ct, "base64")), d.final()]).toString("utf8");
  }
  // ── portable backup / restore ────────────────────────────────────────────────────────────────
  // A whole-store bundle: the company AND the runtime (work twins, conversations, missions, audit)
  // AND the key that decrypts stored credentials. The definition-only export loses everything a
  // trial user built — this is what moves a working install to another machine.
  backupBundle() {
    const files = {};
    for (const name of ["definition.json", "runtime.json", "secret.key"]) {
      const p = join(this.dir, name);
      if (existsSync(p)) files[name] = readFileSync(p, "utf8");
    }
    const body = { _format: "brainoutput-community-backup/1", files };
    body.checksum = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    return body;
  }

  /**
   * Restore a bundle into this store. Verifies the checksum first and refuses to overwrite an existing
   * store unless `force` — losing someone's company to a careless restore would be unforgivable.
   */
  restoreBundle(bundle, { force = false } = {}) {
    if (!bundle || bundle._format !== "brainoutput-community-backup/1") throw new Error("not a BrainOutput backup bundle");
    const expect = createHash("sha256").update(JSON.stringify(bundle.files || {})).digest("hex");
    if (bundle.checksum !== expect) throw new Error("backup is corrupted (checksum mismatch) — refusing to restore");
    const occupied = ["definition.json", "runtime.json"].filter((n) => existsSync(join(this.dir, n)));
    if (occupied.length && !force)
      throw new Error(`${this.dir} already holds a company (${occupied.join(", ")}). Re-run with --force to replace it.`);
    for (const [name, content] of Object.entries(bundle.files || {}))
      writeFileSync(join(this.dir, name), content, { mode: name === "secret.key" ? 0o600 : 0o600 });
    this.def = this._read(this.defPath, EMPTY_DEF);
    this.runtime = this._read(this.runtimePath, EMPTY_RUNTIME);
    return { restored: Object.keys(bundle.files || {}), dir: this.dir };
  }

  /** Re-seal any legacy plaintext work-source secret found in the runtime. */
  _sealLegacySecrets() {
    for (const t of this.runtime.workTwins || [])
      for (const a of t.accounts || [])
        if (typeof a.secret === "string" && a.secret) a.secret = this.sealSecret(a.secret);
  }
  saveDefinition() { this.def.modelConnections = (this.def.modelConnections || []).map(stripSecrets); this._atomicWrite(this.defPath, this.def); return this; }
  saveRuntime() { this._boundHistory(); this._sealLegacySecrets(); this._atomicWrite(this.runtimePath, this.runtime); return this; }

  // Keep the NEWEST `limit` records per collection; ACTIVE records are additionally always kept
  // (may exceed the limit until they resolve — active work is never dropped).
  _boundHistory() {
    for (const [coll, limit] of Object.entries(this.historyLimits)) {
      const list = this.runtime[coll];
      if (!Array.isArray(list) || list.length <= limit) continue;
      const cutoff = list.length - limit;
      this.runtime[coll] = list.filter((rec, i) => i >= cutoff || (rec && ACTIVE_STATUS.has(rec.status)));
    }
  }
  save() { return this.saveDefinition().saveRuntime(); }

  // ── definition setters ────────────────────────────────────────────────────────────────────
  setCompany(company) { this.def.company = { brainoutputFundedInference: "forbidden", ...company }; return this; }
  setDepartments(list) { this.def.departments = [...list]; return this; }
  setAgents(list) { this.def.agents = list.map((a) => ({ activation: "dormant", ...a })); return this; }
  setConnections(list) { this.def.modelConnections = list.map(stripSecrets); return this; }
  setAssignments(map) { this.def.modelAssignments = { ...map }; return this; }
  setPolicies(p) { this.def.policies = { ...p }; return this; }
  setSettings(p) { this.def.settings = { mode: "regular", ...(this.def.settings || {}), ...p }; return this; }

  // ── runtime records (append/update by id) ───────────────────────────────────────────────────
  _upsert(coll, rec) { const i = this.runtime[coll].findIndex((x) => x.id === rec.id); if (i >= 0) this.runtime[coll][i] = { ...this.runtime[coll][i], ...rec }; else this.runtime[coll].push(rec); return rec; }
  addProject(rec) { return this._upsert("projects", rec); }
  addTask(rec) { return this._upsert("tasks", rec); }
  addExecution(rec) { return this._upsert("executions", rec); }
  addArtifact(rec) { return this._upsert("artifacts", rec); }
  addApproval(rec) { return this._upsert("approvals", rec); }
  addConversation(rec) { return this._upsert("conversations", rec); }
  addMission(rec) { return this._upsert("missions", rec); }
  addWorkTwin(rec) { return this._upsert("workTwins", rec); }

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
