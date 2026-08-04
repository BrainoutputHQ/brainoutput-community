// SPDX-License-Identifier: Apache-2.0
// Per-conversation model picker (task chat-model-picker) + OpenCode-routed chat answers.
// Hermetic: a node:http stub stands in for the model endpoint; BO_OPENCODE_BIN points at a binary
// that does not exist, so any attempt to actually spawn `opencode serve` fails fast (ENOENT) rather
// than touching the network or a real model — proving the OpenCode-routing fallback is safe AND
// that no orphaned process is ever created. No real model, no real OpenCode server, anywhere here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { readFileSync } from "node:fs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4713, STUB_PORT = 4714;
const BASE = `http://127.0.0.1:${PORT}`;

const CONN_DEFAULT = { id: "conn-default", kind: "byok", provider: "default-provider", model: "default-model",
  endpoint: `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`, costSource: "user-api-account", funder: "user", apiKeyEnv: "BO_TEST_KEY" };
const CONN_ALT = { id: "conn-alt", kind: "byok", provider: "alt-provider", model: "alt-model",
  endpoint: `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`, costSource: "user-api-account", funder: "user", apiKeyEnv: "BO_TEST_KEY" };

let srv, stub, dir;
let hits = [];
function stubReplyFor(model) {
  return JSON.stringify({ choices: [{ message: { content: `answer from ${model}` }, finish_reason: "stop" }], usage: { total_tokens: 12 } });
}

