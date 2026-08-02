// SPDX-License-Identifier: Apache-2.0
// Project header (task-pm-10): the project view gets a real header — name, an honest state
// select ("—" placeholder when unset, never fabricated), an inline-editable objective saved via
// /api/project/update (errors surfaced), the UNCHANGED honest rollup, and the project's binding
// decisions taken from the LATEST validated-or-materialized plan (a draft plan's decisions are
// never binding). Plus the approved micro-fix: the async-launch crash path stamps finishedAt.
// Server tests hit a real web-server; component tests extract the real blocks from SHELL_PAGE
// and render them in a vm against /api/state-shaped fixtures — no browser needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4403;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-projheader-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

// ── server: the API round-trip ───────────────────────────────────────────────

test("/api/project/update: objective+state round-trip, persisted on disk; validation and clearing", async () => {
  const p = await post("/api/project", { name: "hdr-proj" });
  const pid = p.body.project.id;
  assert.ok(!("state" in p.body.project) && !("objective" in p.body.project),
    "a fresh project carries NEITHER key — migration-safe by construction");

  const upd = await post("/api/project/update", { id: pid, objective: "ship v1 of the portal", state: "active" });
  assert.equal(upd.status, 200, JSON.stringify(upd.body).slice(0, 300));
  assert.equal(upd.body.project.objective, "ship v1 of the portal");
  assert.equal(upd.body.project.state, "active");

  const rec = (await state()).projects.find((x) => x.id === pid);
  assert.equal(rec.state, "active");
  assert.equal(rec.objective, "ship v1 of the portal");

  // Persisted for real: the record on DISK carries both fields.
  const disk = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
  const drec = disk.projects.find((x) => x.id === pid);
  assert.equal(drec.state, "active");
  assert.equal(drec.objective, "ship v1 of the portal");
  assert.ok(drec.updatedAt >= drec.createdAt, "the update bumps updatedAt");

  // A state-only update never clobbers the objective (absent field = untouched).
  const only = await post("/api/project/update", { id: pid, state: "planned" });
  assert.equal(only.status, 200);
  assert.equal(only.body.project.state, "planned");
  assert.equal(only.body.project.objective, "ship v1 of the portal", "the objective survives a state-only patch");

  // Bad state → 400, and nothing changed.
  const bad = await post("/api/project/update", { id: pid, state: "banana" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /state/);
  assert.equal((await state()).projects.find((x) => x.id === pid).state, "planned", "a refused update persists nothing");

  // Unknown project → 404 (also: a workflow id is not a project).
  const ghost = await post("/api/project/update", { id: "nope", state: "active" });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.error, /no project/);

  // Objective bound: 2000 chars pass, 2001 → 400.
  assert.equal((await post("/api/project/update", { id: pid, objective: "x".repeat(2001) })).status, 400);
  assert.equal((await post("/api/project/update", { id: pid, objective: "x".repeat(2000) })).status, 200);

  // Clearing: state null → unset; objective "" → cleared.
  const clr = await post("/api/project/update", { id: pid, state: null, objective: "" });
  assert.equal(clr.status, 200);
  assert.equal(clr.body.project.state, null);
  assert.equal(clr.body.project.objective, null);
  const rec2 = (await state()).projects.find((x) => x.id === pid);
  assert.ok(!rec2.state && !rec2.objective, "cleared reads back as unset — never a stale value");
});

test("micro-fix: the async-launch crash path stamps finishedAt, like the other two terminal updates", () => {
  const src = readFileSync(join(HERE, "web-server.mjs"), "utf8");
  const crash = src.split("\n").find((l) => l.includes("async launch") && l.includes("crashed"));
  assert.ok(crash, "the crash handler exists");
  assert.ok(crash.includes('status: "failed"'), "it marks the execution failed");
  assert.ok(crash.includes("finishedAt: Date.now()"), "…and now records WHEN it ended");
  const terminal = src.split("\n").filter((l) => l.includes("finishedAt: Date.now()"));
  assert.ok(terminal.length >= 3, "all three terminal updates (sync-fail, done, crash) stamp finishedAt");
});

