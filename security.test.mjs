// SPDX-License-Identifier: Apache-2.0
// The local dashboard reads (and can send) mail. "Loopback only" is NOT protection: any site you visit
// can make your browser POST to 127.0.0.1, and a rebound DNS name can read the response. These tests
// pin the guard that stops that, and pin that a local CLI keeps working.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-sec-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, headers, body = "{}") => fetch(`${BASE}${path}`, { method: "POST", headers, body });

test("a cross-origin POST is refused (CSRF) — simple content-type or JSON alike", async () => {
  for (const ct of ["text/plain;charset=UTF-8", "application/json"]) {
    const r = await post("/api/worktwin/mode", { Origin: "https://evil.example", "Content-Type": ct },
      JSON.stringify({ twinId: "twin-x", mode: "delegate" }));
    assert.equal(r.status, 403, `Origin check must refuse ${ct}`);
    assert.match((await r.json()).error, /cross-origin/);
  }
});

test("a request the browser marks cross-site is refused", async () => {
  const r = await post("/api/worktwin/grant", { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /cross-site/);
});

test("a foreign Host is refused (DNS rebinding)", async () => {
  // fetch() forbids setting Host, so use a raw request — exactly what a rebound name would produce.
  const { request } = await import("node:http");
  const res = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/state", headers: { Host: "evil.example" } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode, body: d })); });
    req.on("error", reject); req.end();
  });
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error, /not loopback/);
});

test("a browser request without the CSRF token is refused, even same-origin", async () => {
  const r = await post("/api/worktwin/mode", { Origin: BASE, "Content-Type": "application/json" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /CSRF/);
});

test("state-changing requests must be JSON (blocks form-style posts)", async () => {
  const r = await post("/api/settings", { "Content-Type": "application/x-www-form-urlencoded" }, "mode=advanced");
  assert.equal(r.status, 415);
});

test("the page serves a per-process token, and a browser request WITH it is accepted", async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  const token = html.match(/const CSRF='([0-9a-f]{48})'/)?.[1];
  assert.ok(token, "the dashboard must embed a CSRF token");
  const r = await post("/api/settings", { Origin: BASE, "Content-Type": "application/json", "X-BO-CSRF": token },
    JSON.stringify({ mode: "advanced" }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).settings.mode, "advanced");
});

test("a local CLI (no browser headers) keeps working", async () => {
  const r = await fetch(`${BASE}/api/state`);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok("company" in s);
  const w = await post("/api/settings", { "Content-Type": "application/json" }, JSON.stringify({ mode: "regular" }));
  assert.equal(w.status, 200);
});

test("the dashboard sets hardening headers", async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.equal(r.headers.get("access-control-allow-origin"), null);   // never CORS-open the API
});