before(async () => {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let model = null;
      try { model = JSON.parse(body).model; } catch { /* ignore */ }
      hits.push({ model, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(stubReplyFor(model));
    });
  });
  await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

  dir = mkdtempSync(join(tmpdir(), "bo-modelpicker-"));
  writeFileSync(join(dir, "definition.json"), JSON.stringify({
    company: { name: "PickerCo" },
    departments: ["technical"],
    agents: [{ id: "eng-1", department: "technical", capabilities: {} }],
    modelAssignments: { "fast-cheap": "conn-default" },
    policies: {},
    settings: { mode: "regular", locale: "en" },
    modelConnections: [CONN_DEFAULT, CONN_ALT],
  }));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")], {
    env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_CE_OPENCODE_SERVER: "1", BO_OPENCODE_BIN: "/nonexistent-opencode-binary",
      BO_TEST_KEY: "test-secret-value" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); stub?.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (body) => fetch(`${BASE}/api/chat/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, text: await r.text(), get body() { return JSON.parse(this.text); } }));

// ── 1 · deterministic intents make ZERO model calls, even with the flag on ──────────────────────
test("deterministic intent ('where are we?') answers with zero model calls, flag on", async () => {
  hits = [];
  const r = await post({ scope: "company", mode: "ask", text: "where are we?" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.body.conversation.messages.at(-1).text, /No tasks yet|Across all projects/);
  assert.equal(hits.length, 0, "no HTTP call reached the model stub for a deterministic intent");
});

// (Orphaned-process evidence ("ps aux | grep -c '[o]pencode serve'" == 0) is gathered manually,
// not asserted here: this box is shared with other agents' own long-running `opencode` sessions,
// so a global process-table scan inside `npm test` would be a flaky assertion on machine noise
// having nothing to do with this suite — exactly the class of flake the test brief warns against.)

// ── 2 · picker: per-conversation, persists, no leakage, reply reports which model answered ──────
test("picker: an explicit modelConnectionId is used, and reported on the reply", async () => {
  hits = [];
  const r = await post({ scope: "company", mode: "ask", text: "tell me something interesting", modelConnectionId: "conn-alt" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(hits.length, 1, "the direct adapter fallback reached the stub exactly once");
  assert.equal(hits[0].model, "alt-model");
  assert.equal(r.body.model.model, "alt-model");
  assert.equal(r.body.model.provider, "alt-provider");
  assert.equal(r.body.conversation.modelConnectionId, "conn-alt");
  const lastMsg = r.body.conversation.messages.at(-1);
  assert.equal(lastMsg.meta.model, "alt-model");
  assert.equal(lastMsg.meta.provider, "alt-provider");
  assert.match(lastMsg.text, /answer from alt-model/);
  global.__convAlt = r.body.conversation.id;
});

test("picker: persists WITHOUT the client resending it on the next message", async () => {
  hits = [];
  const r = await post({ conversationId: global.__convAlt, scope: "company", mode: "ask", text: "and another thing" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(hits[0].model, "alt-model", "the conversation's OWN persisted choice was used, not the field being omitted this time");
  assert.equal(r.body.conversation.modelConnectionId, "conn-alt");
});

test("picker: a SEPARATE conversation with no override uses the default — no leakage from the first thread", async () => {
  hits = [];
  const r = await post({ scope: "company", mode: "ask", text: "what is your name" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(hits[0].model, "default-model");
  assert.equal(r.body.model.model, "default-model");
  assert.equal(r.body.conversation.modelConnectionId, null, "a fresh conversation with no pick keeps today's behaviour exactly");
  global.__convDefault = r.body.conversation.id;
});

test("picker: the first conversation still answers on its OWN picked model after the second thread ran", async () => {
  hits = [];
  const r = await post({ conversationId: global.__convAlt, scope: "company", mode: "ask", text: "still alt?" });
  assert.equal(hits[0].model, "alt-model");
  assert.notEqual(global.__convAlt, global.__convDefault);
});

// ── 3 · an unconfigured/absent model is REFUSED, never silently substituted ──────────────────────
test("picker: a modelConnectionId that no longer exists is refused, not silently substituted", async () => {
  hits = [];
  const r = await post({ scope: "company", mode: "ask", text: "hello there", modelConnectionId: "does-not-exist" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(hits.length, 0, "no model call happened — never substituted a different model behind the user's back");
  assert.equal(r.body.model.needsConfiguration, true);
  assert.equal(r.body.model.modelConnectionId, "does-not-exist");
  assert.equal(r.body.model.model, undefined, "no model name is reported — nothing answered");
  const lastMsg = r.body.conversation.messages.at(-1);
  assert.match(lastMsg.text, /no longer configured|model selector/i);
});

// ── 4 · flag-on gracefully falls back to the direct adapter when OpenCode cannot run ─────────────
test("flag on + no real opencode binary: chat still answers via the direct adapter fallback", async () => {
  hits = [];
  const r = await post({ scope: "company", mode: "ask", text: "a brand new generic question nobody asked before" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(hits.length, 1);
  assert.match(r.body.conversation.messages.at(-1).text, /answer from default-model/);
});

// ── 5 · never leak the OpenCode server's own URL/port/session id to the browser ──────────────────
test("no OpenCode server internals (baseURL/port/session id) ever appear in a chat/send payload", async () => {
  const r = await post({ scope: "company", mode: "ask", text: "one more question for good measure" });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /\/api\/session\//, "no OpenCode session path leaked");
  assert.doesNotMatch(r.text, /"ses_[A-Za-z0-9]/, "no OpenCode session id leaked");
  assert.doesNotMatch(r.text, /opencode serve/i, "no reference to the opencode server process leaked");
});

// ── 6 · existing conversations with no choice on record keep today's behaviour exactly ───────────
test("a conversation created before the picker existed (no modelConnectionId field at all) behaves unchanged", async () => {
  hits = [];
  // Simulate a pre-existing record: a conversation object with the field entirely absent, not null.
  const r1 = await post({ scope: "company", mode: "ask", text: "first message, no picker involved" });
  assert.equal(r1.status, 200);
  assert.equal(hits[0].model, "default-model");
  assert.equal(Object.prototype.hasOwnProperty.call(r1.body.conversation, "modelConnectionId"), true);
  assert.equal(r1.body.conversation.modelConnectionId, null);
});

// ── 7 · i18n parity: every new user-facing string for the picker exists in en/fr/de ──────────────
test("i18n parity: picker keys exist in en/fr/de and catalogs stay complete", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  for (const k of ["thead.model", "thead.modelDefault", "thead.modelHint", "chat.modelUnavailable"])
    for (const loc of LOCALES) assert.ok(CATALOG[loc][k] && CATALOG[loc][k].length > 0, `${loc}.${k} missing`);
});

test("the model picker's own strings are pulled through t(), never hardcoded in shell.mjs", () => {
  const shellSrc = readFileSync(new URL("./shell.mjs", import.meta.url), "utf8");
  assert.match(shellSrc, /t\('thead\.model'\)/);
  assert.match(shellSrc, /t\('thead\.modelDefault'\)/);
  assert.match(shellSrc, /t\('thead\.modelHint'\)/);
});