// ── component tests: the header blocks, rendered in a vm ─────────────────────

const TL_START = SHELL_PAGE.indexOf("// ── task list helpers");
const TL_END = SHELL_PAGE.indexOf("/** A foldable settings section", TL_START);
const B_START = SHELL_PAGE.indexOf("// ── task board (task-pm-08)");
const B_END = SHELL_PAGE.indexOf("// Theme: LIGHT is the default", B_START);
const PC_START = SHELL_PAGE.indexOf("/** A durable Plan");
const D_START = SHELL_PAGE.indexOf("// ── task detail (task-pm-09)");
const PV = SHELL_PAGE.indexOf("// ── project view: the task spine", D_START);
const PH = SHELL_PAGE.indexOf("// ── project header (task-pm-10)", PV);
const PV_END = SHELL_PAGE.indexOf("// ── settings:", PV);
assert.ok(TL_START > 0 && TL_END > TL_START && B_START > 0 && B_END > B_START, "helper + board blocks are in the shell");
assert.ok(PC_START > 0 && D_START > PC_START && PV > D_START, "card + detail + project-view blocks are in the shell");
assert.ok(PH > PV && PV_END > PH, "the project header block sits inside the project-view section");
const BLOCKS = [
  SHELL_PAGE.slice(TL_START, TL_END),
  SHELL_PAGE.slice(B_START, B_END),
  SHELL_PAGE.slice(PC_START, D_START),   // planCard, questionCard, reviewLine, extractHtml, runCard
  SHELL_PAGE.slice(D_START, PV),         // the task-detail block (task-pm-09)
  SHELL_PAGE.slice(PV, PV_END),          // taskRow, srow, the project header (task-pm-10), projectView
].join("\n");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Every html string a rendered node tree carries (the fake el keeps the source html + children). */
const htmlOf = (n) => (n == null ? "" : typeof n === "string" ? n : (n.html || "") + (n.children || []).map(htmlOf).join(""));

function makeCtx(st = {}, locale = "en", apiImpl = null) {
  const stub = () => ({ onclick: null, onchange: null, onkeydown: null, value: "", textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, children: [] });
  const calls = [];
  // NOTE: api bodies are built in the vm realm — copy into this realm before deepEqual.
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state: st },
    __renders: 0,
    __alerts: [],
    render() { sandbox.__renders++; },
    alert(m) { sandbox.__alerts.push(String(m)); },
    refresh: async () => {},
    api: async (p, body) => { calls.push([p, body]); return apiImpl ? apiImpl(p, body) : {}; },
    I: (n) => `<svg data-ic="${n}"></svg>`,
    el(h) {
      const node = { html: h, children: [], value: "", textContent: "", style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild(c) { node.children.push(c); return c; },
        querySelector() { return stub(); },
        querySelectorAll() { return []; } };
      Object.defineProperty(node, "innerHTML", {
        get() { return node.html; },
        set(v) { if (v === "") node.children.length = 0; else node.html = v; },
      });
      return node;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS + "\n;globalThis.__h={PROJECT_STATES,projectStateSel,projectObjective,projectDecisions,projectHeader,projectView};", sandbox);
  return { sandbox, h: sandbox.__h, calls };
}

