// SPDX-License-Identifier: Apache-2.0
// Lodgify read-only connector + "rooms occupied today" chat intent (task-pm-12). Zero-dep:
// `node --test lodgify.test.mjs`. Client tests use an injected fetch (like odoo.test.mjs); the
// intent e2e runs a REAL web-server against a tmp BO_CE_DATA with a stub Lodgify HTTP API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lodgifyClient, occupancyToday, isOccupiedBooking, LODGIFY_BASE_URL } from "./lodgify.mjs";
import { CONNECTOR_CATALOG, newConnector, resolvePermission } from "./connectors.mjs";
import { looksLikeOccupancy, looksLikeWork } from "./chat.mjs";
import { LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── stub fetch plumbing (unit level) ────────────────────────────────────────────────────────────
const AT = "2026-08-02T12:00:00Z";
const AVAILABILITY = [
  { user_id: 1, property_id: 11, room_type_id: 101, periods: [
    { start: "2026-08-01", end: "2026-08-05", available: 2, closed_period: null, bookings: [
      { id: 1, status: "Booked" }, { id: 2, status: "checked-in" },
      { id: 3, status: "Cancelled" }, { id: 4, status: "tentative" }, { id: 5, status: "declined" }] } ] },
  { user_id: 1, property_id: 11, room_type_id: 102, periods: [
    { start: "2026-08-02", end: "2026-08-03", available: 1, closed_period: null, bookings: [{ id: 6, status: "booked" }] } ] },
  { user_id: 1, property_id: 22, room_type_id: 201, periods: [
    { start: "2026-08-02", end: "2026-08-02", available: 0, closed_period: { id: 9 }, bookings: [] } ] },
  // No period covers `at` for this room type — 0 occupied, never an error.
  { user_id: 1, property_id: 33, room_type_id: 301, periods: [
    { start: "2026-09-01", end: "2026-09-05", available: 5, closed_period: null, bookings: [] } ] },
];
const PROPERTIES = [{ id: 11, name: "Hotel Soleil" }, { id: 22, name: "Beach House" }];
const ROOMS = { 11: [{ id: 101, name: "Double", units: 4 }, { id: 102, name: "Suite" }], 22: [{ id: 201, name: "Villa", units: 3 }] };

const stubFetch = (calls = []) => {
  const f = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api(?=\/v2\/)/, "");   // tolerate a baseUrl with a path prefix
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (path === "/v2/availability") return ok(AVAILABILITY);
    if (path === "/v2/properties") return ok(PROPERTIES);
    const m = path.match(/^\/v2\/properties\/(\d+)\/rooms$/);
    if (m) {
      if (m[1] === "33") return { ok: false, status: 404, json: async () => ({ message: "property not found", code: "NotFound" }) };
      return ok(ROOMS[m[1]] || []);
    }
    return { ok: false, status: 404, json: async () => ({ message: "no such path", code: "NotFound" }) };
  };
  f.calls = calls;
  return f;
};

// ── 1 · occupancyToday aggregate math ───────────────────────────────────────────────────────────
test("occupancyToday: multi-property math exact; cancelled/declined/tentative never count", async () => {
  const calls = [];
  const client = lodgifyClient({ apiKey: "k", fetchImpl: stubFetch(calls) });
  const occ = await occupancyToday({ at: AT, client });

  assert.equal(occ.date, "2026-08-02");
  assert.equal(occ.occupied, 3);          // 2 (Booked + checked-in) + 1 (booked) — the 3 non-statuses skipped
  assert.equal(occ.total, 9);             // 4 (explicit) + 2 (occupied+available) + 3 (explicit) + 0
  assert.equal(occ.properties.length, 3);

  const soleil = occ.properties.find((p) => p.propertyId === 11);
  assert.equal(soleil.name, "Hotel Soleil");
  assert.equal(soleil.occupied, 3);
  assert.equal(soleil.total, 6);
  const dbl = soleil.roomTypes.find((r) => r.roomTypeId === 101);
  assert.deepEqual({ occupied: dbl.occupied, available: dbl.available, units: dbl.units, bookings: dbl.bookings, name: dbl.name },
    { occupied: 2, available: 2, units: 4, bookings: 5, name: "Double" });
  const suite = soleil.roomTypes.find((r) => r.roomTypeId === 102);
  assert.equal(suite.units, 2, "no explicit unit count → occupied + available");

  const beach = occ.properties.find((p) => p.propertyId === 22);
  assert.equal(beach.occupied, 0);
  assert.equal(beach.roomTypes[0].closed, true, "closed_period surfaces as closed");
  assert.equal(beach.roomTypes[0].units, 3, "closed ≠ occupied — explicit units still count as capacity");

  const ghost = occ.properties.find((p) => p.propertyId === 33);
  assert.equal(ghost.name, null, "property missing from /v2/properties degrades to no name");
  assert.equal(ghost.occupied, 0);
  assert.equal(ghost.roomTypes[0].occupied, 0, "no period covering today → 0, not an error");

  const avail = calls.find((c) => c.url.includes("/v2/availability"));
  assert.ok(avail.url.includes("start=2026-08-02") && avail.url.includes("end=2026-08-03"));
  assert.ok(avail.url.includes("includeDetails=true"), "details are required for the bookings array");
});

