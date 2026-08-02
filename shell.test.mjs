// SPDX-License-Identifier: Apache-2.0
// The chat-native shell (Directive 6): `/` serves it, `/dashboard` keeps the advanced surface;
// projects group threads; ad-hoc threads promote; the page speaks en/fr/de for real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4333;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir, zenStub, zenPort;
globalThis.__zenBodies = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-shell-"));
  // A stub "OpenCode Zen" so /api/connect-free is tested without touching the real network.
  // Bodies containing FLAKY-BUDGET get ONE empty-content/length answer, then recover.
  const { createServer } = await import("node:http");
  let flakySeen = 0;
  zenStub = createServer((req, res) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { globalThis.__zenBodies.push(d); res.writeHead(200, { "Content-Type": "application/json" });
      if (d.includes("FLAKY-BUDGET") && flakySeen++ === 0)
        return res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
      if (d.includes("CLARIFY-NOW"))
        return res.end(JSON.stringify({ choices: [{ message: { content: "You haven't provided any context for me to analyze. Could you please clarify?" } }] }));
      if (d.includes("Reply in exactly this form"))
        return res.end(JSON.stringify({ choices: [{ message: { content: "Thinking through it.\n\n```tasks\n[{\"title\": \"research the options\"}, {\"title\": \"draft the first version\"}, {\"title\": \"verify with the user\"}]\n```" } }] }));
      if (d.includes("DASHBOARD-FILES-HERE"))
        return res.end(JSON.stringify({ choices: [{ message: { content: "```files\n[{\"path\": \"index.html\", \"content\": \"<!doctype html><title>rooms</title><h1>Rooms</h1><script src=app.js></script>\"}, {\"path\": \"app.js\", \"content\": \"console.log('rooms')\"}]\n```" } }] }));
      if (d.includes("PDF-SPEC"))
        return res.end(JSON.stringify({ choices: [{ message: { content: "```file:spec.json\n" + JSON.stringify({ title: "Hotel Soleil — pictures", pages: [{ heading: "The hotel", lines: ["A real hotel brochure, generated as a real PDF file by the runtime — not as code that could make one. ".repeat(2)], images: [] }] }) + "\n```" } }] }));
      res.end(JSON.stringify({ choices: [{ message: { content: "ok — done. " + "Real work output follows: ".repeat(8) } }] })); });
  });
  await new Promise((r) => zenStub.listen(0, "127.0.0.1", r));
  zenPort = zenStub.address().port;
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_CE_FREE_ENDPOINT: `http://127.0.0.1:${zenPort}/v1/chat/completions`,
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });   // no coding runtime in tests → deterministic chat path
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); zenStub?.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

/** Poll until fn() returns truthy (async launches complete in the background). */
const until = async (fn, ms = 45000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for async work");
    await new Promise((r) => setTimeout(r, 400));
  }
};
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

test("/ is the chat-native shell with the locale catalog embedded; /dashboard keeps the old page", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /shell\.newProject/);          // catalog keys present
  assert.match(shell, /onboard\.greeting/);
  assert.doesNotMatch(shell, /__BO_CSRF__|__BO_I18N__|__BO_LOCALE__/);   // every placeholder resolved
  const dash = await (await fetch(`${BASE}/dashboard`)).text();
  assert.match(dash, /BrainOutput Community/);
  assert.doesNotMatch(dash, /__BO_CSRF__/);
});

test("projects: create, tag a thread via chat/send, list in state", async () => {
  const p = await post("/api/project", { name: "pdf-saas" });
  assert.equal(p.status, 200);
  assert.equal(p.body.project.name, "pdf-saas");
  assert.equal(p.body.project.kind, "project");
  assert.ok(p.body.projects.some((x) => x.id === p.body.project.id));

  const send = await post("/api/chat/send", { scope: "company", mode: "ask", text: "what departments do we have?", projectId: p.body.project.id });
  assert.equal(send.status, 200);
  assert.equal(send.body.conversation.projectId, p.body.project.id);

  const noName = await post("/api/project", { name: "  " });
  assert.equal(noName.status, 400);
});

test("promote: ad-hoc thread → new project by name; unknown ids refused", async () => {
  const send = await post("/api/chat/send", { scope: "company", mode: "ask", text: "why is the printer offline?" });
  const convId = send.body.conversation.id;
  assert.equal(send.body.conversation.projectId, null);

  const r = await post("/api/conversation/promote", { conversationId: convId, newProjectName: "office infra" });
  assert.equal(r.status, 200);
  assert.equal(r.body.conversation.projectId, r.body.project.id);
  assert.equal(r.body.project.name, "office infra");

  const again = await post("/api/conversation/promote", { conversationId: convId, projectId: "office infra" });
  assert.equal(again.status, 200);                    // spoken name resolves

  const bad = await post("/api/conversation/promote", { conversationId: "conv-ghost", newProjectName: "x" });
  assert.equal(bad.status, 400);
  const bad2 = await post("/api/conversation/promote", { conversationId: convId, projectId: "ghost" });
  assert.equal(bad2.status, 400);
});

