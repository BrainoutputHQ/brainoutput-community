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

test("work-source credentials are encrypted at rest, and the store is private to the user", async () => {
  const { Store } = await import("./store.mjs");
  const { statSync, readFileSync, existsSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "bo-store-"));
  try {
    const s = new Store(d);
    // seal / open round-trip
    const sealed = s.sealSecret("hunter2");
    assert.notEqual(JSON.stringify(sealed).includes("hunter2"), true);   // ciphertext only
    assert.equal(s.openSecret(sealed), "hunter2");
    assert.equal(s.openSecret(null), null);

    s.addWorkTwin({ id: "t1", accounts: [{ id: "imap:a", secret: sealed }] });
    s.saveRuntime();
    const onDisk = readFileSync(join(d, "runtime.json"), "utf8");
    assert.equal(onDisk.includes("hunter2"), false, "a password must never be written in plaintext");

    // permissions: dir 0700, files 0600, key file 0600
    assert.equal(statSync(d).mode & 0o777, 0o700);
    assert.equal(statSync(join(d, "runtime.json")).mode & 0o777, 0o600);
    assert.ok(existsSync(join(d, "secret.key")));
    assert.equal(statSync(join(d, "secret.key")).mode & 0o777, 0o600);

    // a legacy plaintext secret is re-sealed on the next save (upgrade path)
    const s2 = new Store(d);
    s2.addWorkTwin({ id: "t2", accounts: [{ id: "imap:b", secret: "legacy-plain" }] });
    s2.saveRuntime();
    const after = JSON.parse(readFileSync(join(d, "runtime.json"), "utf8"));
    const acc = after.workTwins.find((t) => t.id === "t2").accounts[0];
    assert.equal(typeof acc.secret, "object", "legacy plaintext must be sealed on write");
    assert.equal(s2.openSecret(acc.secret), "legacy-plain");
    assert.equal(readFileSync(join(d, "runtime.json"), "utf8").includes("legacy-plain"), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an unreadable store file is preserved and reported — never silently overwritten", async () => {
  const { Store } = await import("./store.mjs");
  const { writeFileSync, readFileSync, readdirSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "bo-corrupt-"));
  try {
    // a real company, then a truncated file (an interrupted write, a full disk, a bad copy)
    writeFileSync(join(d, "definition.json"), JSON.stringify({ company: { name: "Acme Studio" }, agents: [{ id: "eng" }] }));
    const good = readFileSync(join(d, "definition.json"), "utf8");
    const truncated = good.slice(0, good.indexOf("agents"));      // cut mid-file, as a bad write would
    writeFileSync(join(d, "definition.json"), truncated);

    const s = new Store(d);
    assert.ok(s.recovered?.length, "the store must report that a file could not be read");
    assert.equal(s.recovered[0].file, "definition.json");

    s.setCompany({ name: "replacement" }).saveDefinition();     // the save that used to destroy it
    const preserved = readdirSync(d).find((f) => f.includes(".corrupt-"));
    assert.ok(preserved, "the unreadable file must be kept beside the store");
    // The exact invariant: the bytes that were on disk are STILL on disk, byte for byte.
    assert.equal(readFileSync(join(d, preserved), "utf8"), truncated, "the unreadable file must be preserved byte for byte");
    assert.match(readFileSync(join(d, preserved), "utf8"), /Acme Studio/, "what survived is still readable by a human");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a healthy store never reports a recovery", async () => {
  const { Store } = await import("./store.mjs");
  const d = mkdtempSync(join(tmpdir(), "bo-ok-"));
  try {
    new Store(d).setCompany({ name: "Fine" }).saveDefinition();
    const s2 = new Store(d);
    assert.equal(s2.recovered, undefined);
    assert.equal(s2.def.company.name, "Fine");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a whole-store backup moves a working install to another machine — credentials included", async () => {
  const { Store } = await import("./store.mjs");
  const src = mkdtempSync(join(tmpdir(), "bo-src-"));
  const dst = mkdtempSync(join(tmpdir(), "bo-dst-"));
  try {
    const a = new Store(src);
    a.setCompany({ name: "Acme Studio" }).setAgents([{ id: "eng" }]);
    a.addWorkTwin({ id: "twin-alice", name: "Alice's Work Twin",
      accounts: [{ id: "imap:alice", secret: a.sealSecret("real-password") }], index: [{ ref: "m1" }] });
    a.addConversation({ id: "c1", messages: [{ i: 0, text: "hello" }] });
    a.addMission({ id: "m1", objective: "Ship it", status: "done" });
    a.save();

    const bundle = a.backupBundle();
    assert.deepEqual(Object.keys(bundle.files).sort(), ["definition.json", "runtime.json", "secret.key"]);

    const b = new Store(dst);
    b.restoreBundle(bundle);
    assert.equal(b.def.company.name, "Acme Studio");
    assert.equal(b.runtime.workTwins.length, 1);          // the definition-only export loses these
    assert.equal(b.runtime.conversations.length, 1);
    assert.equal(b.runtime.missions.length, 1);
    // the whole point: the credential still decrypts on the other machine
    assert.equal(b.openSecret(b.runtime.workTwins[0].accounts[0].secret), "real-password");

    // refuses to clobber an existing company, and refuses a tampered bundle
    assert.throws(() => b.restoreBundle(bundle), /already holds a company/);
    const tampered = { ...bundle, files: { ...bundle.files, "definition.json": bundle.files["definition.json"].replace("Acme", "Evil") } };
    assert.throws(() => b.restoreBundle(tampered, { force: true }), /corrupted \(checksum mismatch\)/);
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); }
});
