#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — minimal web experience (2026-07-27).
// Zero-dep Node http server + single-page dashboard. Backed by the persistence store (M3) and the
// engine (routing/onboarding/adapters). Runs REAL local-model executions via the OpenAI-compatible
// chat adapter (local). Shows prominently: runs on your own models, provider/model, cost
// source, active agent+department, execution graph, status, logs, files/artifacts, tokens,
// approvals. No decorative agent-to-agent chatter.
import http from "node:http";
import { request as httpReq } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { routeTask, makeCatalog, costReport, executionSummary } from "./ce-core.mjs";
import { executePlan, runNode } from "./adapters.mjs";
import { runOpenCode } from "./opencode-adapter.mjs";
import { DEPARTMENT_TEMPLATES } from "./departments.mjs";
import { detectConnections, generateOrg, recommendAssignments, applyOverrides, confirmZeroFunded, renderAgentView } from "./onboarding.mjs";
import { runtimeCards, runtimeConnection, runtimeToConnection } from "./runtimes.mjs";
import { applyAdvancedAgentConfig } from "./onboarding.mjs";
import { newConversation, addMessage, pin, resolveMention, rollSummary, compactContext, draftMissionSpec,
  editMissionSpec, approveMission, rejectMission, modeAllows, missionComposer, reviewMission, saveAsWorkflow } from "./chat.mjs";
import { connectRagSource, indexDocuments, searchRag } from "./rag.mjs";
import { efficiencyReport } from "./efficiency.mjs";
import { selectModel } from "./ce-core.mjs";

const PORT = Number(process.env.BO_CE_WEB_PORT || 4177);
const store = new Store();