test("locale: settings switches the served shell to French; unknown locale refused", async () => {
  const bad = await post("/api/settings", { locale: "es" });
  assert.equal(bad.status, 400);
  const ok = await post("/api/settings", { locale: "fr" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.locale, "fr");
  assert.equal(ok.body.settings.mode, "regular");     // a locale-only change never clobbers mode

  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /Nouveau projet/);
  assert.match(shell, /lang="fr"/);
  const en = await (await fetch(`${BASE}/?lang=de`)).text();   // ?lang= overrides without persisting
  assert.match(en, /Neues Projekt/);
});

test("the embedded browser script parses (template-literal escaping can never blank the page)", async () => {
  const { SHELL_PAGE } = await import("./shell.mjs");
  const vm = await import("node:vm");
  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // throws on a syntax error — e.g. an unescaped newline inside a string
});

test("connect-free: health-checks candidates for real, connects the first healthy, fills only empty slots", async () => {
  await post("/api/onboard", { companyName: "Free Co", companyDoes: "tests", departments: ["technical"] });
  // This machine may have live local models that filled slots at onboard. Clear every slot but
  // one first: connect-free must fill the cleared ones and NOT touch the explicit survivor.
  const before = (await (await fetch(`${BASE}/api/state`)).json());
  const slots = Object.keys(before.assignments || {});
  const survivor = slots[0];
  for (const slot of slots) if (slot !== survivor) await post("/api/assign", { slot, connectionId: null });

  const r = await post("/api/connect-free", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { FREE_CANDIDATES } = await import("./free-models.mjs");
  assert.ok(FREE_CANDIDATES.includes(r.body.picked.model), `picked a real candidate (fastest healthy — ties break by measurement)`);
  assert.equal(r.body.picked.costSource, "free");
  assert.match(r.body.privacyNote, /improve the model/);
  const conn = r.body.connections.find((c) => c.kind === "opencode-free");
  assert.ok(conn, "connection recorded");
  assert.equal(conn.funder, "free");
  for (const slot of slots) {
    if (slot === survivor) assert.equal(r.body.assignments[slot], before.assignments[slot], "explicit assignment untouched");
    else assert.equal(r.body.assignments[slot], conn.id, `cleared slot '${slot}' filled with the free connection`);
  }

  // A later click upgrades slots stuck on the OLD free pick; the local survivor stays put.
  const r2 = await post("/api/connect-free", {});
  assert.equal(r2.status, 200);
  const conn2 = r2.body.connections.find((c) => c.id === `free-${r2.body.picked.model}`);
  assert.ok(conn2);
  for (const slot of slots) {
    if (slot === survivor) assert.equal(r2.body.assignments[slot], before.assignments[slot], "local/BYOK choice still untouched");
    else assert.equal(r2.body.assignments[slot], conn2.id, `slot '${slot}' upgraded to the new pick`);
  }
});

test("connect-runtime dedupes repeated clicks; connection/remove clears its assignments", async () => {
  const body = { runtime: "opencode", authSource: "free", model: "(free coding model)" };
  const first = await post("/api/connect-runtime", body);
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  const nAfterFirst = (first.body.connections || []).length;
  const second = await post("/api/connect-runtime", body);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true, "second identical click dedupes");
  assert.equal((second.body.connections || []).length, nAfterFirst, "no duplicate pile-up");

  // Remove a connection: it disappears, and any assignment pointing at it becomes unassigned.
  const victim = (second.body.connections || []).find((c) => c.runtime === "opencode");
  assert.ok(victim);
  const dead = await post("/api/connection/remove", { id: victim.id });
  assert.equal(dead.status, 200);
  assert.ok(!dead.body.connections.some((c) => c.id === victim.id));
  assert.ok(!Object.values(dead.body.assignments || {}).includes(victim.id), "no dangling assignment");
  const ghost = await post("/api/connection/remove", { id: victim.id });
  assert.equal(ghost.status, 404);
});