test("header renders name / state / objective / rollup — with the header right under the name", () => {
  const proj = { id: "p1", name: "Portal", state: "active", objective: "ship v1 of the portal" };
  const st = { projects: [proj], tasks: [
    { id: "t1", title: "done leaf", status: "done", projectId: "p1" },
    { id: "t2", title: "open leaf", status: "todo", projectId: "p1" },
  ], plans: [{ id: "pl1", projectId: "p1", status: "validated", decisions: "esm only", objective: "portal plan" }] };
  const { h } = makeCtx(st);
  const d = h.projectView(proj);
  assert.ok(d.html.includes("Portal"), "the name renders");
  assert.ok(d.html.includes(">1/2 " + CATALOG.en["project.done"] + "<"), "the honest rollup renders unchanged");
  const head = d.children[0];
  assert.ok(head.html.includes("id=phead"), "the header is the first child — right under the name");
  const [stateRow, objWrap, dec] = head.children;
  const sel = stateRow.children[0];   // the label span lives in the row's html; the select is appended
  assert.equal(sel.value, "active", "the real state is selected");
  assert.ok(sel.html.includes('value="active" selected'), "…marked selected in the markup");
  assert.ok(sel.html.includes('<option value="">—</option>'), "the honest unset placeholder exists");
  for (const sname of ["planned", "active", "done"])
    assert.ok(sel.html.includes(CATALOG.en["project.state." + sname]), `the ${sname} option is localized`);
  assert.ok(htmlOf(objWrap).includes("ship v1 of the portal"), "the objective renders");
  assert.ok(htmlOf(dec).includes("esm only"), "the binding decisions render");
  assert.ok(htmlOf(dec).includes(CATALOG.en["plan.status.validated"]), "…with the plan's real status");
});

test("an old project (no fields) renders honestly: '—' selected, empty hint, no decisions, nothing fabricated", () => {
  const proj = { id: "p0", name: "Legacy", kind: "project" };   // neither state nor objective — like pre-header records
  const { h } = makeCtx({ projects: [proj], tasks: [], plans: [] });
  const head = h.projectHeader({}, proj);
  assert.equal(head.children.length, 2, "state row + objective only — no decisions section");
  const sel = head.children[0].children[0];
  assert.equal(sel.value, "", "unset stays unset — the placeholder is selected");
  assert.ok(!sel.html.includes("selected"), "no state option is fabricated as selected");
  assert.ok(htmlOf(head.children[1]).includes(CATALOG.en["project.objective.empty"]), "the empty objective hint shows");
  // …and stale/garbage stored data can never fabricate a state either.
  assert.equal(h.projectStateSel({ id: "p9", state: "bogus" }).value, "", "an unknown stored state falls back to '—'");
  // projectView renders the old record without crashing and keeps the 0-rollup honest.
  const d = h.projectView(proj);
  assert.ok(d.html.includes(">0/0 " + CATALOG.en["project.done"] + "<") || d.html.includes(">0/0<") || d.html.includes("0/0"),
    "an empty project shows 0/0");
});

test("edit flow: the state select and the objective editor post the right payloads; errors surface", async () => {
  const proj = { id: "p1", name: "Portal", state: "planned", objective: "old objective" };
  let failNext = false;
  const { sandbox, h, calls } = makeCtx({ projects: [proj] }, "en",
    async () => (failNext ? { error: "unknown project state" } : { projects: [{ ...proj, state: "done" }] }));

  // state select: pick a state → posts it; pick '—' → posts null (clears).
  const sel = h.projectStateSel(proj);
  sel.value = "done";
  await sel.onchange();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/update", { id: "p1", state: "done" }], "a pick posts the state");
  assert.equal(sandbox.__renders, 1, "a saved state re-renders from the server state");
  sel.value = "";
  await sel.onchange();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/update", { id: "p1", state: null }], "'—' clears the state");
  // a server error surfaces and the UI never claims a save.
  failNext = true;
  const before = sandbox.__renders;
  sel.value = "active";
  await sel.onchange();
  assert.equal(sandbox.__alerts.at(-1), "unknown project state", "the error is surfaced");
  assert.equal(sandbox.__renders, before, "no fake re-render on a refused save");
  failNext = false;

  // objective: view → edit → textarea prefilled → save posts the text; '' clears.
  const wrap = h.projectObjective(proj);
  const view = wrap.children[0];
  assert.ok(htmlOf(view).includes("old objective"), "the current objective shows in view mode");
  const editBtn = view.children[2];
  assert.ok(editBtn.html.includes(CATALOG.en["project.edit"]), "the edit affordance is localized");
  editBtn.onclick();
  const form = wrap.children[0];
  const [ta, save, cancel, msg] = form.children;
  assert.equal(ta.value, "old objective", "the editor starts from the real objective");
  ta.value = "  the new objective  ";
  await save.onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/project/update", { id: "p1", objective: "  the new objective  " }],
    "the save posts exactly what was typed (the server trims)");
  assert.equal(sandbox.__renders, 3, "a saved objective re-renders from the server state");
  // an error surfaces IN PLACE and nothing re-renders.
  failNext = true;
  ta.value = "still broken";
  await save.onclick();
  assert.equal(msg.textContent, "unknown project state", "the server error shows next to the editor");
  assert.equal(sandbox.__renders, 3, "no fake re-render on a refused objective save");
  failNext = false;
  // cancel returns to the view without posting.
  const callsBefore = calls.length;
  cancel.onclick();
  assert.equal(calls.length, callsBefore, "cancel never posts");
  assert.ok(htmlOf(wrap.children[0]).includes("old objective"), "cancel returns to the honest view");
});