// ── server-side model detection (user LOCAL only; never a BrainOutput account) ────────────────
function probe(host, port, path) {
  return new Promise((res) => { const r = httpReq({ host, port, path, timeout: 2500 }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res(d)); }); r.on("error", () => res("")); r.on("timeout", () => { r.destroy(); res(""); }); r.end(); });
}
async function detectLocal() {
  const models = [];
  // ollama on localhost (the default local model server)
  try { const t = JSON.parse(await probe("127.0.0.1", 11434, "/api/tags")); for (const m of t.models || []) models.push({ name: m.name, provider: "ollama", endpoint: "http://127.0.0.1:11434/v1/chat/completions", contextSize: /32k/.test(m.name) ? 32000 : 8192 }); } catch {}
  // any additional OpenAI-compatible endpoints you own (e.g. a local GPU gateway, vLLM), set via
  // BO_CE_LOCAL_ENDPOINTS="host:port,host:port". Each is probed at /v1/models; all local/$0.
  for (const ep of (process.env.BO_CE_LOCAL_ENDPOINTS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [host, port] = ep.split(":");
    try { const g = JSON.parse(await probe(host, Number(port) || 80, "/v1/models")); for (const m of (g.data || [])) models.push({ name: m.id, provider: host.replace(/[^a-zA-Z0-9]+/g, "-"), endpoint: `http://${ep}/v1/chat/completions`, contextSize: 32000 }); } catch {}
  }
  return models;
}
const catalog = makeCatalog([]);
const ctx = () => ({ agents: store.def.agents, assignments: store.def.modelAssignments, connections: store.def.modelConnections, catalog, departments: DEPARTMENT_TEMPLATES });
// History-bounded store: ids must NOT derive from collection lengths (they shrink on trim).
let uidCounter = 0;
const uid = (p) => `${p}-${Date.now().toString(36)}-${(uidCounter += 1)}`;

async function body(req) { return new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } }); }); }
const json = (res, obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

async function api(req, res, url) {
  if (url.pathname === "/api/state") return json(res, publicState());
  if (url.pathname === "/api/detect") return json(res, { detected: await detectLocal() });
  if (url.pathname === "/api/runtimes") {
    const connected = new Set((store.def.modelConnections || []).map((c) => c.runtime).filter(Boolean));
    return json(res, { cards: runtimeCards().map((c) => ({ ...c, connected: connected.has(c.runtime) })) });
  }
  const b = await body(req);
  if (url.pathname === "/api/connect-runtime") {
    try {
      const rec = runtimeConnection({ runtime: b.runtime, authSource: b.authSource, provider: b.provider, model: b.model, endpoint: b.endpoint, modelLocation: b.modelLocation });
      const conn = runtimeToConnection(rec, { id: uid("runtime"), endpoint: b.endpoint, apiKeyEnv: b.apiKeyEnv });
      store.setConnections([...(store.def.modelConnections || []), conn]).saveDefinition();
      return json(res, publicState());
    } catch (e) { return json(res, { error: e.message }, 400); }
  }
  if (url.pathname === "/api/onboard") {
    const { connections } = detectConnections({ localModels: await detectLocal(), byokKeys: {} });
    const agents = generateOrg({ companyDoes: b.companyDoes, departments: b.departments || [] });
    const rec = recommendAssignments(agents, connections);
    store.setCompany({ name: b.companyDoes || "My Company" }).setDepartments(b.departments || []).setAgents(agents).setConnections(connections).setAssignments(rec.assignments).save();
    return json(res, { ...publicState(), recommendation: rec });
  }
  if (url.pathname === "/api/assign") {
    try { const a = applyOverrides(store.def.modelAssignments, { [b.slot]: b.connectionId || null }, store.def.modelConnections); store.setAssignments(a).saveDefinition(); return json(res, publicState()); }
    catch (e) { return json(res, { error: e.message }, 400); }
  }
  if (url.pathname === "/api/task") return runTask(res, b);
  if (url.pathname.startsWith("/api/execution/")) { const e = store.runtime.executions.find((x) => x.id === url.pathname.split("/").pop()); return e ? json(res, e) : json(res, { error: "not found" }, 404); }
  if (url.pathname === "/api/approval") { const ap = store.runtime.approvals.find((x) => x.id === b.id); if (ap) { ap.status = b.decision || "approved"; store.saveRuntime(); } return json(res, publicState()); }
  if (url.pathname === "/api/settings") {
    store.setSettings({ mode: b.mode === "advanced" ? "advanced" : "regular" }).saveDefinition();
    return json(res, publicState());
  }
  if (url.pathname === "/api/agent-advanced") {
    const agents = store.def.agents || [];
    const i = agents.findIndex((a) => a.id === b.agentId);
    if (i < 0) return json(res, { error: "agent not found" }, 404);
    // Per-stage overrides reference the user's OWN connections by id; validation happens at routing
    // time (applyStageOverrides) and is fail-closed on anything not user/free/local.
    const stages = {};
    for (const k of ["conversation", "planner", "worker", "reviewer"]) if (b.stages?.[k]) stages[k] = b.stages[k];
    try {
      agents[i] = applyAdvancedAgentConfig(agents[i], {
        stages, fallbacks: b.fallbacks || null, contextLimits: b.contextLimits ?? null,
        reasoning: b.reasoning || null, privacy: b.privacy || "internal", costLimit: b.costLimit ?? null,
        ...(b.permissions ? { permissions: b.permissions } : {}), ...(b.approvals ? { approvals: b.approvals } : {}),
      });
      store.setAgents(agents).saveDefinition();
      return json(res, publicState());
    } catch (e) { return json(res, { error: e.message }, 400); }
  }
  if (url.pathname === "/api/chat/send") return chatSend(res, b);
  if (url.pathname === "/api/chat/mission") return chatMission(res, b);
  if (url.pathname === "/api/chat/launch") return chatLaunch(res, b);
  return json(res, { error: "unknown endpoint" }, 404);
}

// ── Command Center ──────────────────────────────────────────────────────────────────────────────
// Company knowledge as a READ-ONLY RAG source, built from the user's own company definition.
function knowledgeSource() {
  const docs = [
    { id: "company", resource: "company", text: `Company ${store.def.company?.name || "(unnamed)"}. Departments: ${(store.def.departments || []).join(", ")}.` },
    ...(store.def.agents || []).map((a) => ({ id: a.id, resource: `agent/${a.id}`,
      text: `Agent ${a.id} is the ${a.role} in ${a.department}. Objectives: ${(a.objectives || []).join("; ")}. Tools: ${(a.tools || []).join(", ")}. Permissions: ${(a.permissions || []).join(", ")}. Approvals: ${Object.keys(a.approvalThresholds || {}).join(", ") || "none"}. Activation: ${a.activation}.` })),
  ];
  return indexDocuments(connectRagSource({ id: "company-knowledge", label: "Company knowledge", resources: ["company"] }), docs, { now: Date.now() });
}

/** Resolve the conversation model for a scope — the agent's own model, else a light company default. */
function chatModelFor({ department = null, agentId = null } = {}) {
  const agents = store.def.agents || [];
  const agent = agentId ? agents.find((a) => a.id === agentId)
    : department ? agents.find((a) => a.department === department) : agents[0];
  const caps = agent?.capabilities || {};
  // ADVANCED: an explicit conversation-model override wins over the agent's slot default.
  const ov = agent?.stageRuntimes?.conversation;
  if (ov) {
    const conn = typeof ov === "string" ? (store.def.modelConnections || []).find((c) => c.id === ov) : ov;
    if (conn) return { agent: agent.id, slot: "conversation", connection: conn, provider: conn.provider, model: conn.model, costSource: conn.costSource, funder: conn.funder };
  }
  const slot = caps.worker || caps.planner || "fast-cheap";
  try { return { agent: agent?.id || null, ...selectModel(slot, { assignments: store.def.modelAssignments, connections: store.def.modelConnections, catalog }) }; }
  catch { return { agent: agent?.id || null, slot, needsConfiguration: true }; }
}

function getConversation(id) { return (store.runtime.conversations || []).find((c) => c.id === id) || null; }
function saveConversation(c) { store.addConversation({ ...c, updatedAt: Date.now() }); store.saveRuntime(); return c; }

async function chatSend(res, b) {
  let conv = b.conversationId ? getConversation(b.conversationId) : null;
  if (!conv) conv = newConversation({ scope: b.scope || "company", department: b.department || null, agentId: b.agentId || null });
  const mode = b.mode || "ask";
  // An @mention retargets to that agent for this conversation.
  const mentioned = resolveMention(b.text || "", store.def.agents || []);
  if (mentioned) { conv = { ...conv, scope: "agent", agentId: mentioned.id, department: mentioned.department }; }
  conv = addMessage(conv, { role: "user", text: b.text || "", mode, at: Date.now() });

  const model = chatModelFor(conv);
  let reply = null, mission = null, rag = [];

  if (mode === "ask") {
    // READ-ONLY: retrieve from company knowledge, then answer with the conversation model if available.
    rag = searchRag([knowledgeSource()], b.text || "", { agent: { id: conv.agentId, department: conv.department }, topK: 3 });
    const ctx = compactContext(conv, { query: b.text || "", k: 3 });
    if (model.connection && !model.needsConfiguration) {
      const prompt = `Answer the question using ONLY the context. Be brief.\n\nContext:\n${rag.map((r) => `- ${r.text} (${r.citation})`).join("\n") || "(no matching company knowledge)"}\n\nPinned constraints: ${ctx.pinned.map((p) => p.text).join("; ") || "none"}\n\nQuestion: ${b.text}`;
      try {
        const r = await runNode({ node: "chat", slot: model.slot }, model, { prompt }, { maxTokens: 300 });
        reply = r.output || null;
      } catch (e) { reply = null; }
    }
    if (!reply) reply = rag.length
      ? `From your company knowledge:\n${rag.map((r) => `• ${r.text}  [${r.citation}]`).join("\n")}`
      : "No matching company knowledge, and no conversation model is configured — connect a free/local/BYOK model or ask about your departments and agents.";
  } else if (mode === "plan") {
    const gate = modeAllows(mode, "draft-plan");
    if (!gate.allowed) return json(res, { error: gate.reason }, 400);
    const agent = conv.agentId ? (store.def.agents || []).find((a) => a.id === conv.agentId) : null;
    const dept = conv.department || agent?.department || (store.def.departments || [])[0] || null;
    mission = draftMissionSpec(conv, {
      department: dept,
      agents: agent ? [agent.id] : (store.def.agents || []).filter((a) => a.department === dept).map((a) => a.id).slice(0, 1),
      tools: agent?.tools || [], permissions: agent?.permissions || [], approvals: agent?.approvalThresholds || {},
      policies: store.def.policies || {}, complexity: b.complex ? "high" : null, risk: b.risk || null,
    });
    store.addMission(mission);
    conv = { ...conv, missionId: mission.id };
    reply = `Drafted a mission for ${mission.department}. Review it below — edit anything, then approve to launch.`;
  } else if (mode === "review") {
    const m = (store.runtime.missions || []).find((x) => x.id === (b.missionId || conv.missionId));
    const exec = (store.runtime.executions || []).filter((e) => e.missionId === m?.id).at(-1);
    const rev = m ? reviewMission(m, exec?.results || []) : null;
    reply = rev ? (rev.allMet ? "All acceptance criteria are met." :
      `Unmet criteria: ${rev.unmet.join("; ")}${rev.independentReviewJustified ? " — an independent reviewer is justified." : ""}`)
      : "No mission to review yet.";
  } else {
    reply = "Switch to Execute mode and approve the mission below to launch it.";
  }

  conv = addMessage(conv, { role: "assistant", text: reply, mode, at: Date.now(),
    meta: { model: model.model || null, provider: model.provider || null, costSource: model.costSource || null, citations: rag.map((r) => r.citation) } });
  conv = rollSummary(conv, { every: 10, keepTail: 4 });
  saveConversation(conv);
  return json(res, { conversation: conv, mission: mission || (conv.missionId ? (store.runtime.missions || []).find((m) => m.id === conv.missionId) : null),
    composer: mission ? missionComposer(mission) : null, model, citations: rag.map((r) => r.citation) });
}

function chatMission(res, b) {
  const missions = store.runtime.missions || [];
  let m = missions.find((x) => x.id === b.missionId);
  if (!m) return json(res, { error: "mission not found" }, 404);
  try {
    if (b.action === "edit") m = editMissionSpec(m, b.patch || {});
    else if (b.action === "approve") m = approveMission(m);
    else if (b.action === "reject" || b.action === "cancel") m = rejectMission(m, { reason: b.reason || null });
    else if (b.action === "save-workflow") {
      const wf = saveAsWorkflow(m, { name: b.name });
      store.addProject({ id: `wf-${Date.now().toString(36)}`, kind: "workflow", ...wf });
      store.saveRuntime();
      return json(res, { mission: m, workflowSaved: true, composer: missionComposer(m) });
    } else return json(res, { error: `unknown action '${b.action}'` }, 400);
  } catch (e) { return json(res, { error: e.message }, 400); }
  store.addMission(m); store.saveRuntime();
  return json(res, { mission: m, composer: missionComposer(m) });
}

/** Execute an APPROVED mission through the existing direct executor — no management relay. */
async function chatLaunch(res, b) {
  const m = (store.runtime.missions || []).find((x) => x.id === b.missionId);
  if (!m) return json(res, { error: "mission not found" }, 404);
  const gate = modeAllows("execute", "execute", { mission: m });
  if (!gate.allowed) return json(res, { error: gate.reason }, 400);

  const r = routeTask({ department: m.department, task: { ...m.task, summary: m.objective } }, ctx());
  if (!r.ok) return json(res, { error: r.reason }, 400);
  store.addMission({ ...m, status: "running" });
  // The executor receives the compact mission context — never the transcript.
  const conv = getConversation(m.conversationId);
  const cc = conv ? compactContext(conv, { query: m.objective, k: 3 }) : { pinned: [], relevant: [] };
  const prompt = `${m.objective}\n\nConstraints: ${(m.constraints || []).join("; ") || "none"}\nAcceptance: ${(m.acceptanceCriteria || []).join("; ") || "none"}`;
  let results = [];
  try { results = await executePlan(r.plan, { _all: { prompt } }, { maxTokens: 400, boundPolicies: r.boundPolicies, task: m.task, timeoutMs: b.timeoutMs || 120000 }); }
  catch (e) {
    // A failed run must never leave a mission stuck mid-flight: record the failure, say so in the
    // conversation, and put the mission back to APPROVED so the user can retry or edit and re-approve.
    const failed = { ...m, status: "approved", lastError: String(e.message || e) };
    store.addMission(failed);
    const cf = getConversation(m.conversationId);
    if (cf) saveConversation(addMessage(cf, { role: "assistant", mode: "execute", at: Date.now(),
      text: `Mission did not run: ${e.message}. Nothing was changed. Check the model connection (Connections tab) and launch again.` }));
    store.saveRuntime();
    return json(res, { error: `execution failed: ${e.message}`, mission: failed }, 500);
  }

  const rep = costReport(results);
  const eff = efficiencyReport({ plan: r.plan, results, shape: r.shape });
  const exec = store.addExecution({ id: uid("exec"), missionId: m.id, conversationId: m.conversationId, department: r.department,
    agent: r.agent, shape: r.shape, graph: r.plan.map((n) => ({ node: n.node, model: n.model?.model || null, provider: n.model?.provider || null,
      costSource: n.model?.costSource || null, needsConfiguration: !!n.model?.needsConfiguration })),
    results, costBySource: rep.byCostSource, efficiency: eff, status: "done", createdAt: Date.now() });
  const done = { ...m, status: "done", artifacts: eff.artifacts };
  store.addMission(done);

  const review = reviewMission(done, results);
  let c2 = conv ? addMessage(conv, { role: "assistant", mode: "execute", at: Date.now(),
    text: `Mission complete — graph ${eff.graph}${eff.stagesSkipped.length ? `, skipped ${eff.stagesSkipped.join(", ")}` : ""}. ${review.allMet ? "Acceptance criteria met." : review.unmet.length ? `Unmet: ${review.unmet.join("; ")}` : ""}`,
    meta: { executionId: exec.id, efficiency: eff } }) : null;
  if (c2) saveConversation(c2);
  store.saveRuntime();
  return json(res, { mission: done, execution: exec, efficiency: eff, review, conversation: c2 || null });
}

function publicState() {
  const funded = store.runtime.executions.reduce((s, e) => s + (e.brainoutputFundedTokens || 0), 0);
  return { company: store.def.company, settings: store.def.settings || { mode: "regular" }, departments: store.def.departments, agents: store.def.agents,
    connections: store.def.modelConnections, assignments: store.def.modelAssignments,
    agentViews: store.def.agents.map((a) => renderAgentView(a, store.def.modelAssignments, store.def.modelConnections)),
    tasks: store.runtime.tasks, executions: store.runtime.executions, approvals: store.runtime.approvals,
    conversations: store.runtime.conversations || [], missions: store.runtime.missions || [],
    brainoutputFundedTokens: funded };
}

async function runTask(res, b) {
  const r = routeTask({ department: b.department, role: b.role, task: { complexity: b.complex ? "high" : "low", decompose: !!b.complex, workerSlot: b.workerSlot, requireReview: !!b.review, requiresHumanApproval: !!b.approval, mutatesRealWorld: !!b.approval } }, ctx());
  if (!r.ok) return json(res, { error: r.reason }, 400);
  const task = store.addTask({ id: uid("task"), objective: b.objective, department: r.department, agent: r.agent, status: "running", createdAt: null });
  const inputs = { _all: { prompt: b.objective } };
  const codeWs = join(store.dir, "workspaces", task.id);
  const results = [];
  // Per node: a CODING worker runs through REAL OpenCode (produces actual files in an isolated
  // workspace); everything else runs on the OpenAI-compatible chat adapter. Both run locally.
  for (const node of r.plan) {
    const isCoding = typeof node.slot === "string" && node.slot.startsWith("coding") && node.model?.connection && !b.dry;
    if (isCoding) {
      try {
        const oc = await runOpenCode({ connection: node.model.connection, workspace: codeWs, timeoutMs: 240000,
          approvedRoots: [join(store.dir, "workspaces")],
          prompt: `${b.objective} Use the write tool to create the file(s) with RELATIVE paths in the current directory, then stop.` });
        const files = (oc.changedFiles || []).map((f) => { try { return { name: f, content: readFileSync(join(codeWs, f), "utf8").slice(0, 4000) }; } catch { return { name: f, content: "" }; } });
        results.push({ node: node.node, executor: "opencode", model: oc.model, provider: oc.provider, costSource: oc.costSource, funder: oc.funder,
          tokens: oc.tokens, changedFiles: oc.changedFiles, files, founderCredentialUsed: oc.founderCredentialUsed,
          artifact: oc.changedFiles?.length ? `opencode:${oc.changedFiles.join(",")}` : null,
          output: oc.founderCredentialUsed ? "✗ founder credential detected" : oc.changedFiles?.length ? `wrote ${oc.changedFiles.join(", ")}` : "(no files produced — try a stronger local/BYOK coding model)" });
      } catch (e) { results.push({ node: node.node, executor: "opencode", error: e.message, tokens: 0 }); }
    } else {
      results.push(await runNode(node, node.model, inputs[node.node] || inputs._all || {}, { dryRun: !!b.dry, maxTokens: 180 }));
    }
  }
  const rep = costReport(results);
  const summary = executionSummary(results);
  // record any human-approval gate as a pending approval
  for (const n of r.plan) if (n.gate) store.addApproval({ id: uid("appr"), taskId: task.id, kind: "action", status: "pending" });
  const exec = store.addExecution({ id: uid("exec"), taskId: task.id, agent: r.agent, department: r.department, shape: r.shape,
    graph: r.plan.map((n) => ({ node: n.node, slot: n.slot, model: n.model?.model || null, provider: n.model?.provider || null, costSource: n.model?.costSource || (n.tool ? "deterministic" : n.gate ? "human-approval" : null), needsConfiguration: !!n.model?.needsConfiguration })),
    results: rep.nodes, logs: results.map((x) => `${x.node}: ${x.output ? String(x.output).slice(0, 400) : x.needsConfiguration ? "UNCONFIGURED → offer free/BYOK/local/stop" : x.gate ? "human approval required" : x.deterministic ? JSON.stringify(x.output) : ""}`),
    artifacts: rep.nodes.filter((n) => n.artifact).map((n) => n.artifact),
    codeFiles: results.flatMap((x) => (x.files || []).map((f) => ({ node: x.node, name: f.name, content: f.content }))),
    executorByNode: Object.fromEntries(results.map((x) => [x.node, x.executor || "chat"])),
    costBySource: rep.byCostSource, brainoutputFundedTokens: rep.brainoutputFundedTokens, summary, status: "done" });
  task.status = "done"; store.save();
  return json(res, { execution: exec, brainoutputFundedTokens: rep.brainoutputFundedTokens });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) { try { await api(req, res, url); } catch (e) { json(res, { error: String(e.message || e) }, 500); } return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE);
});
server.listen(PORT, "127.0.0.1", () => console.log(`BrainOutput Community dashboard → http://127.0.0.1:${PORT}`));