test("a model that dies on the output budget gets ONE bigger-budget retry — and the thread says so", async () => {
  const plan = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan", text: "build the FLAKY-BUDGET widget" });
  const m = plan.body.mission;
  assert.ok(m, JSON.stringify(plan.body).slice(0, 200));
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 20000 });
  assert.equal(launch.status, 200);
  assert.equal(launch.body.started, true, "launch returns immediately (async)");
  const conv = await until(async () => {
    const st = await state();
    const c = (st.conversations || []).find((x) => x.id === m.conversationId);
    return c?.messages?.at(-1)?.text?.includes("retry with a bigger output budget") ? c : null;
  });
  assert.match(conv.messages.at(-1).text, /retry with a bigger output budget/);
});

test("a model that only asks for clarification does NOT get a 'Mission complete'", async () => {
  // Route every slot to the stub free connection so the run hits our clarification stub
  // (this machine also has live local models — without this, the worker may use those).
  const st0 = await state();
  const freeConn = (st0.connections || []).find((c) => c.kind === "opencode-free");
  assert.ok(freeConn, "connect-free ran earlier in this file");
  for (const slot of Object.keys(st0.assignments || {})) await post("/api/assign", { slot, connectionId: freeConn.id });

  const plan = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan", text: "build the CLARIFY-NOW website" });
  const m = plan.body.mission;
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 20000 });
  assert.equal(launch.body.started, true);
  const failedMission = await until(async () => {
    const st = await state();
    const mm = (st.missions || []).find((x) => x.id === m.id);
    return mm?.lastError ? mm : null;
  });
  assert.match(failedMission.lastError, /no work|clarification|rien produit|précisions|nichts produziert|Klärung/i);
  assert.equal(failedMission.status, "approved", "back to approved for a relaunch — never stuck running");
  const st = await state();
  const ex = (st.executions || []).find((e) => e.id === launch.body.execution.id);
  assert.equal(ex.status, "failed");
});

test("routines: add, toggle, run-now posts into its thread", async () => {
  const add = await post("/api/routine/add", { kind: "daily-digest" });
  assert.equal(add.status, 200, JSON.stringify(add.body).slice(0, 300));
  const r = add.body.routine;
  assert.equal(r.enabled, true);
  const tog = await post("/api/routine/toggle", { id: r.id });
  assert.equal(tog.body.routines.find((x) => x.id === r.id).enabled, false);
  await post("/api/routine/toggle", { id: r.id });
  await post("/api/routine/run-now", { id: r.id });
  const conv = await until(async () => {
    const st = await state();
    const c = (st.conversations || []).find((x) => x.title === "Today");
    return c?.messages?.length ? c : null;
  });
  assert.match(conv.messages.at(-1).text, /digest/i);
  // next run advanced — a fired routine never double-fires
  const st = await state();
  const after = st.routines.find((x) => x.id === r.id);
  assert.ok(after.nextRunAt > Date.now());
});