test("isOccupiedBooking: casing-tolerant; enquiry/quote/cancelled do not occupy", () => {
  for (const s of ["Booked", "booked", "Checked-in", "checked_in", "Confirmed", null, undefined])
    assert.equal(isOccupiedBooking({ status: s }), true, String(s));
  for (const s of ["Cancelled", "canceled", "Declined", "tentative", "inquiry", "enquiry", "quote", "expired"])
    assert.equal(isOccupiedBooking({ status: s }), false, String(s));
});

// ── 2 · client behavior ─────────────────────────────────────────────────────────────────────────
test("client: X-ApiKey header on every call; baseUrl overridable; pagination bounded", async () => {
  const calls = [];
  const client = lodgifyClient({ apiKey: "secret-key-123", baseUrl: "https://lodgify-stub.local/api", fetchImpl: stubFetch(calls) });
  await client.getProperties();
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.equal(c.headers["X-ApiKey"], "secret-key-123");
  assert.ok(calls[0].url.startsWith("https://lodgify-stub.local/api/v2/properties"));
  assert.equal(LODGIFY_BASE_URL, "https://api.lodgify.com", "the default stays the real API");
  assert.throws(() => lodgifyClient({}), /needs an API key/);
});

test("client: 401 and 500 errors surface LOUD with the API's message", async () => {
  const err = (status, body) => async () => ({ ok: false, status, json: async () => body });
  await assert.rejects(
    () => lodgifyClient({ apiKey: "bad", fetchImpl: err(401, { message: "invalid api key", code: "NotAuthorized" }) }).getProperties(),
    /HTTP 401: invalid api key/);
  await assert.rejects(
    () => lodgifyClient({ apiKey: "k", fetchImpl: err(500, { message: "boom internally", code: "Unknown" }) }).getAvailability({ start: "2026-08-02", end: "2026-08-03" }),
    /HTTP 500: boom internally/);
});

test("client: timeout honored via the abort signal", async () => {
  const hanging = (url, opts) => new Promise((_, rej) =>
    opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }))));
  await assert.rejects(
    () => lodgifyClient({ apiKey: "k", fetchImpl: hanging, timeoutMs: 20 }).getProperties(),
    /timed out/i);
});

// ── 4 · catalog registration ────────────────────────────────────────────────────────────────────
test("catalog: Lodgify registered api-key-local and READ-ONLY (no write verb exists to grant)", () => {
  const cat = CONNECTOR_CATALOG.lodgify;
  assert.ok(cat, "lodgify is in the catalog");
  assert.equal(cat.mechanism, "api-key-local");
  assert.deepEqual(cat.scopes, ["read"]);
  const conn = newConnector("lodgify");
  assert.deepEqual(conn.grants, [], "read-only by default");
  assert.equal(resolvePermission(conn, { action: "get-availability" }).allowed, true);
  assert.equal(resolvePermission(conn, { action: "update-availability" }).allowed, false);
  assert.match(resolvePermission(conn, { action: "update-availability" }).reason, /does not expose/);
});

// ── intent detector ─────────────────────────────────────────────────────────────────────────────
test("looksLikeOccupancy: en/fr/de variants match; non-occupancy does not", () => {
  for (const s of ["rooms occupied today", "how many rooms are occupied today?", "occupancy today",
    "what is the occupancy rate?", "chambres occupées", "combien de chambres occupées aujourd'hui ?",
    "occupation aujourd'hui", "taux d'occupation", "Zimmer belegt", "wie viele Zimmer sind heute belegt?",
    "Belegung heute", "belegte Zimmer"])
    assert.equal(looksLikeOccupancy(s), true, s);
  for (const s of ["what's your occupation?", "comment créer un compte ?", "what is a minesweeper",
    "reply to the guest's email", ""])
    assert.equal(looksLikeOccupancy(s), false, s);
  // The ambiguity the web-server guard resolves: an occupancy-flavored BUILD request stays work.
  assert.equal(looksLikeWork("build me a hotel occupancy dashboard"), true);
  assert.equal(looksLikeOccupancy("build me a hotel occupancy dashboard") && !looksLikeWork("build me a hotel occupancy dashboard"), false);
});

// ── 5 · i18n parity ─────────────────────────────────────────────────────────────────────────────
test("i18n parity: fr and de carry every new key", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
});

// ── 3 · intent e2e: real server, tmp BO_CE_DATA, stub Lodgify API ──────────────────────────────
const PORT = 4419;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, stub, dir;
const MODE = { fail500: false };
const stubHeaders = [];

