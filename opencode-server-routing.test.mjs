#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// Tests for the skill/agent routing + context-monitoring/compaction added to the server-backed
// OpenCode runtime (opencode-server.mjs). Fully hermetic — a tiny in-process HTTP+SSE stub
// (node:http, zero deps) stands in for `opencode serve`, exactly like opencode-server.test.mjs's
// stub, extended with GET /api/skill, GET /api/agent, POST /api/session/{id}/agent,
// GET /api/session/{id}/context and POST /api/session/{id}/compact.
//
// What these tests pin down (see docs/OPENCODE_SERVER_API.md for the model/prompt/event contract
// this builds on; the skill/agent/context/compact contract itself was verified live against a real
// `opencode serve` 1.18.7 for this change — see the mission report):
//   1. task.skills/task.agentSlot resolve against the LIVE registry (GET /api/skill, GET /api/agent)
//      and, when an agentSlot is bound, the session's agent is switched (POST .../agent).
//   2. FAIL CLOSED: an unknown skill or agentSlot blocks the task with a clear, localized reason —
//      and the run never reaches POST /model, POST /agent, or POST /prompt.
//   3. GET /api/skill / GET /api/agent can be transiently empty right after boot — verified live,
//      the same warmup gotcha verifyModelPresent already handles for GET /api/model — so resolution
//      polls rather than failing closed on the very first (possibly still-warming) response.
//   4. Context usage (from GET /api/session/{id}/context) crossing a threshold triggers
//      POST /api/session/{id}/compact, and — successful or not (verified live: this endpoint
//      reproducibly 503s "not available yet", the same unusable-endpoint pattern already known for
//      /wait) — the attempt is ALWAYS recorded as a localized planner-defect signal, never silently.
//   5. Below threshold, compact is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifySkillsPresent, verifyAgentPresent, resolveRoutingDirectives, switchAgent,
  computeContextUsage, checkContextAndCompact, runSessionAgainstServer,
} from "./opencode-server.mjs";
import { t, LOCALES, missingKeys } from "./i18n.mjs";

// ── Stub `opencode serve` — opencode-server.test.mjs's stub, extended with the skill/agent/context/
// compact routes this change adds. Every call is counted so tests can assert what was (and was NOT)
// called — e.g. the directive gate must refuse WITHOUT ever calling /model, /agent or /prompt.
function startStub({ catalog = [], eventScript = [], messages = [],
  skills = [], skillsReadyAfter = 0, agents = [], agentsReadyAfter = 0,
  contextSequence = [[]], compactStatus = 204 } = {}) {
  const calls = { model: 0, prompt: 0, interrupt: 0, event: 0, session: 0,
    skill: 0, agentList: 0, agentSwitch: 0, context: 0, compact: 0 };
  let sseRes = null;

  function sendEvent(evt) {
    if (!sseRes) return;
    sseRes.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

      if (req.method === "GET" && path === "/api/health") return json(200, { healthy: true });
      if (req.method === "GET" && path === "/api/model") return json(200, { data: catalog });

      if (req.method === "GET" && path === "/api/skill") {
        calls.skill++;
        return json(200, { location: {}, data: calls.skill > skillsReadyAfter ? skills : [] });
      }
      if (req.method === "GET" && path === "/api/agent") {
        calls.agentList++;
        return json(200, { location: {}, data: calls.agentList > agentsReadyAfter ? agents : [] });
      }

      if (req.method === "POST" && path === "/api/session") {
        calls.session++;
        return json(200, { data: { id: "ses_stub1", projectID: "global", location: { directory: JSON.parse(body || "{}")?.location?.directory || null } } });
      }

      let m;
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/agent$/))) {
        calls.agentSwitch++;
        const b = JSON.parse(body || "{}");
        // Verified live: this endpoint does NOT validate `agent` against the registry — any string
        // gets 204. The fail-closed gate is resolveRoutingDirectives, never this endpoint itself.
        if (!b.agent) return json(400, { _tag: "InvalidRequestError", message: 'Missing key\n  at ["agent"]' });
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/model$/))) {
        calls.model++;
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/prompt$/))) {
        calls.prompt++;
        return json(200, { data: { admittedSeq: 1, id: "msg_stub1", sessionID: m[1] } });
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/interrupt$/))) {
        calls.interrupt++;
        res.writeHead(204); return res.end();
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/message$/))) {
        return json(200, { data: messages });
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/context$/))) {
        const i = Math.min(calls.context, contextSequence.length - 1);
        calls.context++;
        return json(200, { data: contextSequence[i] || [] });
      }
      if (req.method === "POST" && (m = path.match(/^\/api\/session\/([^/]+)\/compact$/))) {
        calls.compact++;
        if (compactStatus === 204) { res.writeHead(204); return res.end(); }
        return json(compactStatus, { _tag: "ServiceUnavailableError", message: "Session compact is not available yet", service: "session.compact" });
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/session\/([^/]+)\/event$/))) {
        calls.event++;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sseRes = res;
        let i = 0;
        const pump = () => {
          if (i >= eventScript.length) return;
          const { delayMs = 5, evt } = eventScript[i++];
          setTimeout(() => { sendEvent(evt); pump(); }, delayMs);
        };
        pump();
        res.on("close", () => { if (sseRes === res) sseRes = null; });
        return;
      }

      json(404, { error: "no such stub route", path });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
      });
    });
  });
}

function makeGitWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "oc-routing-test-"));
  execFileSync("git", ["-C", ws, "init", "-q"]);
  execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pre", "--allow-empty"]);
  return ws;
}

const MODEL = { providerID: "stub-provider", id: "stub-model" };
const CATALOG_ENTRY = { id: MODEL.id, providerID: MODEL.providerID, family: "stub", name: "Stub Model",
  capabilities: [], limit: { context: 1000, output: 4096 }, status: "ok" };
const SKILL_A = { name: "node-esm-live", description: "server-side JS", location: "/x.md", content: "…" };
const AGENT_BUILD = { id: "build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] };

function assistantMsg({ input = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  return { type: "assistant", tokens: { input, output: 1, reasoning: 0, cache: { read: cacheRead, write: cacheWrite } } };
}

// ── 1. Registry resolution + agent switch (happy path) ────────────────────────────────────────
test("task.skills/task.agentSlot resolve against the live registry and the session agent is switched", async () => {
  const eventScript = [{ evt: { type: "session.next.step.ended", data: { finish: "stop" } } }];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, skills: [SKILL_A], agents: [AGENT_BUILD] });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000,
      task: { skills: ["node-esm-live"], agentSlot: "build" },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stub.calls.agentSwitch, 1, "the resolved agentSlot must switch the session's agent");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── 2/3. Fail-closed refusal — the run must never start ───────────────────────────────────────
test("an unknown skill directive is refused BEFORE the run starts — model/agent/prompt are never called", async () => {
  const stub = await startStub({ catalog: [CATALOG_ENTRY], skills: [SKILL_A], agents: [AGENT_BUILD] });
  const ws = makeGitWorkspace();
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, registryTimeoutMs: 500,
      task: { skills: ["totally-bogus-skill"] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.noWork, true);
    assert.match(result.noWorkReason, /totally-bogus-skill/);
    assert.match(result.noWorkReason, /node-esm-live/, "the reason must NAME what IS available");
    assert.equal(stub.calls.model, 0, "POST /model must NEVER be called when a directive is refused");
    assert.equal(stub.calls.agentSwitch, 0, "POST /agent must NEVER be called when a directive is refused");
    assert.equal(stub.calls.prompt, 0, "POST /prompt must NEVER be called when a directive is refused");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("an unknown agentSlot directive is refused BEFORE the run starts — model/agent/prompt are never called", async () => {
  const stub = await startStub({ catalog: [CATALOG_ENTRY], skills: [SKILL_A], agents: [AGENT_BUILD] });
  const ws = makeGitWorkspace();
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, registryTimeoutMs: 500,
      task: { agentSlot: "totally-bogus-agent" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.noWork, true);
    assert.match(result.noWorkReason, /totally-bogus-agent/);
    assert.match(result.noWorkReason, /build/, "the reason must NAME what IS available");
    assert.equal(stub.calls.model, 0, "POST /model must NEVER be called when a directive is refused");
    assert.equal(stub.calls.agentSwitch, 0, "POST /agent must NEVER be called when a directive is refused");
    assert.equal(stub.calls.prompt, 0, "POST /prompt must NEVER be called when a directive is refused");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a task with no skills/agentSlot directives never touches GET /api/skill or GET /api/agent (zero overhead, unchanged behaviour)", async () => {
  const eventScript = [{ evt: { type: "session.next.step.ended", data: { finish: "stop" } } }];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stub.calls.skill, 0);
    assert.equal(stub.calls.agentList, 0);
    assert.equal(stub.calls.agentSwitch, 0);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── 4. Transient-empty-registry poll ────────────────────────────────────────────────────────────
test("verifySkillsPresent polls past a transiently empty GET /api/skill rather than failing closed immediately", async () => {
  const stub = await startStub({ skills: [SKILL_A], skillsReadyAfter: 2 }); // empty on calls 1-2, populated from call 3
  try {
    const res = await verifySkillsPresent(stub.baseURL, { skillNames: ["node-esm-live"], timeoutMs: 2000, pollMs: 20 });
    assert.equal(res.present, true);
    assert.ok(stub.calls.skill >= 3, "must have polled past the empty responses");
  } finally {
    await stub.close();
  }
});

test("verifyAgentPresent polls past a transiently empty GET /api/agent rather than failing closed immediately", async () => {
  const stub = await startStub({ agents: [AGENT_BUILD], agentsReadyAfter: 2 });
  try {
    const res = await verifyAgentPresent(stub.baseURL, { agentId: "build", timeoutMs: 2000, pollMs: 20 });
    assert.equal(res.present, true);
    assert.ok(stub.calls.agentList >= 3, "must have polled past the empty responses");
  } finally {
    await stub.close();
  }
});

test("resolveRoutingDirectives itself tolerates the same transient-empty-registry warmup before resolving", async () => {
  const stub = await startStub({ skills: [SKILL_A], skillsReadyAfter: 2, agents: [AGENT_BUILD], agentsReadyAfter: 1 });
  try {
    const res = await resolveRoutingDirectives(stub.baseURL, { skills: ["node-esm-live"], agentSlot: "build" },
      { timeoutMs: 2000, pollMs: 20 });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.agentId, "build");
  } finally {
    await stub.close();
  }
});

// ── 5. Context monitoring + compaction ─────────────────────────────────────────────────────────
test("computeContextUsage reads the LAST assistant message's tokens (input+cache), not a sum across the turn", () => {
  const data = [assistantMsg({ input: 900, cacheRead: 0 }), assistantMsg({ input: 20, cacheRead: 890 })];
  const usage = computeContextUsage(data, 1000);
  assert.equal(usage.used, 910); // last message's 20 + 890, NOT the sum of both messages' inputs
  assert.equal(usage.limit, 1000);
  assert.equal(usage.ratio, 0.91);
});

test("context usage crossing the threshold triggers POST /compact and is recorded as a localized planner-defect signal", async () => {
  // Pre-run check (call 0) sees low usage; the first step.ended event schedules a second check
  // (call 1) that crosses the 0.8 threshold — genuinely "while running", not just a single snapshot.
  const contextSequence = [[assistantMsg({ input: 100 })], [assistantMsg({ input: 900 })]];
  const eventScript = [
    { evt: { type: "session.next.step.ended", data: { finish: "tool-calls" } } },
    { delayMs: 30, evt: { type: "session.next.step.ended", data: { finish: "stop" } } },
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, contextSequence, compactStatus: 204 });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, contextCompactThreshold: 0.8,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(stub.calls.compact >= 1, "threshold crossing must call POST /compact");
    assert.ok(result.compactions.length >= 1, "a triggered check must be recorded on the result");
    const rec = result.compactions[0];
    assert.equal(rec.compacted, true);
    assert.ok(rec.defect && rec.defect.reason, "compaction must be recorded as a defect, never silently");
    const expected = t("en", "opencode.context.compacted").replace("{pct}", String(Math.round(rec.usage.ratio * 100)));
    assert.equal(rec.defect.reason, expected);
    assert.match(result.log, /context defects \(planner\)/, "the defect must be surfaced in the run log");
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("compaction is still recorded as a planner defect when the server reports it unavailable (verified live: reproducibly 503s)", async () => {
  const contextSequence = [[assistantMsg({ input: 950 })]];
  const eventScript = [{ evt: { type: "session.next.step.ended", data: { finish: "stop" } } }];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, contextSequence, compactStatus: 503 });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, contextCompactThreshold: 0.8,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.compactions.length >= 1);
    const rec = result.compactions[0];
    assert.equal(rec.compacted, false);
    assert.equal(rec.status, 503);
    assert.ok(rec.defect && rec.defect.reason, "a 503 from /compact must STILL be recorded as a defect — never swallowed");
    assert.match(rec.defect.reason, /503/);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("context usage below the threshold never calls POST /compact", async () => {
  const contextSequence = [[assistantMsg({ input: 100 })], [assistantMsg({ input: 150 })]];
  const eventScript = [
    { evt: { type: "session.next.step.ended", data: { finish: "tool-calls" } } },
    { delayMs: 30, evt: { type: "session.next.step.ended", data: { finish: "stop" } } },
  ];
  const stub = await startStub({ catalog: [CATALOG_ENTRY], eventScript, contextSequence });
  const ws = makeGitWorkspace();
  writeFileSync(join(ws, "out.txt"), "x\n");
  try {
    const result = await runSessionAgainstServer({
      baseURL: stub.baseURL, workspace: ws, providerID: MODEL.providerID, modelID: MODEL.id,
      prompt: "go", timeoutMs: 5000, modelCatalogTimeoutMs: 2000, contextCompactThreshold: 0.8,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stub.calls.compact, 0, "usage below threshold must never call POST /compact");
    assert.equal(result.compactions.length, 0);
    assert.doesNotMatch(result.log, /context defects/);
  } finally {
    await stub.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("checkContextAndCompact returns null (no check) when the model's context limit is unknown", async () => {
  const stub = await startStub({});
  try {
    const rec = await checkContextAndCompact(stub.baseURL, "ses_x", { contextLimit: null });
    assert.equal(rec, null);
    assert.equal(stub.calls.context, 0, "no contextLimit means no context read at all");
  } finally {
    await stub.close();
  }
});

// ── i18n parity for the new keys ────────────────────────────────────────────────────────────────
test("the new opencode.* i18n keys are present and parity-complete across en/fr/de", () => {
  for (const key of ["opencode.directive.unknownSkill", "opencode.directive.unknownAgent",
    "opencode.context.compacted", "opencode.context.compactUnavailable"]) {
    for (const loc of LOCALES) assert.notEqual(t(loc, key), key, `${loc}/${key} must not fall back to the raw key`);
  }
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
});

// ── switchAgent contract ───────────────────────────────────────────────────────────────────────
test("switchAgent posts {agent} and requires 204", async () => {
  const stub = await startStub({});
  try {
    await switchAgent(stub.baseURL, "ses_x", "build");
    assert.equal(stub.calls.agentSwitch, 1);
  } finally {
    await stub.close();
  }
});