test("a PDF mission produces a REAL downloadable PDF — never 'code that could make one'", async () => {
  const plan = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan", text: "create a PDF-SPEC brochure for the hotel" });
  const m = plan.body.mission;
  assert.ok(m);
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  await post("/api/chat/launch", { missionId: m.id, timeoutMs: 20000 });
  const st = await until(async () => {
    const s = await state();
    return (s.artifacts || []).find((a) => a.kind === "file") ? s : null;
  });
  const art = st.artifacts.find((a) => a.kind === "file");
  assert.match(art.name, /\.pdf$/);
  assert.equal(art.mime, "application/pdf");
  const dl = await fetch(`${BASE}/api/artifact/download?id=${art.id}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-type"), /application\/pdf/);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  const ghost = await fetch(`${BASE}/api/artifact/download?id=nope`);
  assert.equal(ghost.status, 404);
});

test("company website, project url, and chat deletion (work records stay)", async () => {
  const bad = await post("/api/company", { website: "ftp://x" });
  assert.equal(bad.status, 400);
  const co = await post("/api/company", { website: "https://hotel-soleil.example" });
  assert.equal(co.status, 200);
  assert.equal(co.body.company.website, "https://hotel-soleil.example");

  const p = await post("/api/project", { name: "brochure", url: "https://hotel-soleil.example/gallery" });
  assert.equal(p.body.project.url, "https://hotel-soleil.example/gallery");
  const cleared = await post("/api/project/url", { id: p.body.project.id, url: "" });
  assert.equal(cleared.status, 200);

  // Deleting a chat removes the thread but never the durable work records.
  const send = await post("/api/chat/send", { scope: "company", mode: "ask", text: "delete me later" });
  const convId = send.body.conversation.id;
  const missionsBefore = (await state()).missions.length;
  const del = await post("/api/conversation/delete", { id: convId });
  assert.equal(del.status, 200);
  assert.ok(!del.body.conversations.some((c) => c.id === convId));
  assert.equal(del.body.missions.length, missionsBefore, "missions survive a deleted thread");
  const ghost = await post("/api/conversation/delete", { id: convId });
  assert.equal(ghost.status, 404);
});

test("cross-project memory: a project brief is in the knowledge base, and the worker prompt carries it", async () => {
  // A project with shipped work becomes retrievable company knowledge (ask across projects).
  const p = await post("/api/project", { name: "memory-check" });
  const pid = p.body.project.id;
  const t = await post("/api/task/new", { title: "vlan decision", projectId: pid });
  await post("/api/task/status", { id: t.body.task.id, status: "done" });
  const ask = await post("/api/chat/send", { scope: "company", mode: "ask", text: "what is happening in memory-check?" });
  const reply = ask.body.conversation.messages.at(-1);
  assert.ok((reply.meta?.citations || []).some((c) => c.includes("project/")),
    `project knowledge is retrieved across projects — citations: ${(reply.meta?.citations || []).join(", ")}`);
});

test("self-diagnostic: the error log drives a report into the Diagnostics thread", async () => {
  const add = await post("/api/routine/add", { kind: "self-diagnostic" });
  assert.equal(add.status, 200);
  // Force an error into the log (a doomed launch records one), then run the diagnostic.
  await post("/api/chat/launch", { missionId: "ghost-mission" });
  await post("/api/routine/run-now", { id: add.body.routine.id });
  const conv = await until(async () => {
    const st = await state();
    const c = (st.conversations || []).find((x) => x.title === "Diagnostics");
    return c?.messages?.length ? c : null;
  }, 10000);
  assert.match(conv.messages.at(-1).text, /Self-diagnostic/);
  const st = await state();
  assert.ok((st.errorPatterns || []).length >= 1, "errorPatterns exposed in state");
});

test("a build request in ASK mode auto-drafts a mission — the user never thinks about modes", async () => {
  const send = await post("/api/chat/send", { scope: "company", mode: "ask", text: "crée-moi un jeu snake en html" });
  assert.equal(send.status, 200, JSON.stringify(send.body));
  assert.ok(send.body.mission, "an ask that is work drafts a mission");
  assert.match(send.body.conversation.messages.at(-1).text, /drafted a mission|préparé une mission|Mission für .* vorbereitet/);

  // A genuine question does NOT get hijacked into planning.
  const q = await post("/api/chat/send", { scope: "company", mode: "ask", text: "what is a minesweeper?" });
  assert.equal(q.status, 200);
  assert.equal(q.body.mission, null);
});

test("task spine API: manual tasks, subtasks, status flips — and missions report INTO tasks", async () => {
  const p = await post("/api/project", { name: "pdf-saas-2" });
  const pid = p.body.project.id;

  const t1 = await post("/api/task/new", { title: "Build the converter", projectId: pid });
  assert.equal(t1.status, 200);
  const sub = await post("/api/task/new", { title: "PDF → text", parentId: t1.body.task.id });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.task.projectId, pid);          // subtask inherits the project

  const flip = await post("/api/task/status", { id: sub.body.task.id, status: "done" });
  assert.equal(flip.body.task.status, "done");
  const bad = await post("/api/task/status", { id: "ghost", status: "done" });
  assert.equal(bad.status, 400);

  // A mission launched from a project thread leaves a task on the spine that receives the result.
  await post("/api/onboard", { companyName: "Acme", companyDoes: "tests", departments: ["technical"] });
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan",
    text: "add a slugify function", projectId: pid });
  assert.equal(send.status, 200, JSON.stringify(send.body));
  const mission = send.body.mission;
  assert.equal(mission.projectId, pid);

  await post("/api/chat/mission", { missionId: mission.id, action: "approve" });
  // Async launch: starts instantly; the spine receives the outcome when the runner lands.
  const launch = await post("/api/chat/launch", { missionId: mission.id, timeoutMs: 20000 });
  assert.equal(launch.body.started, true);

  const reported = await until(async () => {
    const st = await state();
    const task = (st.tasks || []).find((t) => t.projectId === pid && t.missionId === mission.id && t.result);
    return task || null;
  });
  assert.ok(["done", "blocked"].includes(reported.status));
  assert.equal(typeof reported.result.ok, "boolean");
});

test("sources: sidebar rollup always visible; the full catalog lives in Settings (lean menu)", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.doesNotMatch(shell, /vm-sources/, "no fourth menu tab — the menu stays lean");
  assert.match(shell, /id=sources/, "the sidebar Sources section is in the page");
  assert.match(shell, /sourcesView/, "the catalog renders inside Settings");

  const st = await state();
  assert.ok(Array.isArray(st.sourceCatalog), "state carries the catalog");
  assert.equal(st.sourceCatalog.length, 11);
  assert.ok(st.sourceCatalog.every((c) => Array.isArray(c.accounts) && typeof c.verified === "boolean"));
  assert.ok(st.sourceCatalog.some((c) => !c.verified), "OAuth-needing kinds are listed too, marked as such");
  // The sidebar rollup (the carousel display): Mail / Drive / Apps rows, always present.
  assert.ok(Array.isArray(st.sourceFamilies));
  assert.deepEqual(st.sourceFamilies.map((f) => f.family), ["mail", "files", "apps"]);
  assert.equal(st.sourceFamilies.find((f) => f.family === "apps").state, "available", "apps family is actionable via the guided custom-app flow");
  assert.equal(st.sourceCatalog.find((c) => c.kind === "odoo").verified, false, "Odoo kind stays 'soon' — never a fake connect button");
  const shell2 = await (await fetch(`${BASE}/`)).text();
  assert.match(shell2, /id=sources/, "the sidebar Sources section is in the page");
});

test("sources: connect a folder, see it connected (and INDEXED), reject duplicates, disconnect", async () => {
  const twin = await post("/api/worktwin/create", { employee: { id: "bob", name: "Bob", email: "bob@acme.test" } });
  assert.equal(twin.status, 200);

  const dir = mkdtempSync(join(tmpdir(), "bo-shell-src-"));
  writeFileSync(join(dir, "rates.txt"), "August promotion: -30% on lake rooms");
  const connect = await post("/api/worktwin/connect", { twinId: twin.body.twin.id,
    source: { kind: "drive", provider: "local", account: dir, dir } });
  assert.equal(connect.status, 200, JSON.stringify(connect.body));
  assert.ok(connect.body.sampled >= 1, "the folder is actually read at connect time (dir→roots fix)");

  let st = await state();
  const drive = st.sourceCatalog.find((c) => c.kind === "drive");
  assert.equal(drive.accounts.length, 1);
  assert.equal(drive.accounts[0].account, dir);
  assert.equal(st.sourceCatalog.find((c) => c.kind === "imap").accounts.length, 0, "other kinds stay visible, unconnected");

  const dup = await post("/api/worktwin/connect", { twinId: twin.body.twin.id,
    source: { kind: "drive", provider: "local", account: dir, dir } });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already connected/);

  const off = await post("/api/worktwin/disconnect", { twinId: twin.body.twin.id, accountId: `drive:${dir}` });
  assert.equal(off.status, 200);
  st = await state();
  assert.equal(st.sourceCatalog.find((c) => c.kind === "drive").accounts.length, 0, "disconnect returns the kind to not-connected");
  const ghost = await post("/api/worktwin/disconnect", { twinId: twin.body.twin.id, accountId: `drive:${dir}` });
  assert.equal(ghost.status, 400);
  rmSync(dir, { recursive: true, force: true });
});

test("sidebar: consistent SVG line icons (no emoji iconography) + whitespace-separated sections", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /stroke="currentColor"/, "inline SVG icons render in brand-agnostic currentColor");
  assert.doesNotMatch(shell, /vm-chat">💬|vm-work">🗂|vm-settings">⚙/, "no emoji in the view menu");
  assert.match(shell, /ICONS=\{/, "the icon set is defined once");
  assert.doesNotMatch(shell, /\.shead\{[^}]*border-top/, "sections separate with whitespace, not divider lines");
  assert.match(shell, /\.pitem \.lab\{[^}]*text-overflow:ellipsis/, "long labels truncate with ellipsis");
  assert.match(shell, /\.vmenu button\.on\{[^}]*box-shadow/, "the view menu is a segmented control");
  assert.match(shell, /\.sdot\.run\{[^}]*var\(--acc\)/, "running status dot");
  assert.match(shell, /\.sdot\.attn\{[^}]*var\(--warn\)/, "attention status dot");
});

test("brand: the logo icon ships, is served publicly, and the pages link it", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /\/assets\/brand\/logo\/icon-light-32\.png/, "favicon linked");
  assert.match(shell, /icon-dark-192\.png/, "dark-theme brand tile present");
  const icon = await fetch(`${BASE}/assets/brand/logo/icon-light-32.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  const body = await icon.arrayBuffer();
  assert.ok(body.byteLength > 500, "a real PNG, not an empty stub");
  const traversal = await fetch(`${BASE}/assets/brand/logo/..%2F..%2Fstore.mjs`);
  assert.notEqual(traversal.headers.get("content-type"), "image/png", "the brand route never serves outside its allowlist");
  assert.match(await traversal.text(), /<!doctype html/i, "unknown paths get the shell page, never file bytes");
  const login = await fetch(`${BASE}/assets/brand/logo/icon-dark-192.png`);
  assert.equal(login.status, 200, "serves without auth (the login page needs the favicon)");
});

test("the thread header is ONE flat 'talking to' selector — no cascading scope dropdowns", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /id=talkto/, "a single selector picks who answers");
  assert.match(shell, /optgroup label/, "departments and agents are optgroups inside it");
  assert.match(shell, /thead\.hint/, "an inline explanation exists");
  assert.match(shell, /mode\.tip\.ask/, "composer modes explain themselves");
});

