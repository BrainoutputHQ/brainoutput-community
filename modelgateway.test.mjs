// SPDX-License-Identifier: Apache-2.0
// The loopback model gateway (task-pm-19): anonymous free models must work inside opencode CLI
// runs. Root cause (live-verified): opencode always sends the config's apiKey, and "local" is a
// bogus key Zen rejects — while CE's own anonymous calls send NO Authorization header and work.
// The gateway holds each connection's real auth rules; the executor only bears a gateway token.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { connectionToConfig, prepareOpenCodeWorkspace } from "./opencode-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4651, STUB_PORT = 4652;
const BASE = `http://127.0.0.1:${PORT}`;
const GW_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";   // BO_OC_GATEWAY_TOKEN override (tests)
const BYOK_SECRET = "sk-byok-test-secret-7f3a9c";
const FREE = { id: "free-anon", kind: "opencode-free", provider: "OpenCode Zen", model: "zen-free-x",
  endpoint: `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`, costSource: "free", funder: "free", contextSize: 64000 };
const BYOK = { id: "byok-x", kind: "byok", provider: "user-openai", model: "gpt-x",
  endpoint: `http://127.0.0.1:${STUB_PORT}/v1/chat/completions`, apiKeyEnv: "BO_TEST_USER_KEY",
  costSource: "user-api-account", funder: "user" };

let srv, stub, dir, srvLog = "";
// The stub provider ("Zen"): programmable per test; records exactly what the gateway forwarded.
let stubMode = { status: 200, body: "{}" };
let seen = [];
before(async () => {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (stubMode.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunksOut = stubMode.sse;
        let i = 0;
        const tick = () => {
          if (i < chunksOut.length) { res.write(chunksOut[i++]); setTimeout(tick, 30); }
          else if (!stubMode.hang) res.end();   // hang mode: the provider stalls mid-stream
        };
        tick();
        return;
      }
      res.writeHead(stubMode.status, { "Content-Type": "application/json" });
      res.end(stubMode.body);
    });
  });
  await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

  dir = mkdtempSync(join(tmpdir(), "bo-gw-"));
  writeFileSync(join(dir, "definition.json"), JSON.stringify({
    company: { name: "Gw", brainoutputFundedInference: "forbidden" }, departments: [], agents: [],
    modelAssignments: {}, policies: {}, settings: { mode: "regular" }, modelConnections: [FREE, BYOK],
  }));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")], {
    env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_OC_GATEWAY_TOKEN: GW_TOKEN, BO_TEST_USER_KEY: BYOK_SECRET,
      BO_OPENCODE_BIN: "/nonexistent-opencode" },
    stdio: ["ignore", "pipe", "pipe"] });
  srv.stdout.on("data", (d) => (srvLog += d)); srv.stderr.on("data", (d) => (srvLog += d));
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); stub?.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (connId, body, headers = {}) => fetch(`${BASE}/internal/oc/v1/${connId}/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const authed = { Authorization: `Bearer ${GW_TOKEN}` };

// ── 1 · guards ─────────────────────────────────────────────────────────────────────────────────
test("guard: a non-loopback Origin is refused even with a valid token", async () => {
  const r = await post("free-anon", { model: "zen-free-x" }, { ...authed, Origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /cross-origin/);
});

test("guard: no token and a wrong token are both refused (403)", async () => {
  const noAuth = await post("free-anon", { model: "zen-free-x" });
  assert.equal(noAuth.status, 403);
  assert.match((await noAuth.json()).error, /gateway token/);
  const wrong = await post("free-anon", { model: "zen-free-x" }, { Authorization: "Bearer wrong-token" });
  assert.equal(wrong.status, 403);
});

test("guard: an unknown connection is a 404, and /models carries the same guards", async () => {
  const r = await post("no-such-conn", { model: "x" }, authed);
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /unknown connection/);
  const noAuthModels = await fetch(`${BASE}/internal/oc/v1/free-anon/models`);
  assert.equal(noAuthModels.status, 403);
  const models = await fetch(`${BASE}/internal/oc/v1/free-anon/models`, { headers: authed });
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { object: "list", data: [{ id: "zen-free-x", object: "model" }] });
});

// ── 2 · anonymous free: NO Authorization header, verbatim body, honest relay ───────────────────
test("anonymous free: the relayed request has NO Authorization header and a verbatim body; tool_calls relay byte-exact", async () => {
  seen = [];
  const providerBody = JSON.stringify({ id: "chatcmpl-1", object: "chat.completion",
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "write", arguments: "{\"path\":\"a.txt\"}" } }] } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
  stubMode = { status: 200, body: providerBody };
  const reqBody = { model: "zen-free-x", stream: false, max_tokens: 512, temperature: 0.2,
    messages: [{ role: "system", content: "s" }, { role: "user", content: "write a.txt" }],
    tools: [{ type: "function", function: { name: "write", description: "w", parameters: { type: "object", properties: { path: { type: "string" } } } } }] };
  const r = await post("free-anon", reqBody, authed);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), providerBody, "the provider body is relayed byte-exact");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, undefined, "anonymous free must send NO Authorization header");
  assert.deepEqual(JSON.parse(seen[0].body), reqBody, "messages/tools/stream/max_tokens/temperature pass through untouched");
});

test("anonymous free: a provider error relays status + message — never a silent 200", async () => {
  seen = [];
  stubMode = { status: 502, body: JSON.stringify({ error: { message: "upstream boom" } }) };
  const r = await post("free-anon", { model: "zen-free-x", messages: [] }, authed);
  assert.equal(r.status, 502);
  assert.match(await r.text(), /upstream boom/);
});

// ── 3 · SSE passthrough ─────────────────────────────────────────────────────────────────────────
test("SSE: a streaming provider's chunks reach the client byte-exact (passthrough)", async () => {
  seen = [];
  const chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  stubMode = { sse: chunks };
  const r = await post("free-anon", { model: "zen-free-x", stream: true, messages: [{ role: "user", content: "hi" }] }, authed);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  assert.equal(await r.text(), chunks.join(""), "SSE bytes pass through untouched");
  assert.equal(seen[0].headers.authorization, undefined, "the streamed call is anonymous too");
});

// ── 4 · BYOK through the gateway: Bearer from the resolved secret; the secret never leaks ───────
test("BYOK: the outbound call carries Bearer <secret>; the secret appears in no response or log", async () => {
  seen = [];
  stubMode = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  const r = await post("byok-x", { model: "gpt-x", messages: [{ role: "user", content: "hi" }] }, authed);
  assert.equal(r.status, 200);
  assert.equal(seen[0].headers.authorization, `Bearer ${BYOK_SECRET}`);
  assert.ok(!(await r.text()).includes(BYOK_SECRET), "the response never carries the secret");
  assert.ok(!srvLog.includes(BYOK_SECRET), "the server log never carries the secret");
  assert.ok(!srvLog.includes(GW_TOKEN), "the gateway token is never logged either");
});

// ── 413: a real status, not a dropped socket ────────────────────────────────────────────────────
test("an oversized body gets a real 413 (the socket is not dropped)", async () => {
  seen = [];
  stubMode = { status: 200, body: "{}" };
  const big = JSON.stringify({ model: "zen-free-x", messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] });
  assert.ok(Buffer.byteLength(big) > 1024 * 1024, "the body must exceed the 1MB bound");
  const r = await post("free-anon", big, authed);
  assert.equal(r.status, 413, "the client must receive the 413 status");
  assert.match((await r.json()).error, /too large/);
  assert.equal(seen.length, 0, "an oversized body never reaches the provider");
});

// ── robustness: a broken relay must NEVER take the server down ──────────────────────────────────
test("a client disconnect mid-SSE ends the relay quietly — the server stays up", async () => {
  seen = [];
  stubMode = { sse: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], hang: true };
  const ctrl = new AbortController();
  const r = await fetch(`${BASE}/internal/oc/v1/free-anon/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authed },
    body: JSON.stringify({ model: "zen-free-x", stream: true, messages: [] }), signal: ctrl.signal });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  await reader.read();                       // one chunk arrived, the provider then stalls
  ctrl.abort();                              // the client goes away mid-stream
  await reader.read().catch(() => {});
  await new Promise((r2) => setTimeout(r2, 400));   // let the disconnect reach the server
  const alive = await fetch(`${BASE}/api/state`);
  assert.equal(alive.status, 200, "an aborted opencode call must never take the server down");
  stubMode = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  const again = await post("free-anon", { model: "zen-free-x", messages: [] }, authed);
  assert.equal(again.status, 200, "the gateway still relays after the aborted stream");
});

