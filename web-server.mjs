#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — minimal web experience (2026-07-27).
// Zero-dep Node http server + single-page dashboard. Backed by the persistence store (M3) and the
// engine (routing/onboarding/adapters). Runs REAL local-model executions via the OpenAI-compatible
// chat adapter ($0 local). Shows prominently: BrainOutput-funded inference $0, provider/model, cost
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
  const b = await body(req);
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
  return json(res, { error: "unknown endpoint" }, 404);
}

function publicState() {
  const funded = store.runtime.executions.reduce((s, e) => s + (e.brainoutputFundedTokens || 0), 0);
  return { company: store.def.company, departments: store.def.departments, agents: store.def.agents,
    connections: store.def.modelConnections, assignments: store.def.modelAssignments,
    agentViews: store.def.agents.map((a) => renderAgentView(a, store.def.modelAssignments, store.def.modelConnections)),
    tasks: store.runtime.tasks, executions: store.runtime.executions, approvals: store.runtime.approvals,
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
  // workspace); everything else runs on the OpenAI-compatible chat adapter. Both are $0 local.
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
<header><h1>🏢 BrainOutput Community</h1><span class=mut id=coname></span><span class=zero id=zero>BrainOutput-funded inference: $0</span></header>
<nav id=nav></nav><main id=view></main>
<script>
const S={state:null,tab:'dashboard'};
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild};
async function api(p,body){const r=await fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});return r.json()}
async function refresh(){S.state=await api('/api/state');render()}
const TABS=[['dashboard','Dashboard'],['connections','1 · Connections'],['company','2 · Company'],['org','3 · Organization'],['assign','4 · Assignments'],['task','6 · New Objective'],['exec','7 · Executions']];
function nav(){const n=document.getElementById('nav');n.innerHTML='';TABS.forEach(([k,l])=>{const b=el('<button>'+l+'</button>');if(k===S.tab)b.className='on';b.onclick=()=>{S.tab=k;render()};n.appendChild(b)})}
function fmtCost(c){return c==='local-compute'?'your local compute ($0)':c==='free'?'FREE':c==='user-subscription'?'your subscription':c==='user-api-account'?'your API account':c||'-'}
function render(){nav();const s=S.state||{};document.getElementById('coname').textContent=s.company?.name?('· '+s.company.name):'';document.getElementById('zero').textContent='BrainOutput-funded inference: $'+(s.brainoutputFundedTokens?('!!'+s.brainoutputFundedTokens):'0');
const v=document.getElementById('view');v.innerHTML='';v.appendChild(VIEWS[S.tab](s))}
const VIEWS={
 dashboard:(s)=>el('<div><div class=card><h2>Company dashboard</h2><div class=row><div><b>'+(s.company?.name||'(no company yet)')+'</b><div class=mut>Funded inference: <span class=ok>$0 — every model is free / local / your own</span></div></div><div class=mut>Departments: '+(s.departments||[]).join(', ')+'<br>Agents: '+((s.agents||[]).length)+' (dormant by default)</div></div></div>'+
  '<div class=card><h2>Agents</h2><table><tr><th>Agent</th><th>Dept/Role</th><th>Models (slot → provider)</th><th>Status</th></tr>'+(s.agentViews||[]).map(a=>'<tr><td>'+a.id+'</td><td>'+a.department+'/'+a.role+'</td><td>'+Object.entries(a.models).map(([k,m])=>'<div><span class=mut>'+k+':</span> '+m+'</div>').join('')+'</td><td><span class="pill dormant">'+a.activation+'</span></td></tr>').join('')+'</table></div>'+
  '<div class=card><h2>Recent executions</h2>'+((s.executions||[]).slice(-5).reverse().map(e=>'<div class=node style="display:block;margin-bottom:6px">'+e.department+' · '+e.shape+' · '+e.graph.map(g=>g.model?(g.provider+'/'+g.model):g.needsConfiguration?'UNCONFIGURED':g.costSource).join(' → ')+' · <span class=mut>'+(e.summary?e.summary.tokens+' tok':'')+'</span> · <span class=ok>$'+e.brainoutputFundedTokens+' funded</span></div>').join('')||'<span class=mut>none yet</span>')+'</div></div>'),
 connections:(s)=>{const d=el('<div class=card><h2>1 · Model connections (user / free / local only)</h2><div class=mut>No BrainOutput-hosted paid models are ever used. Detected local models below.</div><div id=det class=mut style="margin:8px 0">detecting…</div><table id=ct></table></div>');
  api('/api/detect').then(r=>{document.getElementById('det').textContent=r.detected.length?('Detected '+r.detected.length+' local model(s).'):'No local model detected — start ollama or connect a model.'});
  d.querySelector('#ct').innerHTML='<tr><th>Connection</th><th>Provider / Model</th><th>Pays</th></tr>'+(s.connections||[]).map(c=>'<tr><td>'+c.id+'</td><td>'+c.provider+' / '+c.model+'</td><td class=ok>'+fmtCost(c.costSource)+'</td></tr>').join('');return d},
 company:()=>{const d=el('<div class=card><h2>2 · Company & departments</h2><label>What does your company do?</label><input id=cd placeholder="e.g. a small software product studio"><label>Departments</label><div id=dep></div><button class=act style="margin-top:12px" id=go>Generate organization ($0)</button><div id=msg class=mut style="margin-top:8px"></div></div>');
  const deps=['technical','customer-service','finance','sales','marketing','human-resources','legal-compliance','operations','data-research','executive'];
  d.querySelector('#dep').innerHTML=deps.map(x=>'<label style="display:inline-block;margin-right:12px;color:var(--fg)"><input type=checkbox value="'+x+'" '+(['technical','customer-service','finance'].includes(x)?'checked':'')+' style="width:auto"> '+x+'</label>').join('');
  d.querySelector('#go').onclick=async()=>{const departments=[...d.querySelectorAll('#dep input:checked')].map(i=>i.value);d.querySelector('#msg').textContent='generating…';await api('/api/onboard',{companyDoes:d.querySelector('#cd').value,departments});await refresh();S.tab='org';render()};return d},
 org:(s)=>el('<div class=card><h2>3 · Generated organization (dormant)</h2><table><tr><th>Agent</th><th>Department</th><th>Role</th><th>Capability slots</th></tr>'+(s.agents||[]).map(a=>'<tr><td>'+a.id+'</td><td>'+a.department+'</td><td>'+a.role+'</td><td class=mut>'+Object.entries(a.capabilities||{}).map(([r,sl])=>r+'→'+sl).join(', ')+'</td></tr>').join('')+'</table><div class=mut style="margin-top:8px">Roles persist; execution context is created only when work exists.</div></div>'),
 assign:(s)=>{const slots=[...new Set((s.agents||[]).flatMap(a=>Object.values(a.capabilities||{})))];const d=el('<div class=card><h2>4 · Model assignment editor</h2><div class=mut>Every slot maps to a user/free/local model. Change any of them.</div><table id=at></table></div>');
  d.querySelector('#at').innerHTML='<tr><th>Capability slot</th><th>Assigned model</th><th>Pays</th></tr>'+slots.map(sl=>{const cid=s.assignments[sl];const conn=(s.connections||[]).find(c=>c.id===cid);const opts=(s.connections||[]).map(c=>'<option value="'+c.id+'" '+(c.id===cid?'selected':'')+'>'+c.provider+'/'+c.model+'</option>').join('');return '<tr><td>'+sl+'</td><td><select data-slot="'+sl+'"><option value="">— unconfigured —</option>'+opts+'</select></td><td class=ok>'+(conn?fmtCost(conn.costSource):'<span class=warn>offer free/BYOK/local/stop</span>')+'</td></tr>'}).join('');
  d.querySelectorAll('select').forEach(se=>se.onchange=async()=>{await api('/api/assign',{slot:se.dataset.slot,connectionId:se.value});await refresh();S.tab='assign';render()});return d},
 task:(s)=>{const d=el('<div class=card><h2>6 · New objective</h2><label>Department</label><select id=dp>'+(s.departments||[]).map(x=>'<option>'+x+'</option>').join('')+'</select><label>Objective</label><textarea id=ob rows=3 placeholder="e.g. Reply to a customer question in Spanish"></textarea><div class=row><label><input type=checkbox id=cx style="width:auto"> complex (use a planner)</label><label><input type=checkbox id=rv style="width:auto"> require review</label><label><input type=checkbox id=ap style="width:auto"> needs human approval</label></div><button class=act style="margin-top:12px" id=run>Run ($0 local)</button><div id=out style="margin-top:12px"></div></div>');
  d.querySelector('#run').onclick=async()=>{d.querySelector('#out').innerHTML='<span class=mut>routing + running on your local models…</span>';const r=await api('/api/task',{department:d.querySelector('#dp').value,objective:d.querySelector('#ob').value,complex:d.querySelector('#cx').checked,review:d.querySelector('#rv').checked,approval:d.querySelector('#ap').checked});await refresh();if(r.error){d.querySelector('#out').innerHTML='<span class=warn>'+r.error+'</span>';return}S.tab='exec';S.exec=r.execution.id;render()};return d},
 exec:(s)=>{const ex=(s.executions||[]).find(e=>e.id===S.exec)||(s.executions||[]).slice(-1)[0];if(!ex)return el('<div class=card><h2>7 · Executions</h2><span class=mut>No executions yet — submit an objective.</span></div>');
  return el('<div><div class=card><h2>7 · Active execution — '+ex.department+' / '+ex.agent+'</h2><div class=graph>'+ex.graph.map(g=>'<span class=node>'+g.node+(g.model?'<br><span class=mut>'+g.provider+'/'+g.model+'</span>':g.needsConfiguration?'<br><span class=warn>UNCONFIGURED</span>':'<br><span class=mut>'+(g.costSource||'')+'</span>')+'</span>').join('<span class=arrow>→</span>')+'</div><div style="margin-top:10px">status: <span class=ok>'+ex.status+'</span> · graph: '+ex.shape+'</div></div>'+
  '<div class=card><h2>8 · Result — model, cost source, artifacts</h2><table><tr><th>Node</th><th>Provider/Model</th><th>Cost source</th><th>Tokens</th><th>Artifact</th></tr>'+ex.results.map(n=>'<tr><td>'+n.node+'</td><td>'+(n.model?(n.provider+'/'+n.model):'-')+'</td><td class=ok>'+fmtCost(n.costSource)+'</td><td>'+(n.tokens||0)+'</td><td class=mut>'+(n.artifact||'-')+'</td></tr>').join('')+'</table>'+
  '<div style="margin-top:10px">cost by source: '+JSON.stringify(ex.costBySource)+' · <b class=ok>BrainOutput-funded: $'+ex.brainoutputFundedTokens+'</b></div>'+
  (ex.summary?('<div class="card" style="margin-top:12px"><h2>Execution summary</h2><div class=row>'+
    '<div><b>'+ex.summary.tokens+'</b> total tokens<div class=mut>'+Object.entries(ex.summary.byCostSource).map(([k,v])=>k+': '+v).join(' · ')+'</div></div>'+
    '<div>funders used: '+(ex.summary.fundersUsed.length?ex.summary.fundersUsed.join(', '):'(none — tools/gates only)')+'</div>'+
    '<div>'+(ex.summary.zeroFundedOk?'<span class=ok>✓ zero BrainOutput-funded inference</span>':'<span class=warn>✗ '+ex.summary.brainoutputFundedTokens+' BrainOutput-funded tokens!</span>')+'</div>'+
    '<div>artifacts: '+(ex.summary.artifacts.length?ex.summary.artifacts.length+' ('+ex.summary.artifacts.slice(0,5).join(', ')+(ex.summary.artifacts.length>5?', …':'')+')':'none')+'</div>'+
    '</div></div>'):'')+
  (s.approvals||[]).filter(a=>a.taskId===ex.taskId&&a.status==='pending').map(a=>'<div class=warn style="margin-top:8px">⚠ human approval required ('+a.kind+') — <button class=act onclick="approve(\\''+a.id+'\\')">Approve</button></div>').join('')+
  ((ex.codeFiles&&ex.codeFiles.length)?('<h2 style="margin-top:14px">Files (real OpenCode output)</h2>'+ex.codeFiles.map(f=>'<div class=mut style="margin-top:6px">'+f.name+'</div><pre>'+(f.content||'').replace(/[&<]/g,c=>c==="&"?"&amp;":"&lt;")+'</pre>').join('')):'')+
  '<h2 style="margin-top:14px">Logs</h2><pre>'+ex.logs.join('\\n')+'</pre></div></div>')}
};
window.approve=async(id)=>{await api('/api/approval',{id,decision:'approved'});await refresh()};
refresh();
</script></body></html>`;
