#!/usr/bin/env node --test
// Tests for the Community persistence store. Uses a temp data dir. run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, HISTORY_LIMITS } from "./store.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "bo-ce-store-"));

test("persists a company definition and RELOADS it after a simulated restart", () => {
  const dir = freshDir();
  try {
    const s1 = new Store(dir);
    s1.setCompany({ name: "Acme" }).setDepartments(["technical", "finance"])
      .setAgents([{ id: "tech-eng", department: "technical", role: "engineer" }])
      .setConnections([{ id: "local:q", kind: "local", provider: "ollama", model: "qwen2.5:7b", costSource: "local-compute", funder: "local" }])
      .setAssignments({ "coding-free": "local:q" }).save();
    // "restart": a brand-new Store on the same dir must see everything.
    const s2 = new Store(dir);
    assert.equal(s2.def.company.name, "Acme");
    assert.deepEqual(s2.def.departments, ["technical", "finance"]);
    assert.equal(s2.def.agents[0].id, "tech-eng");
    assert.equal(s2.def.agents[0].activation, "dormant");     // agents default dormant
    assert.equal(s2.def.modelAssignments["coding-free"], "local:q");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtime records (projects/tasks/executions/artifacts/approvals) survive restart", () => {
  const dir = freshDir();
  try {
    const s1 = new Store(dir);
    s1.addProject({ id: "p1", name: "Website" });
    s1.addTask({ id: "t1", projectId: "p1", objective: "add slugify", status: "done" });
    s1.addExecution({ id: "e1", taskId: "t1", agent: "tech-eng", provider: "ollama", model: "qwen2.5:7b", costSource: "local-compute", tokens: 120, brainoutputFundedTokens: 0 });
    s1.addArtifact({ id: "a1", executionId: "e1", name: "slugify.js" });
    s1.addApproval({ id: "ap1", taskId: "t1", kind: "payment", status: "pending" });
    s1.saveRuntime();
    const s2 = new Store(dir);
    assert.equal(s2.runtime.tasks[0].status, "done");
    assert.equal(s2.runtime.executions[0].brainoutputFundedTokens, 0);
    assert.equal(s2.runtime.artifacts[0].name, "slugify.js");
    assert.equal(s2.runtime.approvals[0].kind, "payment");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("migrates from the current JSON config", () => {
  const dir = freshDir();
  try {
    const cfg = { company: { name: "Demo Co" }, modelAssignments: { "coding-free": "c1" },
      modelConnections: [{ id: "c1", kind: "local", provider: "ollama", model: "m", costSource: "local-compute", funder: "local" }],
      agents: [{ id: "x", department: "technical", role: "architect" }, { id: "y", department: "finance", role: "controller" }] };
    const s = new Store(dir).migrateFromConfig(cfg);
    assert.equal(s.def.company.name, "Demo Co");
    assert.deepEqual(s.def.departments.sort(), ["finance", "technical"]);   // derived from agents
    const s2 = new Store(dir);
    assert.equal(s2.def.agents.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("export/import round-trips a company definition and EXCLUDES credentials", () => {
  const dir = freshDir();
  try {
    const s = new Store(dir);
    // even if a secret sneaks in, the store strips it (defense in depth)
    s.setConnections([{ id: "byok", kind: "byok", provider: "user-openai", model: "gpt", apiKeyEnv: "USER_KEY", apiKey: "sk-LEAKED", costSource: "user-api-account", funder: "user" }]);
    s.setCompany({ name: "Exp" }).save();
    const def = s.exportDefinition();
    assert.equal(def._format, "bo-community-company/v1");
    const conn = def.modelConnections[0];
    assert.equal(conn.apiKeyEnv, "USER_KEY");          // the env-var NAME travels
    assert.equal(conn.apiKey, undefined);              // the secret value NEVER travels
    assert.ok(!JSON.stringify(def).includes("sk-LEAKED"), "no secret in export");
    // import into a fresh store
    const dir2 = freshDir();
    try {
      const s2 = new Store(dir2).importDefinition(def);
      assert.equal(s2.def.company.name, "Exp");
      assert.equal(s2.def.modelConnections[0].apiKey, undefined);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("importDefinition rejects an unknown format", () => {
  const dir = freshDir();
  try { assert.throws(() => new Store(dir).importDefinition({ _format: "something-else" }), /unknown company format/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtime history is bounded: oldest executions/tasks dropped, newest kept, persists across restart", () => {
  const dir = freshDir();
  try {
    const s1 = new Store(dir, { historyLimits: { executions: 3, tasks: 2 } });
    for (let i = 1; i <= 5; i++) s1.addExecution({ id: `e${i}`, status: "done", brainoutputFundedTokens: 0 });
    for (let i = 1; i <= 4; i++) s1.addTask({ id: `t${i}`, status: "done" });
    s1.saveRuntime();
    assert.deepEqual(s1.runtime.executions.map((e) => e.id), ["e3", "e4", "e5"]);
    assert.deepEqual(s1.runtime.tasks.map((t) => t.id), ["t3", "t4"]);
    const s2 = new Store(dir, { historyLimits: { executions: 3, tasks: 2 } });
    assert.deepEqual(s2.runtime.executions.map((e) => e.id), ["e3", "e4", "e5"]);
    assert.deepEqual(s2.runtime.tasks.map((t) => t.id), ["t3", "t4"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bounding NEVER drops active records (running tasks, pending approvals)", () => {
  const dir = freshDir();
  try {
    const s = new Store(dir, { historyLimits: { tasks: 1, approvals: 1 } });
    s.addTask({ id: "t-old", status: "running" });
    s.addTask({ id: "t-new", status: "done" });
    s.addApproval({ id: "a-old", status: "pending" });
    s.addApproval({ id: "a-new", status: "approved" });
    s.saveRuntime();
    assert.deepEqual(s.runtime.tasks.map((t) => t.id), ["t-old", "t-new"]);   // running survives
    assert.deepEqual(s.runtime.approvals.map((a) => a.id), ["a-old", "a-new"]); // pending survives
    // once they resolve, the next save trims them like any finished record
    s.runtime.tasks[0].status = "done";
    s.runtime.approvals[0].status = "approved";
    s.saveRuntime();
    assert.deepEqual(s.runtime.tasks.map((t) => t.id), ["t-new"]);
    assert.deepEqual(s.runtime.approvals.map((a) => a.id), ["a-new"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("default HISTORY_LIMITS bound every runtime collection", () => {
  const dir = freshDir();
  try {
    const s = new Store(dir);
    assert.deepEqual(s.historyLimits, HISTORY_LIMITS);
    for (const coll of ["projects", "tasks", "executions", "artifacts", "approvals"]) {
      assert.ok(HISTORY_LIMITS[coll] > 0, `${coll} has a positive limit`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
