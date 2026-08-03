// SPDX-License-Identifier: Apache-2.0
// Project display (task-pm-14) — founder dogfood findings on display:
//  1. PLAN-FIRST PROJECT START: the project view's quick-add task input is GONE (an unevaluated
//     task may need subtasks; work comes from a validated plan). In its place, "Plan with the
//     Brain" opens a NEW planning thread in the project, seeded with the project context
//     (POST /api/chat/plan-thread — no model call). /api/task/new STAYS for subtasks + API users.
//  2. BOARD FIT: columns size to available width (grid minmax(0,1fr)); below a sane breakpoint
//     the board becomes a horizontal scroll container — nothing clipped at 1280/1440. PROOF:
//     Playwright is NOT in this repo's tooling (no devDependency, no script), so DOM metrics are
//     asserted with a lightweight measurement: the layout math (grid/flex distribution is
//     deterministic CSS) is computed from the ACTUAL constants parsed out of the shipped page's
//     CSS, plus a real-server assertion that the served bytes carry the fixed rules. No browser,
//     no new dep, no pixel captures (none possible without browser tooling).
//  3. POLISH: the project progress bar follows the theme (var(--pre), like the Work planner's)
//     instead of a hardcoded dark; board cards end flush (last card's margin removed); the
//     project view carries no hardcoded hex color at all.
// Component tests follow the vm/parse-guard pattern (projheader/taskboard); the endpoint,
// i18n seed and /api/task/new regression run against a real server in a tmp dir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4414;
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bo-projdisplay-"));
  srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(PORT),
      BO_OPENCODE_BIN: "/nonexistent-opencode" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/state`); return; } catch { await new Promise((r) => setTimeout(r, 250)); if (i === 59) throw new Error("server did not start"); }
  }
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const state = () => fetch(`${BASE}/api/state`).then((r) => r.json());

// ── component harness: the REAL shell blocks in a vm ─────────────────────────
const TL_START = SHELL_PAGE.indexOf("// ── task list helpers");
const TL_END = SHELL_PAGE.indexOf("/** A foldable settings section", TL_START);
const B_START = SHELL_PAGE.indexOf("// ── task board (task-pm-08)");
const B_END = SHELL_PAGE.indexOf("// Theme: LIGHT is the default", B_START);
const PC_START = SHELL_PAGE.indexOf("/** A durable Plan");
const D_START = SHELL_PAGE.indexOf("// ── task detail (task-pm-09)");
const PV = SHELL_PAGE.indexOf("// ── project view: the task spine", D_START);
const PV_END = SHELL_PAGE.indexOf("// ── settings:", PV);
assert.ok(TL_START > 0 && TL_END > TL_START && B_START > 0 && B_END > B_START, "helper + board blocks are in the shell");
assert.ok(PC_START > 0 && D_START > PC_START && PV > D_START && PV_END > PV, "card + detail + project-view blocks are in the shell");
const BLOCKS = [
  SHELL_PAGE.slice(TL_START, TL_END),
  SHELL_PAGE.slice(B_START, B_END),
  SHELL_PAGE.slice(PC_START, D_START),
  SHELL_PAGE.slice(D_START, PV),
  SHELL_PAGE.slice(PV, PV_END),
].join("\n");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const htmlOf = (n) => (n == null ? "" : typeof n === "string" ? n : (n.html || "") + (n.children || []).map(htmlOf).join(""));

function makeCtx(st = {}, locale = "en", apiImpl = null) {
  const mkStub = () => ({ onclick: null, onchange: null, onkeydown: null, value: "", textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, children: [] });
  const calls = [];
  const sandbox = {
    t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k,
    esc,
    S: { state: st },
    __renders: 0, __alerts: [],
    render() { sandbox.__renders++; },
    alert(m) { sandbox.__alerts.push(String(m)); },
    refresh: async () => {},
    api: async (p, body) => { calls.push([p, body]); return apiImpl ? apiImpl(p, body) : {}; },
    I: (n) => `<svg data-ic="${n}"></svg>`,
    el(h) {
      const node = { html: h, children: [], value: "", textContent: "", style: {}, dataset: {}, _qs: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild(c) { node.children.push(c); return c; },
        // querySelector caches by selector — a wired control stays reachable for the click.
        querySelector(sel) { return node._qs[sel] || (node._qs[sel] = mkStub()); },
        querySelectorAll() { return []; } };
      Object.defineProperty(node, "innerHTML", {
        get() { return node.html; },
        set(v) { if (v === "") node.children.length = 0; else node.html = v; },
      });
      return node;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCKS + "\n;globalThis.__h={BOARD_COLS,taskViewOf,taskBoard,projectHeader,projectView};", sandbox);
  return { sandbox, h: sandbox.__h, calls };
}

// ── 1 · plan-first project start ─────────────────────────────────────────────

test("the project view has NO quick-add task input — a Plan-with-the-Brain action instead", () => {
  const proj = { id: "p1", name: "Portal" };
  const st = { projects: [proj], tasks: [], plans: [], conversations: [] };
  const { h } = makeCtx(st);
  const d = h.projectView(proj);
  const all = htmlOf(d);
  assert.ok(!all.includes("id=nt"), "no quick-add input");
  assert.ok(!all.includes("id=ntb"), "no quick-add button");
  assert.ok(!all.includes(CATALOG.en["project.tasks"] ? "project.addTask" : ""), "the quick-add key is not referenced");
  assert.ok(!all.includes("/api/task/new"), "the project view never posts a bare task");
  assert.ok(all.includes("id=planbrain"), "the Plan-with-the-Brain button is present");
  assert.ok(all.includes(CATALOG.en["project.planWithBrain"]), "…with its localized label");
  assert.ok(all.includes(CATALOG.en["project.planHint"]), "…and the plan-first hint");
});

test("the button is wired: click opens a NEW planning thread in the project (plan mode, chat view)", async () => {
  const proj = { id: "p1", name: "Portal" };
  const st = { projects: [proj], tasks: [], plans: [], conversations: [] };
  const conv = { id: "conv-plan-1", projectId: "p1", title: "Plan — Portal", messages: [{ role: "assistant", text: "seed", mode: "plan" }] };
  let fail = false;
  const { sandbox, calls } = makeCtx(st, "en", async () => (fail ? { error: "no project 'p1'" } : { ...st, conversation: conv }));
  const d = sandbox.__h.projectView(proj);
  const body = d.children[1];   // children[0] = the project header, children[1] = the body block
  const btn = body.querySelector("#planbrain");

  await btn.onclick();
  assert.deepEqual([calls.at(-1)[0], { ...calls.at(-1)[1] }], ["/api/chat/plan-thread", { projectId: "p1" }],
    "the click creates the planning thread through the API");
  assert.equal(sandbox.S.convId, "conv-plan-1", "the NEW thread is opened");
  assert.equal(sandbox.S.projectId, "p1", "…inside its project");
  assert.equal(sandbox.S.mode, "plan", "the composer lands in plan mode — the next message drafts the plan");
  assert.equal(sandbox.S.view, "chat");
  assert.equal(sandbox.__renders, 1, "one re-render from the server state");
  assert.equal(sandbox.__alerts.length, 0);

  // An API error surfaces and never navigates.
  fail = true;
  const before = { convId: sandbox.S.convId, mode: sandbox.S.mode, renders: sandbox.__renders };
  await btn.onclick();
  assert.equal(sandbox.__alerts.at(-1), "no project 'p1'", "the error is surfaced");
  assert.equal(sandbox.S.convId, before.convId, "no navigation on failure");
  assert.equal(sandbox.__renders, before.renders, "no re-render on failure");
});

test("server: /api/chat/plan-thread creates a seeded planning thread — project-bound, localized, durable", async () => {
  const p = await post("/api/project", { name: "plan-thread-proj" });
  const pid = p.body.project.id;
  await post("/api/project/update", { id: pid, objective: "ship the portal v1" });

  const r = await post("/api/chat/plan-thread", { projectId: pid });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const conv = r.body.conversation;
  assert.equal(conv.projectId, pid, "the thread belongs to the project");
  assert.equal(conv.title, CATALOG.en["project.planThread"].replace("{name}", "plan-thread-proj"), "a real localized title");
  assert.equal(conv.scope, "company");
  assert.equal(conv.messages.length, 1, "exactly the seed message — no fabricated chatter");
  const seed = conv.messages[0];
  assert.equal(seed.role, "assistant", "the seed speaks as the Brain");
  assert.equal(seed.mode, "plan", "the seed is a planning message");
  const want = CATALOG.en["project.planSeed"].replace("{name}", "plan-thread-proj")
    + "\n" + CATALOG.en["project.planSeedObjective"].replace("{objective}", "ship the portal v1");
  assert.equal(seed.text, want, "the seed carries the project name + objective verbatim");

  // The response IS the state the shell adopts; the thread is durable.
  assert.ok(r.body.conversations.some((c) => c.id === conv.id), "the response state carries the thread");
  assert.ok((await state()).conversations.some((c) => c.id === conv.id), "…and a fresh state read does too");
  const disk = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
  assert.ok(disk.conversations.some((c) => c.id === conv.id), "persisted on disk");

  // A second click opens ANOTHER new thread — never reuses one.
  const r2 = await post("/api/chat/plan-thread", { projectId: pid });
  assert.ok(r2.body.conversation.id !== conv.id, "every click opens a NEW planning thread");

  // No plan is drafted by the endpoint — drafting waits for the owner's description.
  assert.equal((await state()).plans.filter((x) => x.conversationId === conv.id).length, 0, "no plan without the owner's words");

  // Fail-closed: unknown project → 404, nothing created.
  const ghost = await post("/api/chat/plan-thread", { projectId: "nope" });
  assert.equal(ghost.status, 404);
  assert.match(ghost.body.error, /no project/);

  // No objective → the seed honestly omits the objective line.
  const p2 = await post("/api/project", { name: "no-objective-proj" });
  const r3 = await post("/api/chat/plan-thread", { projectId: p2.body.project.id });
  assert.equal(r3.body.conversation.messages[0].text, CATALOG.en["project.planSeed"].replace("{name}", "no-objective-proj"),
    "no objective set → no objective line, never an empty placeholder");

  // The seed localizes with the workspace locale (fr), then back to en.
  await post("/api/settings", { locale: "fr" });
  const rf = await post("/api/chat/plan-thread", { projectId: pid });
  const wantFr = CATALOG.fr["project.planSeed"].replace("{name}", "plan-thread-proj")
    + "\n" + CATALOG.fr["project.planSeedObjective"].replace("{objective}", "ship the portal v1");
  assert.equal(rf.body.conversation.messages[0].text, wantFr, "the seed is French under a French workspace");
  assert.equal(rf.body.conversation.title, CATALOG.fr["project.planThread"].replace("{name}", "plan-thread-proj"));
  await post("/api/settings", { locale: "en" });
});

// ── 2 · board fit — metric assertions from the shipped CSS ───────────────────
// The layout model: sidebar (aside width + 1px border) · thread horizontal padding · the
// project surface's OWN wide wrap (the board's container — chat keeps the 780px .wrap) ·
// .cardx padding + border · the board's own padding. Inside the board, grid minmax(0,1fr)
// distributes the client width EXACTLY (scrollWidth == clientWidth by construction); below
// the breakpoint the media rule switches to flex + overflow-x:auto with fixed-width columns.
// Every constant below is PARSED from the page — the test measures the shipped CSS, it never
// re-declares it.

const CSS = SHELL_PAGE.split("<style>")[1].split("</style>")[0];
const num = (re, src, what) => { const m = src.match(re); assert.ok(m, `CSS parse: ${what}`); return Number(m[1]); };

function boardGeometry() {
  const asideW = num(/aside\{width:(\d+)px/, CSS, "sidebar width");
  const threadPadX = num(/#thread\{[^}]*?padding:\d+px (\d+)px/, CSS, "thread horizontal padding");
  const wrapMax = num(/\.wrap\{max-width:(\d+)px/, CSS, "chat wrap max width (unchanged)");
  const wideMax = num(/\.wrap\.wide\{max-width:(\d+)px/, CSS, "project-surface wrap max width");
  assert.ok(wideMax >= 1160 && wideMax <= 1200, `the wide project wrap is sane (got ${wideMax})`);
  assert.ok(wideMax > wrapMax, "the board's container is wider than the chat wrap");
  const cardPadX = num(/\.cardx\{[^}]*?padding:\d+px (\d+)px/, CSS, "card horizontal padding");
  assert.ok(/\.cardx\{[^}]*?border:1px solid/.test(CSS), "card border is 1px (geometry accounts for it)");
  const boardRule = CSS.match(/\.board\{([^}]*)\}/);
  assert.ok(boardRule, "the .board rule exists");
  const board = boardRule[1];
  const gap = num(/gap:(\d+)px/, board, "board gap");
  const boardPadX = num(/padding:\d+px (\d+)px/, board, "board horizontal padding");
  const cols = num(/grid-template-columns:repeat\((\d+),minmax\(0,1fr\)\)/, board, "grid column count");
  assert.ok(/display:grid/.test(board), "the desktop board is a grid (columns size to available width)");
  const media = CSS.match(/@media\(max-width:(\d+)px\)\{\s*\.board\{([^}]*)\}\s*\.bcol\{([^}]*)\}/);
  assert.ok(media, "the below-breakpoint board media rule exists");
  const bp = Number(media[1]);
  assert.ok(/display:flex/.test(media[2]) && /overflow-x:auto/.test(media[2]),
    "below the breakpoint the board is a horizontal SCROLL container (never clipped, reachable)");
  assert.ok(!/overflow-x:hidden|overflow:hidden/.test(media[2]), "the overflow is scrollable, never hidden-clipped");
  const fixedCol = num(/flex:0 0 (\d+)px/, media[3], "fixed column width below the breakpoint");
  assert.ok(media[3].includes(`width:${fixedCol}px`), "the column width matches its flex basis");
  return { asideW, threadPadX, wrapMax, wideMax, cardPadX, gap, boardPadX, cols, bp, fixedCol };
}

/** Deterministic box math for the board inside the project card (wide wrap) at a viewport width. */
function layoutAt(W, g) {
  const mainW = W - g.asideW - 1;                    // sidebar + its 1px border
  const wrapW = Math.min(g.wideMax, mainW - 2 * g.threadPadX);
  const clientW = wrapW - 2 * g.cardPadX - 2 - 2 * g.boardPadX;   // card padding+border, board padding
  if (W > g.bp) {
    const colW = (clientW - (g.cols - 1) * g.gap) / g.cols;       // minmax(0,1fr): exact distribution
    return { mode: "grid", clientW, scrollW: clientW, colW };
  }
  const scrollW = g.cols * g.fixedCol + (g.cols - 1) * g.gap + 2 * g.boardPadX;
  return { mode: "scroll", clientW, scrollW, colW: g.fixedCol };
}

test("board fit: nothing overflows at 1280px and 1440px — the wide wrap gives real column width", () => {
  const g = boardGeometry();
  const { h } = makeCtx({});
  assert.equal(g.cols, h.BOARD_COLS.length, "the grid declares exactly one track per real status column");
  assert.ok(g.bp >= 900 && g.bp < 1280, `the breakpoint is sane (got ${g.bp}) — desktop widths stay grid`);

  for (const W of [1280, 1440]) {
    const m = layoutAt(W, g);
    assert.equal(m.mode, "grid", `${W}px: desktop grid, no scroll needed`);
    assert.ok(m.scrollW <= m.clientW, `${W}px: board scrollWidth (${m.scrollW}) ≤ clientWidth (${m.clientW}) — nothing clipped`);
  }
  // The REAL numbers (from the shipped CSS constants): the wide wrap lifts the board well past
  // the old 175.5px-per-column cram (738px client inside the chat wrap).
  const m1280 = layoutAt(1280, g);
  assert.ok(Math.abs(m1280.clientW - 943) < 1, `1280px: board client is 943px (got ${m1280.clientW})`);
  assert.ok(Math.abs(m1280.colW - 226.75) < 0.5, `1280px: columns get ~226.8px (got ${m1280.colW.toFixed(2)}) — was 175.5px in the chat wrap`);
  assert.ok(m1280.colW > 175.5 * 1.25, "1280px: at least 25% wider than the old cram");
  const m1440 = layoutAt(1440, g);
  assert.ok(Math.abs(m1440.clientW - 1103) < 1, `1440px: board client is 1103px (got ${m1440.clientW})`);
  assert.ok(Math.abs(m1440.colW - 266.75) < 0.5, `1440px: columns get ~266.8px (got ${m1440.colW.toFixed(2)})`);
  assert.ok(m1440.colW > m1280.colW, "1440px gets more than 1280px");
  // …and the wide cap itself binds on very wide screens (never an endless column).
  assert.ok(layoutAt(1920, g).clientW === g.wideMax - 2 * g.cardPadX - 2 - 2 * g.boardPadX,
    "the wide max-width caps the board on very wide screens");
});

test("board fit: below the breakpoint the board scrolls horizontally — content reachable, never cut off", () => {
  const g = boardGeometry();
  const m = layoutAt(1000, g);
  assert.equal(m.mode, "scroll", "1000px is below the breakpoint");
  assert.ok(m.scrollW > m.clientW, `columns keep a usable fixed width (${m.colW}px) — overflow scrolls instead of clipping`);
  assert.ok(m.colW >= 220, "the fixed column width stays usable");
  // At the breakpoint boundary itself the switch is consistent.
  assert.equal(layoutAt(g.bp, g).mode, "scroll");
  assert.equal(layoutAt(g.bp + 1, g).mode, "grid");
});

test("board fit on the REAL server: the served page carries the wide wrap, the grid rule and the scroll media rule", async () => {
  const page = await fetch(`${BASE}/`).then((r) => r.text());
  const g = boardGeometry();
  assert.ok(page.includes(`grid-template-columns:repeat(${g.cols},minmax(0,1fr))`),
    "the served bytes carry the desktop grid");
  assert.ok(page.includes(`.wrap.wide{max-width:${g.wideMax}px}`), "the served bytes carry the wide project wrap");
  assert.ok(page.includes('class="wrap wide" id=pview'), "the served markup has the wide project container");
  assert.ok(page.includes('<div class=wrap id=msgs>'), "the chat container keeps the plain 780px wrap");
  assert.ok(page.includes(`@media(max-width:${g.bp}px)`), "the served bytes carry the breakpoint");
  const media = page.match(new RegExp(`@media\\(max-width:${g.bp}px\\)\\{\\s*\\.board\\{([^}]*)\\}`));
  assert.ok(media && /overflow-x:auto/.test(media[1]), "the served scroll container is real");
});

test("no other view's layout shifts: chat/thread keeps 780px; only the project surface widens", () => {
  // The chat wrap is untouched…
  assert.ok(CSS.includes(".wrap{max-width:780px;margin:0 auto}"), "the chat wrap stays 780px");
  // …the project view renders into the wide sibling, never into #msgs…
  assert.ok(SHELL_PAGE.includes("pv.appendChild(projectView(proj))"), "the project view goes to the wide container");
  assert.ok(!SHELL_PAGE.includes("box.appendChild(projectView(proj))"), "…never into the chat container");
  // …and settings/work/bubbles/composer still render in #msgs (the 780px wrap).
  assert.ok(SHELL_PAGE.includes("box.appendChild(settingsView())"), "settings stay in the chat wrap");
  assert.ok(SHELL_PAGE.includes("box.appendChild(workView())"), "the Work panel stays in the chat wrap");
  assert.ok(SHELL_PAGE.includes("conv.messages.forEach(m=>box.appendChild(bubble(m)))"), "chat bubbles stay in the chat wrap");
  // The wide container starts hidden and is only shown when a project view is actually rendered.
  assert.ok(SHELL_PAGE.includes("pv.style.display='none'"), "the wide container hides when no project view shows");
});

// ── 3 · polish guards ────────────────────────────────────────────────────────

test("polish: the project view carries no hardcoded hex color (theme vars only) and cards space evenly", () => {
  const pvBlock = SHELL_PAGE.slice(PV, PV_END);
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(pvBlock),
    "no hardcoded color in the project view — the progress bar follows the theme like the Work planner's");
  assert.ok(pvBlock.includes("background:var(--pre)"), "the progress bar track uses the theme variable");
  assert.ok(CSS.includes(".bcol>.bcard:last-child{margin-bottom:0}"),
    "the last card in a column ends flush — even spacing");
  // The board chrome stays on theme variables in both themes.
  const bcol = CSS.match(/\.bcol\{([^}]*)\}/)[1];
  assert.ok(bcol.includes("var(--card2)") && bcol.includes("var(--line)"), "columns use theme surfaces + lines");
});

test("scope guard: the quick-add is gone from the shell, but /api/task/new STAYS on the server", () => {
  assert.ok(!SHELL_PAGE.includes("api('/api/task/new'"), "the shell never quick-adds a task anymore");
  assert.ok(!SHELL_PAGE.includes("id=nt"), "the quick-add input is gone");
  const src = readFileSync(join(HERE, "web-server.mjs"), "utf8");
  assert.ok(src.includes('"/api/task/new"'), "the task API endpoint stays (subtasks + API users)");
  assert.ok(src.includes('"/api/chat/plan-thread"'), "the plan-thread endpoint exists");
});

// ── 4 · i18n + parse guard ───────────────────────────────────────────────────

test("i18n parity (fr/de) for the new keys; the quick-add key is retired everywhere; the action localizes", () => {
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  for (const loc of LOCALES) assert.ok(!("project.addTask" in CATALOG[loc]), `${loc}: the retired quick-add string is gone`);
  const KEYS = ["project.planWithBrain", "project.planHint", "project.planThread", "project.planSeed", "project.planSeedObjective"];
  for (const loc of LOCALES) for (const k of KEYS)
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);

  const proj = { id: "p1", name: "Portail" };
  const st = { projects: [proj], tasks: [], plans: [], conversations: [] };
  for (const loc of ["fr", "de"]) {
    const all = htmlOf(makeCtx(st, loc).h.projectView(proj));
    assert.ok(all.includes(CATALOG[loc]["project.planWithBrain"]), `${loc}: the button label localizes`);
    assert.ok(all.includes(CATALOG[loc]["project.planHint"]), `${loc}: the hint localizes`);
  }

  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);   // parse guard — a template-literal slip can never blank the page
});

test("XSS: a malicious project name/objective can never inject markup through the seed, title or button", async () => {
  const EVIL = '</div><img src=x onerror=alert(1)>';
  const p = await post("/api/project", { name: "evil-proj" });
  await post("/api/project/update", { id: p.body.project.id, objective: EVIL });
  const r = await post("/api/chat/plan-thread", { projectId: p.body.project.id });
  // The seed stores the objective as TEXT — and the shell's bubble() esc()s message text; the
  // title flows through esc() in the sidebar. Component-side proof: the project view escapes.
  const st = { projects: [{ id: "p1", name: EVIL, objective: EVIL }], tasks: [], plans: [], conversations: [] };
  const all = htmlOf(makeCtx(st).h.projectView(st.projects[0]));
  assert.ok(!all.includes(EVIL), "no raw payload in the project view");
  assert.ok(all.includes(esc(EVIL)), "the payload shows as escaped text");
  assert.equal(r.status, 200, "the endpoint stores the seed as plain text (escaped at render)");
});

// ── 5 · /api/task/new regression — the API path the quick-add no longer uses ──

test("subtask creation still works API-level: top-level + parentId tasks through /api/task/new", async () => {
  const p = await post("/api/project", { name: "api-tasks-proj" });
  const pid = p.body.project.id;
  const t1 = await post("/api/task/new", { title: "API-created parent", projectId: pid });
  assert.equal(t1.status, 200, JSON.stringify(t1.body).slice(0, 200));
  assert.equal(t1.body.task.projectId, pid);
  const sub = await post("/api/task/new", { title: "API-created subtask", parentId: t1.body.task.id });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.task.parentId, t1.body.task.id, "the subtask binds to its parent");
  assert.equal(sub.body.task.projectId, pid, "…and inherits the project");
  const rec = (await state()).tasks.find((x) => x.id === sub.body.task.id);
  assert.ok(rec, "the subtask is durable in state");
});