test("a provider timeout mid-stream ends the relay quietly — the server stays up", async () => {
  // A second CE server with a short gateway timeout (BO_OC_GATEWAY_TIMEOUT_MS override), so the
  // 180s production bound is exercised in milliseconds.
  const PORT2 = 4653, BASE2 = `http://127.0.0.1:${PORT2}`;
  const dir2 = mkdtempSync(join(tmpdir(), "bo-gw-to-"));
  writeFileSync(join(dir2, "definition.json"), JSON.stringify({
    company: { name: "Gw2", brainoutputFundedInference: "forbidden" }, departments: [], agents: [],
    modelAssignments: {}, policies: {}, settings: { mode: "regular" }, modelConnections: [FREE],
  }));
  const srv2 = spawn(process.execPath, [join(HERE, "web-server.mjs")], {
    env: { ...process.env, BO_CE_DATA: dir2, BO_CE_WEB_PORT: String(PORT2),
      BO_OC_GATEWAY_TOKEN: GW_TOKEN, BO_OC_GATEWAY_TIMEOUT_MS: "300",
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await fetch(`${BASE2}/api/state`); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(up, "second server did not start");
    stubMode = { sse: ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'], hang: true };
    // The provider sends one chunk then stalls; the gateway timeout fires MID-STREAM.
    const r = await fetch(`${BASE2}/internal/oc/v1/free-anon/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${GW_TOKEN}` },
      body: JSON.stringify({ model: "zen-free-x", stream: true, messages: [] }) });
    assert.equal(r.status, 200);
    await r.text().catch(() => {});          // the relay just ends (truncated stream)
    await new Promise((r2) => setTimeout(r2, 400));
    const alive = await fetch(`${BASE2}/api/state`);
    assert.equal(alive.status, 200, "a mid-stream timeout must never take the server down");
  } finally { srv2.kill(); rmSync(dir2, { recursive: true, force: true }); stubMode = { status: 200, body: "{}" }; }
});

// ── 5 · the adapter: gateway baseURL for anonymous free; byte-compat for BYOK/local ────────────
const FREE_CLOUD = { ...FREE, endpoint: "https://opencode.ai/zen/v1/chat/completions" };
const OLLAMA = { id: "local:q", kind: "local", provider: "ollama", model: "qwen2.5:7b", endpoint: "http://127.0.0.1:11434/v1/chat/completions", costSource: "local-compute", funder: "local" };

test("adapter: anonymous free + non-loopback endpoint → gateway baseURL + {env:BO_OC_GATEWAY_TOKEN}", () => {
  process.env.BO_OC_GATEWAY_PORT = String(PORT);
  process.env.BO_OC_GATEWAY_TOKEN = GW_TOKEN;
  try {
    const { config } = connectionToConfig(FREE_CLOUD);
    const opts = config.provider["OpenCode-Zen"].options;
    assert.equal(opts.baseURL, `http://127.0.0.1:${PORT}/internal/oc/v1/free-anon`);
    assert.equal(opts.apiKey, "{env:BO_OC_GATEWAY_TOKEN}", "the config references the token by NAME only");
  } finally { delete process.env.BO_OC_GATEWAY_PORT; delete process.env.BO_OC_GATEWAY_TOKEN; }
});

test("adapter: the written opencode.json contains no token value, but the executor env carries it", () => {
  process.env.BO_OC_GATEWAY_PORT = String(PORT);
  process.env.BO_OC_GATEWAY_TOKEN = GW_TOKEN;
  const wsRoot = mkdtempSync(join(tmpdir(), "bo-gw-ws-"));
  try {
    const { env, iso } = prepareOpenCodeWorkspace({ connection: FREE_CLOUD, workspace: join(wsRoot, "ws"), approvedRoots: [wsRoot] });
    const onDisk = readFileSync(join(iso, ".config", "opencode", "opencode.json"), "utf8");
    assert.ok(!onDisk.includes(GW_TOKEN), "the written config must not contain the token value");
    assert.ok(onDisk.includes("{env:BO_OC_GATEWAY_TOKEN}"), "the config uses the env indirection");
    assert.equal(env.BO_OC_GATEWAY_TOKEN, GW_TOKEN, "the spawned process gets the token via env");
    assert.equal(env.BO_OC_GATEWAY_PORT, String(PORT));
  } finally { delete process.env.BO_OC_GATEWAY_PORT; delete process.env.BO_OC_GATEWAY_TOKEN; rmSync(wsRoot, { recursive: true, force: true }); }
});

test("adapter: BYOK and local keep their direct baseURL byte-exact (never gatewayed)", () => {
  process.env.BO_OC_GATEWAY_PORT = String(PORT);
  process.env.BO_OC_GATEWAY_TOKEN = GW_TOKEN;
  try {
    const byok = connectionToConfig(BYOK).config.provider["user-openai"].options;
    assert.equal(byok.baseURL, `http://127.0.0.1:${STUB_PORT}/v1`);
    assert.equal(byok.apiKey, "{env:BO_TEST_USER_KEY}");
    const local = connectionToConfig(OLLAMA).config.provider.ollama.options;
    assert.equal(local.baseURL, "http://127.0.0.1:11434/v1");
    assert.equal(local.apiKey, "local");
  } finally { delete process.env.BO_OC_GATEWAY_PORT; delete process.env.BO_OC_GATEWAY_TOKEN; }
});

test("adapter: a LOCAL-endpoint free connection is NOT gatewayed; no gateway env → direct (byte-compat)", () => {
  process.env.BO_OC_GATEWAY_PORT = String(PORT);
  process.env.BO_OC_GATEWAY_TOKEN = GW_TOKEN;
  try {
    const localFree = connectionToConfig({ ...FREE_CLOUD, endpoint: "http://127.0.0.1:11434/v1/chat/completions" }).config.provider["OpenCode-Zen"].options;
    assert.equal(localFree.baseURL, "http://127.0.0.1:11434/v1", "a loopback endpoint never needs the gateway");
    assert.equal(localFree.apiKey, "local");
  } finally { delete process.env.BO_OC_GATEWAY_PORT; delete process.env.BO_OC_GATEWAY_TOKEN; }
  // Without the gateway in the run environment the connection stays exactly as before the fix.
  const direct = connectionToConfig(FREE_CLOUD).config.provider["OpenCode-Zen"].options;
  assert.equal(direct.baseURL, "https://opencode.ai/zen/v1");
  assert.equal(direct.apiKey, "local");
});
