// SPDX-License-Identifier: Apache-2.0
// Live task view (oc-live-view): the actual HTTP surface web-server.mjs exposes for it —
// GET /api/session/{id}/live (SSE) and POST /api/session/{id}/interrupt — proven against a REAL
// running web-server.mjs (same real-server pattern as security.test.mjs), independent of
// live-session.test.mjs's in-process registry unit tests. No BO_CE_OPENCODE_SERVER session ever
// really exists here (no opencode binary involved) — these tests pin the HONEST "nothing to show"
// behavior the UI depends on (acceptance criterion 2: never a dead/spinning stream) and prove the
// routes are reachable through the real loopback/CSRF guard, not bypassing it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4471;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-liveroutes-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

test("GET /api/session/{unknown}/live closes cleanly with one honest 'unavailable' frame — never a hanging or spinning stream", async () => {
  const r = await fetch(`${BASE}/api/session/no-such-session/live`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const text = await r.text();     // the stub server ends the response itself — this must resolve, never hang
  assert.match(text, /^data: /);
  const frame = JSON.parse(text.trim().replace(/^data:\s*/, ""));
  assert.equal(frame.kind, "terminal");
  assert.equal(frame.statusKey, "live.status.unavailable");
  // The whole point of this boundary: the response body must never contain anything resembling
  // the real OpenCode server's own address — there is no such server here, but nothing in the
  // relay path is ever allowed to construct one into the payload either.
  assert.ok(!/127\.0\.0\.1:\d+/.test(text), `must carry no host:port at all, got: ${text}`);
});

test("POST /api/session/{unknown}/interrupt is refused honestly (404) — never a fabricated 'stopped'", async () => {
  const r = await fetch(`${BASE}/api/session/no-such-session/interrupt`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.match(body.reason, /no such live session/);
});

test("GET .../live method mismatch (POST) and POST .../interrupt method mismatch (GET) are refused, not silently accepted", async () => {
  const wrongMethodLive = await fetch(`${BASE}/api/session/x/live`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(wrongMethodLive.status, 405);
  const wrongMethodInterrupt = await fetch(`${BASE}/api/session/x/interrupt`);
  assert.equal(wrongMethodInterrupt.status, 405);
});

test("a cross-origin POST to .../interrupt is refused by the same CSRF/origin guard every other state-changing endpoint uses", async () => {
  const r = await fetch(`${BASE}/api/session/x/interrupt`,
    { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /cross-origin/);
});

test("a foreign Host is refused for the live-view routes too (DNS rebinding protection is not bypassed for them)", async () => {
  const { request } = await import("node:http");
  const res = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/session/x/live", headers: { Host: "evil.example" } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode, body: d })); });
    req.on("error", reject); req.end();
  });
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error, /not loopback/);
});