test("brand: the B monogram tiles serve as the favicon (PNG first choice)", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /rel="icon" type="image\/png" sizes="32x32" href="\/assets\/brand\/logo\/icon-light-32\.png"/);
  assert.doesNotMatch(shell, /brainoutput-favicon\.svg/, "the superseded brain/circuit SVG is no longer the favicon");
  const icon = await fetch(`${BASE}/assets/brand/logo/icon-light-32.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
});

test("privacy posture: the setting round-trips and the page offers the choice", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /settings\.privacy\.private/, "the full-private option is in the UI");
  const bad = await post("/api/settings", { privacy: "paranoid" });
  assert.equal(bad.status, 400);
  const priv = await post("/api/settings", { privacy: "private" });
  assert.equal(priv.status, 200);
  assert.equal(priv.body.settings.privacy, "private");
  const back = await post("/api/settings", { privacy: "open" });
  assert.equal(back.body.settings.privacy, "open");
});

test("guided add-app: create → configure with live probe → listed → duplicate refused → deleted", async () => {
  // a tiny PMS stub the probe can reach
  const { createServer } = await import("node:http");
  const pms = createServer((req, res) => {
    if (req.headers.authorization === "Bearer bad") { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((r) => pms.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${pms.address().port}`;

  const create = await post("/api/connector/custom", { name: "Lodgify", baseUrl, auth: "api-key" });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const cid = create.body.connector.id;
  assert.equal(cid, "custom-lodgify");
  assert.match(create.body.guide, /sealed/);
  assert.equal(create.body.connector.status, "needs-config");
  assert.equal(create.body.connector.hasSecret, false);
  assert.equal(JSON.stringify(create.body.connector).includes("secret-value"), false, "secrets never echo");

  const dup = await post("/api/connector/custom", { name: "Lodgify" });
  assert.equal(dup.status, 409);

  const bad = await post("/api/connector/configure", { id: cid, config: { baseUrl }, secret: "bad" });
  assert.equal(bad.body.probe.ok, false);
  assert.match(bad.body.probe.reason, /credentials rejected/);
  assert.equal(bad.body.connector.status, "config-error", "a rejected key is SHOWN, never hidden");

  const good = await post("/api/connector/configure", { id: cid, config: { baseUrl }, secret: "real-key" });
  assert.equal(good.body.probe.ok, true);
  assert.equal(good.body.connector.status, "ready");
  const st = await state();
  const custom = (st.customConnectors || []).find((c) => c.id === cid);
  assert.ok(custom, "custom connector in state");
  assert.equal(JSON.stringify(st.customConnectors).includes("real-key"), false, "the sealed key never leaves via state");
  const appsRow = st.sourceCatalog.find((c) => c.kind === "custom-app");
  assert.equal(appsRow.accounts.length, 1, "rolls into the Apps family");

  const del = await post("/api/connector/custom-delete", { id: cid });
  assert.equal(del.body.removed, 1);
  pms.close();
});