test("DECISIONS: only the LATEST validated/materialized plan binds — a draft is never binding", () => {
  const proj = { id: "p1", name: "Portal" };
  const { h } = makeCtx();
  const plans = (...ps) => ({ plans: ps });
  const P = (id, status, decisions, extra = {}) => ({ id, projectId: "p1", status, decisions, objective: id, ...extra });

  assert.equal(h.projectDecisions(plans(), proj), null, "no plan → no section");
  assert.equal(h.projectDecisions(plans(P("d1", "draft", "draft decisions")), proj), null,
    "a DRAFT's decisions are NOT binding — never shown");
  assert.equal(h.projectDecisions(plans(P("r1", "rejected", "rejected decisions")), proj), null,
    "a rejected plan's decisions are not binding either");

  const v = h.projectDecisions(plans(P("v1", "validated", "validated decisions")), proj);
  assert.ok(htmlOf(v).includes("validated decisions"), "a validated plan's decisions are binding");
  const m = h.projectDecisions(plans(P("m1", "materialized", "materialized decisions", { taskIds: ["t1"] })), proj);
  assert.ok(htmlOf(m).includes("materialized decisions"), "a materialized plan's decisions stay binding");

  // The LATEST such plan wins — and a draft on top changes nothing.
  const latest = h.projectDecisions(plans(
    P("v1", "validated", "old decisions"),
    P("v2", "validated", "the current decisions"),
    P("d9", "draft", "draft on top")), proj);
  assert.ok(htmlOf(latest).includes("the current decisions"), "the latest validated plan binds");
  assert.ok(!htmlOf(latest).includes("old decisions") && !htmlOf(latest).includes("draft on top"),
    "…never the older plan's, never the draft's");

  // The latest validated plan having NO decisions → no section (honest), even if an older one had some.
  assert.equal(h.projectDecisions(plans(P("v1", "validated", "old decisions"), P("v2", "validated", null)), proj), null,
    "decisions come from the LATEST such plan — an older plan's never substitute");
  // Another project's plan never leaks in.
  assert.equal(h.projectDecisions(plans({ id: "x", projectId: "other", status: "validated", decisions: "alien" }), proj), null);
  // The section is wired into the header only when present.
  const withDec = h.projectHeader(plans(P("v1", "validated", "shared choices")), proj);
  assert.equal(withDec.children.length, 3, "header = state + objective + decisions");
  assert.equal(h.projectHeader(plans(), proj).children.length, 2, "no plan → the section is absent, no empty chrome");
});