const isoDay = (d = new Date()) => d.toISOString().slice(0, 10);
const E2E_AVAILABILITY = () => [
  { user_id: 1, property_id: 11, room_type_id: 101, periods: [
    { start: isoDay(), end: isoDay(new Date(Date.now() + 86400000)), available: 1, closed_period: null, bookings: [
      { id: 1, status: "Booked" }, { id: 2, status: "Checked-in" }, { id: 3, status: "cancelled" }] } ] },
];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-lodgify-"));
  stub = createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    stubHeaders.push({ path: req.url, key: req.headers["x-apikey"] || null });
    if (req.headers["x-apikey"] !== "test-key") return send(401, { message: "invalid api key", code: "NotAuthorized", correlation_id: "c1" });
    if (MODE.fail500) return send(500, { message: "boom internally", code: "Unknown", correlation_id: "c2" });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v2/properties") return send(200, [{ id: 11, name: "Hotel Soleil" }]);
    if (u.pathname === "/v2/properties/11/rooms") return send(200, [{ id: 101, name: "Double", units: 4 }]);
    if (u.pathname === "/v2/availability") return send(200, E2E_AVAILABILITY());
    return send(404, { message: "no such path", code: "NotFound" });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_LODGIFY_BASE_URL: `http://127.0.0.1:${stub.address().port}` }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 250)); if (i === 59) throw new Error("server did not start"); }
  }
});
after(() => { srv?.kill(); stub?.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const askOccupancy = async (text) => {
  const r = await post("/api/chat/send", { text, mode: "ask", scope: "company" });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const msgs = r.body.conversation.messages;
  return { reply: msgs.at(-1).text, citations: r.body.citations || [] };
};

test("e2e: no connection → honest connect reply, never a fabricated number", async () => {
  const { reply } = await askOccupancy("how many rooms are occupied today?");
  assert.match(reply, /No Lodgify connection yet/);
  assert.doesNotMatch(reply, /\d+ of \d+ units/, "no invented occupancy number");
  assert.doesNotMatch(reply, /No matching company knowledge/, "the intent was NOT swallowed by the RAG path");
});

test("e2e: connect probes live (401 rejected loud); a good key seals, never plaintext", async () => {
  const bad = await post("/api/connector/lodgify", { apiKey: "wrong-key" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /invalid api key/, "the API's own error message reaches the user");

  const good = await post("/api/connector/lodgify", { apiKey: "test-key" });
  assert.equal(good.status, 200, JSON.stringify(good.body).slice(0, 300));
  assert.equal(good.body.lodgify.connected, true);
  assert.ok(stubHeaders.some((h) => h.key === "test-key"), "the probe sent the X-ApiKey header");

  const raw = readFileSync(join(dir, "runtime.json"), "utf8");
  assert.ok(!raw.includes("test-key"), "the key is sealed at rest — never plaintext");
  const def = readFileSync(join(dir, "definition.json"), "utf8");
  assert.ok(!def.includes("test-key"), "the key never enters the exportable definition");
});

test("e2e: with NO conversation model, the deterministic answer carries number, breakdown, sources", async () => {
  const { reply, citations } = await askOccupancy("how many rooms are occupied today?");
  assert.match(reply, /2 of 4 units occupied today/, reply);
  assert.match(reply, /Hotel Soleil: 2\/4/, "per-property breakdown");
  assert.match(reply, /Double: 2\/4/, "per-room-type detail");
  assert.ok(citations.some((c) => /^Lodgify · /.test(c)), "sources line: Lodgify · timestamp");

  // And it stays deterministic when the question is phrased differently.
  const again = await askOccupancy("occupancy today?");
  assert.match(again.reply, /2 of 4 units occupied today/);
});

test("e2e: FR variant answers in French; API 500 shows the REAL error", async () => {
  const loc = await post("/api/settings", { locale: "fr" });
  assert.equal(loc.status, 200);
  const { reply } = await askOccupancy("combien de chambres occupées aujourd'hui ?");
  assert.match(reply, /2 unités sur 4 occupées aujourd'hui/, reply);

  MODE.fail500 = true;
  const boom = await askOccupancy("combien de chambres occupées aujourd'hui ?");
  assert.match(boom.reply, /Lodgify n'a pas pu répondre/);
  assert.match(boom.reply, /boom internally/, "the real API error is visible — never disguised");
  MODE.fail500 = false;

  const missing = await askOccupancy("wie viele Zimmer sind heute belegt?");
  assert.match(missing.reply, /2 unités sur 4/, "German phrasing routes too (locale stays fr)");
});

test("e2e: disconnect removes the connection; the honest connect reply returns", async () => {
  const d = await post("/api/connector/lodgify/disconnect", {});
  assert.equal(d.status, 200);
  assert.equal(d.body.lodgify.connected, false);
  const { reply } = await askOccupancy("occupancy today?");
  assert.match(reply, /connexion Lodgify/, "honest again — in the workspace locale (fr)");
});