test("local bridge endpoints: pair (public, code-authed) → online → models → folder index → revoke kills", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bo-shell-node-"));
  writeFileSync(join(dir, "menu.txt"), "the lunch menu");
  const pc = await post("/api/local/pair-code", {});
  assert.match(pc.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const pair = await post("/api/local/pair", { code: pc.body.code, name: "test-laptop", grants: [dir] });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  const { nodeId, credential } = pair.body;
  const again = await post("/api/local/pair", { code: pc.body.code, name: "x", grants: [] });
  assert.equal(again.status, 400, "codes are single-use");

  const bad = await post("/api/local/poll", { nodeId, credential: "wrong", holdMs: 10 });
  assert.equal(bad.status, 401);
  const poll = await post("/api/local/poll", { nodeId, credential, holdMs: 50 });
  assert.deepEqual(poll.body.verbs, []);
  await post("/api/local/result", { nodeId, credential, callId: "announce", models: ["qwen3:8b"] });

  let st = await state();
  const node = (st.localNodes || []).find((n) => n.id === nodeId);
  assert.ok(node && node.online, "node shows online after polling");
  assert.deepEqual(node.models, ["qwen3:8b"]);
  assert.deepEqual(node.grants, [dir]);

  const addm = await post("/api/local/add-model", { nodeId, model: "qwen3:8b" });
  assert.equal(addm.status, 200);
  const conn = (addm.body.state.connections || []).find((c) => c.kind === "local-node");
  assert.ok(conn, "the node's model became a connection");
  assert.equal(conn.funder, "local");

  const outside = await post("/api/local/index-folder", { nodeId, root: "/etc" });
  assert.equal(outside.status, 400, "cannot index outside the grant");
  const tw = await post("/api/worktwin/create", { employee: { id: "n@x.test", name: "N", email: "n@x.test" } });
  const idx = await post("/api/local/index-folder", { nodeId, root: dir, twinId: tw.body.twin.id });
  assert.equal(idx.status, 400, "bridge not answering in the test server (no exec) → honest error, OR indexed");
  // either the folder indexed (if a bridge answered) or an honest error — never a fake success
  if (idx.status === 200) assert.ok(idx.body.sampled >= 0);
  else assert.match(idx.body.error, /could not index|timed out|offline/);

  const rev = await post("/api/local/revoke", { nodeId });
  assert.equal(rev.status, 200);
  const dead = await post("/api/local/poll", { nodeId, credential, holdMs: 10 });
  assert.equal(dead.status, 401, "a revoked node's credential dies immediately");
  rmSync(dir, { recursive: true, force: true });
});

