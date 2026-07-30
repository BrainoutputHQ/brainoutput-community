// SPDX-License-Identifier: Apache-2.0
// The chat-native shell (Directive 6): `/` serves it, `/dashboard` keeps the advanced surface;
// projects group threads; ad-hoc threads promote; the page speaks en/fr/de for real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4333;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-shell-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

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