test("rollup regression: a parent with an open subtask NEVER counts done (the math is untouched)", () => {
  const proj = { id: "p1", name: "Portal" };
  const st = { projects: [proj], tasks: [
    { id: "tp", title: "parent", status: "done", projectId: "p1" },
    { id: "ts", title: "open sub", status: "todo", projectId: "p1", parentId: "tp" },
    { id: "tl", title: "done leaf", status: "done", projectId: "p1" },
  ] };
  const { h } = makeCtx(st);
  const d = h.projectView(proj);
  assert.ok(d.html.includes(">1/3 " + CATALOG.en["project.done"] + "<"),
    "the done parent with an open subtask is NOT counted (naive math would say 2/3)");
  assert.ok(!d.html.includes("2/3"), "never the naive count");
  // …and once the subtask is done, the parent counts again.
  const st2 = { ...st, tasks: st.tasks.map((t) => (t.id === "ts" ? { ...t, status: "done" } : t)) };
  const d2 = makeCtx(st2).h.projectView(proj);
  assert.ok(d2.html.includes(">3/3 " + CATALOG.en["project.done"] + "<"), "all done → 3/3");
  // source pin: the rollup math line is byte-identical to the reviewed one.
  const pv = SHELL_PAGE.slice(SHELL_PAGE.indexOf("function projectView("), SHELL_PAGE.indexOf("// ── settings:"));
  assert.ok(pv.includes("const doneN=flat.filter(x=>x.status==='done'&&!tasks.some(y=>y.parentId===x.id&&y.status!=='done')).length"),
    "the honest rollup math is untouched");
  assert.ok(pv.includes("d.appendChild(projectHeader(s,proj))"), "the header is wired into the project view");
});

test("XSS sweep: project name, objective and decisions can never inject markup", () => {
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const EVIL2 = '"><script>alert(2)</script>';
  const proj = { id: "p1", name: EVIL, objective: EVIL2, state: "active" };
  const st = { projects: [proj], tasks: [], plans: [{ id: "pl", projectId: "p1", status: "materialized", decisions: EVIL }] };
  const { h } = makeCtx(st);
  const all = htmlOf(h.projectView(proj)) + htmlOf(h.projectHeader(st, proj));
  assert.ok(!all.includes(EVIL), "no raw payload anywhere in the header");
  assert.ok(!all.includes(EVIL2), "no raw payload anywhere in the header");
  assert.ok(all.includes(esc(EVIL)) && all.includes(esc(EVIL2)), "the payloads show as escaped text");
  // The state value is enum-guarded — even an injected 'state' string cannot reach the markup.
  const sel = h.projectStateSel({ id: "p1", state: EVIL });
  assert.ok(!sel.html.includes(EVIL) && sel.value === "", "a bogus stored state renders as unset");
});

test("i18n parity (fr/de) for the new keys; the header localizes for real; the page parses", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  const KEYS = ["project.state", "project.state.planned", "project.state.active", "project.state.done",
    "project.objective", "project.objective.empty", "project.edit", "project.decisions"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);

  const proj = { id: "p1", name: "Portail" };
  const st = { plans: [{ id: "pl", projectId: "p1", status: "validated", decisions: "esm seulement" }] };
  const fr = makeCtx(st, "fr").h.projectHeader(st, proj);
  assert.ok(htmlOf(fr).includes(CATALOG.fr["project.state"]), "fr: the state label is French");
  assert.ok(htmlOf(fr).includes(CATALOG.fr["project.objective.empty"]), "fr: the empty hint is French");
  assert.ok(htmlOf(fr).includes(CATALOG.fr["project.decisions"]), "fr: the decisions label is French");
  const de = makeCtx(st, "de").h.projectHeader(st, proj);
  assert.ok(htmlOf(de).includes(CATALOG.de["project.state.planned"]), "de: the state options are German");
  assert.ok(htmlOf(de).includes(CATALOG.de["project.decisions"]), "de: the decisions label is German");

  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard — a template-literal slip can never blank the page
});