test("settings sections are FOLDED by default (details.fold, no open attribute) with status subtitles", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /details\.fold/, "fold styles exist");
  assert.match(shell, /function fold\(/, "the fold helper exists");
  const folds = shell.match(/<details class="fold"(?![^>]*open)/g) || [];
  assert.ok(shell.includes("fold(t('settings.company')"), "company folds");
  assert.ok(shell.includes("fold(t('sources.computer')"), "this-computer folds");
  assert.ok(!shell.includes('class="fold" open'), "nothing but the opt-in opens by default");
});

test("settings shows a Users section, open by default, with the actual user and its mode", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /fold\(t\('settings\.users'\)[^\n]*\{open:true\}/, "the Users fold exists and opens by default");
  assert.match(shell, /twin\.mode\.mirror/, "permission modes are shown");
  const st = await state();
  assert.ok(Array.isArray(st.workTwins), "state carries the actual user (the Alter's employee)");
});

test("google oauth: config seals the secret, start redirects with state, callback rejects forgery", async () => {
  const st0 = await state();
  assert.equal(st0.google.configured, false);
  assert.equal(st0.google.connected, false);

  const badId = await post("/api/oauth/google/config", { clientId: "nope", clientSecret: "x".repeat(12) });
  assert.equal(badId.status, 400, "client id must be a real Google client id shape");
  const cfg = await post("/api/oauth/google/config", { clientId: "123.apps.googleusercontent.com", clientSecret: "secret-value-123" });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.google.configured, true);
  assert.equal(JSON.stringify(cfg.body.state).includes("secret-value-123"), false, "the client secret never leaves via state");

  const start = await fetch(`${BASE}/api/oauth/google/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const loc = start.headers.get("location");
  assert.match(loc, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  const stateParam = new URL(loc).searchParams.get("state");
  assert.ok(stateParam);

  const forged = await fetch(`${BASE}/api/oauth/google/callback?code=x&state=forged`, { redirect: "manual" });
  assert.equal(forged.status, 400);
  assert.match(await forged.json().then((j) => j.error), /unknown OAuth state/);

  const disc = await post("/api/oauth/google/disconnect", {});
  assert.equal(disc.body.google.configured, false);
});

test("plan → spine tasks: a goal mission decomposes into subtasks that flip done as workers report", async () => {
  const p = await post("/api/project", { name: "plan-spine-proj" });
  const pid = p.body.project.id;
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan",
    text: "set up the PLAN-SPINE customer portal", projectId: pid });
  const m = send.body.mission;
  assert.ok(m, JSON.stringify(send.body).slice(0, 200));
  assert.ok(m.graph.nodes.includes("planner"), "a goal gets a planner");
  assert.match(m.planPreview[0], /^Plan:/);
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  const launch = await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  assert.equal(launch.body.started, true);

  const done = await until(async () => {
    const st = await state();
    const mm = (st.missions || []).find((x) => x.id === m.id);
    if (mm?.status !== "done") return null;
    const tasks = (st.tasks || []).filter((t) => t.projectId === pid);
    const parent = tasks.find((t) => !t.parentId && t.missionId === m.id);
    const subs = tasks.filter((t) => t.parentId);
    return subs.length >= 2 && subs.every((s) => s.status === "done") ? { parent, subs, mm } : null;
  }, 60000);
  assert.ok(done.parent, "the mission task is on the spine");
  assert.deepEqual(done.subs.map((s) => s.title), ["research the options", "draft the first version", "verify with the user"]);
  assert.ok(done.subs.every((s) => s.result?.ok), "each subtask carries its worker's result");
  const st = await state();
  const exec = (st.executions || []).find((e) => e.missionId === m.id);
  const graphNodes = (exec.graph || []).map((g) => g.node);
  assert.ok(graphNodes.includes("worker-1") && graphNodes.includes("worker-3"), "the live graph shows per-task workers");
  const conv = (st.conversations || []).find((c) => c.id === m.conversationId);
  assert.match(conv.messages.at(-1).text, /Planned tasks: 3\/3 done/);
});

test("a web build lands as REAL downloadable files, and every worker gets the planner's decisions", async () => {
  const p = await post("/api/project", { name: "dash-proj" });
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan",
    text: "set up the DASHBOARD-FILES-HERE room reservations dashboard", projectId: p.body.project.id });
  const m = send.body.mission;
  await post("/api/chat/mission", { missionId: m.id, action: "approve" });
  await post("/api/chat/launch", { missionId: m.id, timeoutMs: 30000 });
  const done = await until(async () => {
    const st = await state();
    const mm = (st.missions || []).find((x) => x.id === m.id);
    return mm?.status === "done" ? st : null;
  }, 60000);
  const arts = (done.artifacts || []).filter((a) => a.executionId && a.kind === "file");
  assert.ok(arts.some((a) => a.name === "index.html"), "index.html is a real artifact");
  assert.ok(arts.some((a) => a.name === "app.js"));
  const dl = await fetch(`${BASE}/api/artifact/download?id=${arts.find((a) => a.name === "index.html").id}`);
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /<h1>Rooms<\/h1>/, "the file content is really on disk");
  const conv = (done.conversations || []).find((c) => c.id === m.conversationId);
  assert.match(conv.messages.at(-1).text, /Files written: index\.html, app\.js/);
  // workers shared the planner's decisions — no three-stack chaos
  const workerBodies = globalThis.__zenBodies.filter((b) => b.includes("YOUR PART (task"));
  assert.ok(workerBodies.length >= 2, "decomposed workers ran");
  for (const b of workerBodies)
    assert.ok(b.includes("The plan and decisions (shared, binding"), "every worker prompt carries the shared plan+decisions");
});

test("sidebar Tasks section lists issues Plane-style (status, who is in charge, reporter on tasks)", async () => {
  const shell = await (await fetch(`${BASE}/`)).text();
  assert.match(shell, /id=tasks/, "the Tasks section is in the sidebar");
  assert.match(shell, /function issueRow/, "issue rows are a shared component");
  assert.match(shell, /task\.status\.in-progress/, "statuses are labeled");
  assert.match(shell, /task\.assignee|task\.reporter/, "detail shows who is in charge and who asked");
  // tasks created by missions carry assignee + reporter
  const send = await post("/api/chat/send", { scope: "department", department: "technical", mode: "plan",
    text: "set up the PLAN-MARKER customer portal", projectId: (await post("/api/project", { name: "issues-proj" })).body.project.id });
  await post("/api/chat/mission", { missionId: send.body.mission.id, action: "approve" });
  await post("/api/chat/launch", { missionId: send.body.mission.id, timeoutMs: 30000 });
  const st = await until(async () => {
    const s = await state();
    return (s.tasks || []).some((t) => t.parentId && t.missionId === send.body.mission.id && t.status === "done") ? s : null;
  }, 60000);
  const spine = (st.tasks || []).find((t) => t.missionId === send.body.mission.id && !t.parentId);
  assert.equal(spine.assignee, "technical-architect", "the assignee is who is in charge");
  assert.equal(spine.reporter, "you", "the reporter is who asked");
  const sub = (st.tasks || []).find((t) => t.parentId === spine.id);
  assert.ok(sub.assignee && sub.reporter, "planner-created tasks carry both parameters");
});