// ── single-page dashboard (inline, zero-dep) ────────────────────────────────────────────────────
const PAGE = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>BrainOutput Community</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--fg:#e6e9ef;--mut:#8b93a7;--acc:#4ea1ff;--ok:#3ddc84;--warn:#ffb454;--line:#252a35}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line);background:#12141a;position:sticky;top:0;z-index:5}
header h1{font-size:16px;margin:0}.zero{margin-left:auto;background:#10331f;color:var(--ok);border:1px solid #1c5c36;padding:4px 12px;border-radius:20px;font-weight:600;font-size:13px}
nav{display:flex;gap:4px;padding:8px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}nav button{background:none;border:1px solid transparent;color:var(--mut);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px}
nav button.on{color:var(--fg);background:var(--card);border-color:var(--line)}main{padding:20px;max-width:1000px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.card h2{margin:0 0 12px;font-size:14px;color:var(--acc)}.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}
input,select,textarea{background:#0f1319;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:8px;width:100%;font:inherit}
button.act{background:var(--acc);color:#04121f;border:none;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
.pill{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;border:1px solid var(--line)}.pill.local{color:var(--ok);border-color:#1c5c36}.pill.dormant{color:var(--mut)}
.graph{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.node{background:#0f1319;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px}.arrow{color:var(--mut)}
pre{background:#0b0d11;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}
label{display:block;margin:8px 0 4px;color:var(--mut);font-size:12px}.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:180px}
</style></head><body>
<header><h1>🏢 BrainOutput Community</h1><span class=mut id=coname></span><span class=zero id=zero>Your models · your keys</span></header>
<nav id=nav></nav><main id=view></main>
<script>
const S={state:null,tab:'chat',chat:{scope:'company',dept:'',agent:'',mode:'ask',convId:null,mission:null,busy:false}};
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild};
async function api(p,body){const r=await fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return r.json()}
async function refresh(){S.state=await api('/api/state');render()}
const TABS=[['chat','💬 Chat'],['dashboard','Dashboard'],['connections','1 · Connections'],['company','2 · Company'],['org','3 · Organization'],['assign','4 · Assignments'],['task','6 · New Objective'],['exec','7 · Executions'],['advanced','⚙ Advanced']];
function nav(){const n=document.getElementById('nav');n.innerHTML='';const adv=(S.state&&S.state.settings&&S.state.settings.mode)==='advanced';
 TABS.forEach(([k,l])=>{if(k==='advanced'&&!adv)return;const b=el('<button>'+l+'</button>');if(k===S.tab)b.className='on';b.onclick=()=>{S.tab=k;render()};n.appendChild(b)});
 const sw=el('<button title="Regular: one model per agent. Advanced: per-stage models, budgets, privacy, limits.">'+(adv?'⚙ Advanced mode':'Regular mode')+'</button>');
 sw.style.marginLeft='auto';sw.onclick=async()=>{await api('/api/settings',{mode:adv?'regular':'advanced'});if(adv&&S.tab==='advanced')S.tab='chat';await refresh();render()};n.appendChild(sw)}
function fmtCost(c){return c==='local-compute'?'your local compute':c==='free'?'free':c==='user-subscription'?'your subscription':c==='user-api-account'?'your API account':c||'-'}
function bindActions(root){root.querySelectorAll('[data-approve]').forEach(b=>{b.onclick=()=>approve(b.dataset.approve)});root.querySelectorAll('[data-act]').forEach(b=>{b.onclick=()=>missionAct(b.dataset.mid,b.dataset.act)})}
function render(){nav();const s=S.state||{};document.getElementById('coname').textContent=s.company?.name?('· '+s.company.name):'';document.getElementById('zero').textContent=(s.brainoutputFundedTokens?('⚠ '+s.brainoutputFundedTokens+' unexpected paid tokens'):'Your models · your keys');
const v=document.getElementById('view');v.innerHTML='';const view=VIEWS[S.tab](s);v.appendChild(view);bindActions(v)}
const VIEWS={
 dashboard:(s)=>el('<div><div class=card><h2>Company dashboard</h2><div class=row><div><b>'+(s.company?.name||'(no company yet)')+'</b><div class=mut>Runs on <span class=ok>your own models</span></div></div><div class=mut>Departments: '+(s.departments||[]).join(', ')+'<br>Agents: '+((s.agents||[]).length)+' (dormant by default)</div></div></div>'+
  '<div class=card><h2>Agents</h2><table><tr><th>Agent</th><th>Dept/Role</th><th>Models (slot → provider)</th><th>Status</th></tr>'+(s.agentViews||[]).map(a=>'<tr><td>'+a.id+'</td><td>'+a.department+'/'+a.role+'</td><td>'+Object.entries(a.models).map(([k,m])=>'<div><span class=mut>'+k+':</span> '+m+'</div>').join('')+'</td><td><span class="pill dormant">'+a.activation+'</span></td></tr>').join('')+'</table></div>'+
  '<div class=card><h2>Recent executions</h2>'+((s.executions||[]).slice(-5).reverse().map(e=>'<div class=node style="display:block;margin-bottom:6px">'+e.department+' · '+e.shape+' · '+e.graph.map(g=>g.model?(g.provider+'/'+g.model):g.needsConfiguration?'UNCONFIGURED':g.costSource).join(' → ')+' · <span class=mut>'+(e.summary?e.summary.tokens+' tok':'')+'</span></div>').join('')||'<span class=mut>none yet</span>')+'</div></div>'),
 advanced:(s)=>{const agents=s.agents||[];const conns=s.connections||[];
  const A=S.adv||(S.adv={agentId:(agents[0]||{}).id||''});
  const a=agents.find(x=>x.id===A.agentId)||agents[0];
  const opt=(sel)=>'<option value="">— use the slot default —</option>'+conns.map(c=>'<option value="'+c.id+'" '+(sel===c.id?'selected':'')+'>'+c.provider+'/'+c.model+' · '+(c.costSource||'')+'</option>').join('');
  const st=(a&&a.stageRuntimes)||{},adv=(a&&a.advanced)||{};
  const d=el('<div><div class=card><h2>⚙ Advanced — per-agent configuration</h2>'
   +'<div class=mut>Give each execution stage its own model, runtime and provider. Set context budgets, privacy, cost limits and approval rules. Regular mode keeps one default model per agent and picks the smallest sufficient graph automatically.</div>'
   +'<label style="margin-top:10px">Agent</label><select id=ag>'+agents.map(x=>'<option value="'+x.id+'" '+(a&&x.id===a.id?'selected':'')+'>'+x.id+' ('+x.department+'/'+x.role+')</option>').join('')+'</select>'
   +(a?'<div class=row style="margin-top:12px">'
     +'<div><label>Conversation model</label><select id=s_conversation>'+opt(st.conversation)+'</select></div>'
     +'<div><label>Planner model</label><select id=s_planner>'+opt(st.planner)+'</select></div></div>'
     +'<div class=row><div><label>Worker model</label><select id=s_worker>'+opt(st.worker)+'</select></div>'
     +'<div><label>Reviewer model</label><select id=s_reviewer>'+opt(st.reviewer)+'</select></div></div>'
     +'<div class=row style="margin-top:8px">'
      +'<div><label>Fallbacks (ordered, never a paid auto-fallback)</label><select id=fb multiple size=3>'+conns.map(c=>'<option value="'+c.id+'" '+((adv.fallbacks||[]).includes(c.id)?'selected':'')+'>'+c.provider+'/'+c.model+'</option>').join('')+'</select></div>'
      +'<div><label>Context budget (tokens)</label><input id=cb type=number value="'+(adv.contextLimits||'')+'" placeholder="e.g. 32000">'
        +'<label>Cost limit (per run, your own spend)</label><input id=cl type=number value="'+(adv.costLimit??'')+'" placeholder="optional"></div>'
      +'<div><label>Privacy classification</label><select id=pv>'+['public','internal','confidential','restricted'].map(p=>'<option '+((adv.privacy||'internal')===p?'selected':'')+'>'+p+'</option>').join('')+'</select>'
        +'<label>Reasoning</label><select id=rs>'+['','low','medium','high'].map(r=>'<option value="'+r+'" '+((adv.reasoning||'')===r?'selected':'')+'>'+(r||'default')+'</option>').join('')+'</select></div>'
     +'</div>'
     +'<div class=row style="margin-top:8px"><div><label>Approval required for (comma-separated actions)</label><input id=ap value="'+Object.keys(a.approvalThresholds||{}).join(', ')+'" placeholder="publish, payment, deploy"></div>'
      +'<div><label>Permissions</label><input id=pm value="'+(a.permissions||[]).join(', ')+'"></div></div>'
     +'<div class=warn style="margin-top:8px;font-size:12px">Privacy <b>confidential</b> or <b>restricted</b> means every stage must run on a LOCAL model — a cloud model is never silently used; the stage is left unconfigured instead.</div>'
     +'<button class=act id=save style="margin-top:12px">Save advanced settings</button> <span class=mut id=msg></span>'
   :'<div class=mut>No agents yet — generate an organization first.</div>')+'</div></div>');
  d.querySelector('#ag').onchange=e=>{S.adv.agentId=e.target.value;render()};
  if(a)d.querySelector('#save').onclick=async()=>{
    const g=id=>{const v=d.querySelector('#'+id);return v&&v.value?v.value:null};
    const approvals={};(g('ap')||'').split(',').map(x=>x.trim()).filter(Boolean).forEach(k=>approvals[k]='human');
    const r=await api('/api/agent-advanced',{agentId:a.id,
      stages:{conversation:g('s_conversation'),planner:g('s_planner'),worker:g('s_worker'),reviewer:g('s_reviewer')},
      fallbacks:[...d.querySelectorAll('#fb option:checked')].map(o=>o.value),
      contextLimits:g('cb')?Number(g('cb')):null,costLimit:g('cl')?Number(g('cl')):null,
      privacy:g('pv'),reasoning:g('rs'),
      approvals,permissions:(g('pm')||'').split(',').map(x=>x.trim()).filter(Boolean)});
    if(r.error){alert(r.error);return}
    d.querySelector('#msg').textContent='saved';await refresh();render()};
  return d},
 chat:(s)=>{const C=S.chat;const depts=s.departments||[];const agents=s.agents||[];
  const conv=(s.conversations||[]).find(x=>x.id===C.convId)||(s.conversations||[]).slice(-1)[0]||null;
  if(conv&&!C.convId)C.convId=conv.id;   // restore the latest conversation on load (history persists)
  const mission=C.mission||(conv&&(s.missions||[]).find(m=>m.id===conv.missionId))||null;
  const d=el('<div><div class=card><h2>Command Center</h2>'
   +'<div class=mut>Talk to your company, a department, or one agent. Ask is read-only · Plan drafts an editable mission · Execute launches only after you approve · Review checks the result.</div>'
   +'<div class=row style="margin-top:10px">'
     +'<div><label>Scope</label><select id=sc>'+['company','department','agent'].map(x=>'<option '+(C.scope===x?'selected':'')+'>'+x+'</option>').join('')+'</select></div>'
     +'<div><label>Department</label><select id=dp><option value="">—</option>'+depts.map(x=>'<option '+(C.dept===x?'selected':'')+'>'+x+'</option>').join('')+'</select></div>'
     +'<div><label>Agent</label><select id=ag><option value="">—</option>'+agents.map(a=>'<option value="'+a.id+'" '+(C.agent===a.id?'selected':'')+'>'+a.id+'</option>').join('')+'</select></div>'
     +'<div><label>Mode</label><select id=md>'+['ask','plan','execute','review'].map(x=>'<option '+(C.mode===x?'selected':'')+'>'+x+'</option>').join('')+'</select></div>'
   +'</div>'+(((s.settings||{}).mode==='advanced'&&C.agent)?advSummary((s.agents||[]).find(x=>x.id===C.agent)):'')+'</div>'
   +'<div class=card><div id=tr style="max-height:340px;overflow:auto">'+(conv?conv.messages.map(m=>'<div style="margin-bottom:10px"><b>'+(m.role==='user'?'You':'BrainOutput')+'</b> <span class=mut style="font-size:11px">'+m.mode+(m.meta&&m.meta.model?' · '+m.meta.provider+'/'+m.meta.model+' · '+(m.meta.costSource||''):'')+'</span><div style="white-space:pre-wrap">'+String(m.text).replace(/[&<]/g,c=>c==='&'?'&amp;':'&lt;')+'</div>'+(m.meta&&m.meta.citations&&m.meta.citations.length?'<div class=mut style="font-size:11px">sources: '+m.meta.citations.join(' · ')+'</div>':'')+'</div>').join(''):'<span class=mut>No messages yet — ask something, or switch to Plan to draft a mission.</span>')+'</div>'
   +'<textarea id=msg rows=2 placeholder="e.g. Draft a refund policy reply in Spanish  (use @agent-id to talk to one agent)"></textarea>'
   +'<button class=act id=send style="margin-top:8px">Send</button> <span class=mut id=busy></span></div>'
   +(mission?missionCard(mission):'')+'</div>');
  const set=(k,v)=>{C[k]=v};
  d.querySelector('#sc').onchange=e=>{set('scope',e.target.value);render()};
  d.querySelector('#dp').onchange=e=>{set('dept',e.target.value)};
  d.querySelector('#ag').onchange=e=>{set('agent',e.target.value)};
  d.querySelector('#md').onchange=e=>{set('mode',e.target.value)};
  d.querySelector('#send').onclick=async()=>{const t=d.querySelector('#msg').value.trim();if(!t)return;
    d.querySelector('#busy').textContent='thinking…';
    const r=await api('/api/chat/send',{conversationId:C.convId,scope:C.scope,department:C.dept||null,agentId:C.agent||null,mode:C.mode,text:t});
    if(r.error){alert(r.error);d.querySelector('#busy').textContent='';return}
    C.convId=r.conversation.id;C.mission=r.mission||C.mission;await refresh();render()};
  return d},
 connections:(s)=>{const d=el('<div><div class=card><h2>1 · Model connections (user / free / local only)</h2><div class=mut>No BrainOutput-hosted paid models are ever used. Detected local models below.</div><div id=det class=mut style="margin:8px 0">detecting…</div><table id=ct></table></div><div class=card><h2>Runtimes</h2><div class=mut>Assign a different runtime to any agent or execution stage. &ldquo;Works with&rdquo; &mdash; no partnership or endorsement implied. A local CLI is not a local model.</div><div id=rt style="margin-top:10px">loading&hellip;</div></div></div>');
  api('/api/detect').then(r=>{document.getElementById('det').textContent=r.detected.length?('Detected '+r.detected.length+' local model(s).'):'No local model detected — start ollama or connect a model.'});
  d.querySelector('#ct').innerHTML='<tr><th>Connection</th><th>Provider / Model</th><th>Pays</th></tr>'+(s.connections||[]).map(c=>'<tr><td>'+c.id+'</td><td>'+c.provider+' / '+c.model+'</td><td class=ok>'+fmtCost(c.costSource)+'</td></tr>').join('');
  api('/api/runtimes').then(r=>{document.getElementById('rt').innerHTML=r.cards.map(runtimeCardHtml).join('')});return d},
 company:()=>{const d=el('<div class=card><h2>2 · Company & departments</h2><label>What does your company do?</label><input id=cd placeholder="e.g. a small software product studio"><label>Departments</label><div id=dep></div><button class=act style="margin-top:12px" id=go>Generate organization</button><div id=msg class=mut style="margin-top:8px"></div></div>');
  const deps=['technical','customer-service','finance','sales','marketing','human-resources','legal-compliance','operations','data-research','executive'];
  d.querySelector('#dep').innerHTML=deps.map(x=>'<label style="display:inline-block;margin-right:12px;color:var(--fg)"><input type=checkbox value="'+x+'" '+(['technical','customer-service','finance'].includes(x)?'checked':'')+' style="width:auto"> '+x+'</label>').join('');
  d.querySelector('#go').onclick=async()=>{const departments=[...d.querySelectorAll('#dep input:checked')].map(i=>i.value);d.querySelector('#msg').textContent='generating…';await api('/api/onboard',{companyDoes:d.querySelector('#cd').value,departments});await refresh();S.tab='org';render()};return d},
 org:(s)=>el('<div class=card><h2>3 · Generated organization (dormant)</h2><table><tr><th>Agent</th><th>Department</th><th>Role</th><th>Capability slots</th></tr>'+(s.agents||[]).map(a=>'<tr><td>'+a.id+'</td><td>'+a.department+'</td><td>'+a.role+'</td><td class=mut>'+Object.entries(a.capabilities||{}).map(([r,sl])=>r+'→'+sl).join(', ')+'</td></tr>').join('')+'</table><div class=mut style="margin-top:8px">Roles persist; execution context is created only when work exists.</div></div>'),
 assign:(s)=>{const slots=[...new Set((s.agents||[]).flatMap(a=>Object.values(a.capabilities||{})))];const d=el('<div class=card><h2>4 · Model assignment editor</h2><div class=mut>Every slot maps to a user/free/local model. Change any of them.</div><table id=at></table></div>');
  d.querySelector('#at').innerHTML='<tr><th>Capability slot</th><th>Assigned model</th><th>Pays</th></tr>'+slots.map(sl=>{const cid=s.assignments[sl];const conn=(s.connections||[]).find(c=>c.id===cid);const opts=(s.connections||[]).map(c=>'<option value="'+c.id+'" '+(c.id===cid?'selected':'')+'>'+c.provider+'/'+c.model+'</option>').join('');return '<tr><td>'+sl+'</td><td><select data-slot="'+sl+'"><option value="">— unconfigured —</option>'+opts+'</select></td><td class=ok>'+(conn?fmtCost(conn.costSource):'<span class=warn>offer free/BYOK/local/stop</span>')+'</td></tr>'}).join('');
  d.querySelectorAll('select').forEach(se=>se.onchange=async()=>{await api('/api/assign',{slot:se.dataset.slot,connectionId:se.value});await refresh();S.tab='assign';render()});return d},
 task:(s)=>{const d=el('<div class=card><h2>6 · New objective</h2><label>Department</label><select id=dp>'+(s.departments||[]).map(x=>'<option>'+x+'</option>').join('')+'</select><label>Objective</label><textarea id=ob rows=3 placeholder="e.g. Reply to a customer question in Spanish"></textarea><div class=row><label><input type=checkbox id=cx style="width:auto"> complex (use a planner)</label><label><input type=checkbox id=rv style="width:auto"> require review</label><label><input type=checkbox id=ap style="width:auto"> needs human approval</label></div><button class=act style="margin-top:12px" id=run>Run (local)</button><div id=out style="margin-top:12px"></div></div>');
  d.querySelector('#run').onclick=async()=>{d.querySelector('#out').innerHTML='<span class=mut>routing + running on your local models…</span>';const r=await api('/api/task',{department:d.querySelector('#dp').value,objective:d.querySelector('#ob').value,complex:d.querySelector('#cx').checked,review:d.querySelector('#rv').checked,approval:d.querySelector('#ap').checked});await refresh();if(r.error){d.querySelector('#out').innerHTML='<span class=warn>'+r.error+'</span>';return}S.tab='exec';S.exec=r.execution.id;render()};return d},
 exec:(s)=>{const ex=(s.executions||[]).find(e=>e.id===S.exec)||(s.executions||[]).slice(-1)[0];if(!ex)return el('<div class=card><h2>7 · Executions</h2><span class=mut>No executions yet — submit an objective.</span></div>');
  return el('<div><div class=card><h2>7 · Active execution — '+ex.department+' / '+ex.agent+'</h2><div class=graph>'+ex.graph.map(g=>'<span class=node>'+g.node+(g.model?'<br><span class=mut>'+g.provider+'/'+g.model+'</span>':g.needsConfiguration?'<br><span class=warn>UNCONFIGURED</span>':'<br><span class=mut>'+(g.costSource||'')+'</span>')+'</span>').join('<span class=arrow>→</span>')+'</div><div style="margin-top:10px">status: <span class=ok>'+ex.status+'</span> · graph: '+ex.shape+'</div></div>'+
  '<div class=card><h2>8 · Result — model, cost source, artifacts</h2><table><tr><th>Node</th><th>Provider/Model</th><th>Cost source</th><th>Tokens</th><th>Artifact</th></tr>'+ex.results.map(n=>'<tr><td>'+n.node+'</td><td>'+(n.model?(n.provider+'/'+n.model):'-')+'</td><td class=ok>'+fmtCost(n.costSource)+'</td><td>'+(n.tokens||0)+'</td><td class=mut>'+(n.artifact||'-')+'</td></tr>').join('')+'</table>'+
  '<div style="margin-top:10px">cost by source: '+JSON.stringify(ex.costBySource)+' · <b class=ok>your own models</b></div>'+
  (ex.summary?('<div class="card" style="margin-top:12px"><h2>Execution summary</h2><div class=row>'+
    '<div><b>'+ex.summary.tokens+'</b> total tokens<div class=mut>'+Object.entries(ex.summary.byCostSource).map(([k,v])=>k+': '+v).join(' · ')+'</div></div>'+
    '<div>funders used: '+(ex.summary.fundersUsed.length?ex.summary.fundersUsed.join(', '):'(none — tools/gates only)')+'</div>'+
    '<div>'+(ex.summary.zeroFundedOk?'<span class=ok>✓ ran entirely on your own models</span>':'<span class=warn>⚠ '+ex.summary.brainoutputFundedTokens+' unexpected paid tokens</span>')+'</div>'+
    '<div>artifacts: '+(ex.summary.artifacts.length?ex.summary.artifacts.length+' ('+ex.summary.artifacts.slice(0,5).join(', ')+(ex.summary.artifacts.length>5?', …':'')+')':'none')+'</div>'+
    '</div></div>'):'')+
  (s.approvals||[]).filter(a=>a.taskId===ex.taskId&&a.status==='pending').map(a=>'<div class=warn style="margin-top:8px">⚠ human approval required ('+a.kind+') — <button class=act data-approve="'+a.id+'">Approve</button></div>').join('')+
  ((ex.codeFiles&&ex.codeFiles.length)?('<h2 style="margin-top:14px">Files (real OpenCode output)</h2>'+ex.codeFiles.map(f=>'<div class=mut style="margin-top:6px">'+f.name+'</div><pre>'+(f.content||'').replace(/[&<]/g,c=>c==="&"?"&amp;":"&lt;")+'</pre>').join('')):'')+
  '<h2 style="margin-top:14px">Logs</h2><pre>'+ex.logs.join('\\n')+'</pre></div></div>')}
};
function advSummary(a){if(!a)return '';const st=a.stageRuntimes||{},ad=a.advanced||{};
 const parts=Object.entries(st).filter(([,v])=>v).map(([k,v])=>k+'→'+v);
 return '<div class=mut style="margin-top:8px;font-size:12px">⚙ advanced · '+(parts.join(' · ')||'no per-stage overrides')
  +' · privacy: '+(ad.privacy||'internal')+(ad.contextLimits?' · budget: '+ad.contextLimits+' tok':'')+(ad.costLimit!=null?' · cost limit: '+ad.costLimit:'')+'</div>'}
function missionCard(m){const g=(m.graph&&m.graph.nodes||[]).join(' → ');
 return '<div class=card><h2>Mission composer</h2>'
  +'<div class=row><div><label>Objective</label><input id=mo value="'+String(m.objective||'').replace(/"/g,'&quot;')+'"></div>'
  +'<div><label>Department</label><input id=mdp value="'+(m.department||'')+'"></div></div>'
  +'<div class=mut style="margin-top:8px">graph: '+(m.graph&&m.graph.shape)+' · '+g+'</div>'
  +'<div class=mut>agents: '+(m.agents||[]).join(', ')+' · tools: '+(m.tools||[]).join(', ')+' · permissions: '+(m.permissions||[]).join(', ')+'</div>'
  +'<div class=mut>approval gates: '+(Object.keys(m.approvals||{}).join(', ')||'none')+' · policies: '+((m.policies||[]).join(', ')||'none')+'</div>'
  +'<div class=mut>constraints: '+((m.constraints||[]).join('; ')||'none')+' · acceptance: '+((m.acceptanceCriteria||[]).join('; ')||'none')+'</div>'
  +'<div style="margin-top:10px">status: <span class='+(m.status==='approved'?'ok':'mut')+'>'+m.status+'</span></div>'
  +'<div style="margin-top:10px">'
   +'<button class=act data-mid="'+m.id+'" data-act="edit">Edit</button> '
   +'<button class=act data-mid="'+m.id+'" data-act="launch">Approve &amp; launch</button> '
   +'<button class=act data-mid="'+m.id+'" data-act="save-workflow">Save as workflow</button> '
   +'<button class=act data-mid="'+m.id+'" data-act="cancel">Cancel</button></div></div>'}
window.missionAct=async(id,action)=>{
 if(action==='edit'){const o=document.getElementById('mo'),dp=document.getElementById('mdp');
   const r=await api('/api/chat/mission',{missionId:id,action:'edit',patch:{objective:o.value,department:dp.value}});
   if(r.error){alert(r.error);return}S.chat.mission=r.mission;await refresh();render();return}
 if(action==='launch'){const a=await api('/api/chat/mission',{missionId:id,action:'approve'});
   if(a.error){alert(a.error);return}
   const r=await api('/api/chat/launch',{missionId:id});
   if(r.error){alert(r.error);return}S.chat.mission=r.mission;await refresh();render();return}
 const r=await api('/api/chat/mission',{missionId:id,action:action==='cancel'?'cancel':'save-workflow'});
 if(r.error){alert(r.error);return}S.chat.mission=r.mission;await refresh();render()};
window.approve=async(id)=>{await api('/api/approval',{id,decision:'approved'});await refresh()};
function runtimeCardHtml(c){return '<div class=node style="display:block;margin:8px 0;padding:12px">'
 +'<b>'+c.label+'</b> <span class=mut>&middot; Works with '+c.worksWith+'</span>'+(c.connected?' <span class=ok>&#10003; connected</span>':'')
 +'<div class=mut style="margin:4px 0">'+c.summary+'</div>'
 +'<div class=mut style="font-size:12px">'+(c.cliLocal?'local CLI &middot; model '+c.defaultModelLocation:'model '+c.defaultModelLocation)+' &middot; caps: '+c.capabilities.join(', ')+' &middot; tools: '+(c.toolSupport?'yes':'model-dependent')+' &middot; auth: '+c.authSources.join('/')+'</div>'
 +(c.note?'<div class=mut style="font-size:12px;margin-top:4px">'+c.note+'</div>':'')
 +'<button class=act style="margin-top:8px" onclick="connectRuntime(\\''+c.runtime+'\\')">Connect (read-only default)</button></div>'}
window.connectRuntime=async(runtime)=>{const defs={'local-openai':{authSource:'local',endpoint:'http://127.0.0.1:11434/v1/chat/completions',model:'(local model)'},'claude-code':{authSource:'user-subscription',model:'claude (your plan)'},'codex':{authSource:'user-api-account',model:'codex (your account)'},'opencode':{authSource:'free',model:'(free coding model)'},'generic-llm':{authSource:'free',model:'(free model)'}};const r=await api('/api/connect-runtime',{runtime,...(defs[runtime]||{authSource:'free'})});if(r.error){alert(r.error);return}S.tab='connections';await refresh();render()};
refresh();
</script></body></html>`;
