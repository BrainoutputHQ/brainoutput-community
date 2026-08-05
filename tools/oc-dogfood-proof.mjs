#!/usr/bin/env node
// Dogfood EXTENSION — closes the three gaps the first dogfood left open:
//   A. a real REVIEW VERDICT on real evidence (diff + test exit code), not just "the worker ran"
//   B. the fail-closed SKILLS DIRECTIVE gate, against OpenCode's live registry
//   C. worker ESCALATION (a question / a permission outside the workspace grant)
//
// Everything runs against a live CE server on an isolated store, with a real model. Nothing here
// modifies product code; a failure is a finding, not something to route around.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PORT = Number(process.env.BO_CE_WEB_PORT || (20000 + crypto.randomInt(0, 20000)));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), "bo-proof-data-"));
const TASK_WAIT_MS = Number(process.env.BO_PROOF_TASK_WAIT_MS || 900000);

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${ts()}]`, ...a);
const section = (n) => console.log(`\n${"=".repeat(72)}\n${n}\n${"=".repeat(72)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
function finding(name, ok, evidence) {
  findings.push({ name, ok, evidence });
  console.log(`[${ts()}] ${ok ? "PROVEN " : "FAILED "} — ${name}`);
  if (evidence) console.log(`    ${String(evidence).split("\n").join("\n    ")}`);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch {}
  return { status: res.status, json, text };
}

let srv = null;
function startServer() {
  srv = spawn(process.execPath, [join(ROOT, "web-server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PWD: ROOT, BO_CE_DATA: DATA_DIR, BO_CE_WEB_PORT: String(PORT),
           BO_CE_OPENCODE_SERVER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  srv.stdout.on("data", (d) => (out += d));
  srv.stderr.on("data", (d) => (out += d));
  return () => out;
}
function stopServer() { try { srv?.kill("SIGTERM"); } catch {} }

async function waitForServer(ms = 25000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const r = await api("GET", "/api/state"); if (r.status === 200) return r.json; } catch {}
    if (Date.now() > deadline) throw new Error("CE server never came up");
    await sleep(300);
  }
}

/** Discover a REAL skill name from a standalone `opencode serve` — never hardcode one. */
async function discoverRealSkill() {
  const dir = mkdtempSync(join(tmpdir(), "bo-proof-skill-"));
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "allow", write: "allow", bash: "allow" },
  }));
  const bin = process.env.BO_OPENCODE_BIN || join(process.env.HOME, ".opencode", "bin", "opencode");
  const p = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"],
    { cwd: dir, env: { ...process.env, PWD: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", url = null;
  const scan = (c) => { buf += c; const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) url = m[0]; };
  p.stdout.on("data", scan); p.stderr.on("data", scan);
  try {
    for (let i = 0; i < 60 && !url; i++) await sleep(250);
    if (!url) return null;
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch(`${url}/api/skill`, { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        const names = (j?.data || []).map((x) => x.name).filter(Boolean);
        if (names.length) return names[0];
      } catch {}
      await sleep(300);
    }
    return null;
  } finally { try { p.kill("SIGTERM"); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

/** Plan → validate → materialize one task, then launch it and wait for a terminal state. */
async function runTask({ projectId, title, objective, acceptanceCriteria, skills, agentSlot, waitMs = TASK_WAIT_MS }) {
  const draft = { title, objective, acceptanceCriteria, priority: "high" };
  if (skills) draft.skills = skills;
  if (agentSlot) draft.agentSlot = agentSlot;
  const pn = await api("POST", "/api/plan/new", { projectId, objective: title, taskDrafts: [draft] });
  const plan = pn.json?.plan;
  if (!plan) throw new Error(`plan/new failed: ${pn.status} ${pn.text.slice(0, 200)}`);
  await api("POST", "/api/plan/validate", { id: plan.id });
  const mat = await api("POST", "/api/plan/materialize", { id: plan.id });
  const task = (mat.json?.tasks || [mat.json?.task]).filter(Boolean)[0];
  if (!task) throw new Error(`materialize failed: ${mat.status} ${mat.text.slice(0, 200)}`);

  const launchedAt = Date.now();
  const launch = await api("POST", "/api/task/launch", { id: task.id, timeoutMs: waitMs, maxTokens: 2000 });
  // A non-200 is a REFUSAL, which for the gate scenarios is exactly what we are measuring — return
  // it as a result rather than treating it as a driver failure.
  if (launch.status !== 200) {
    return { refusedAtLaunch: true, launchStatus: launch.status,
             launchError: String(launch.json?.error || launch.text).slice(0, 300),
             task: null, exec: null, elapsedMs: Date.now() - launchedAt, workspace: null };
  }

  const deadline = Date.now() + waitMs;
  let final = null;
  for (;;) {
    const st = await api("GET", "/api/state");
    final = (st.json?.tasks || []).find((t) => t.id === task.id) || null;
    if (final && (final.status === "done" || final.status === "blocked")) break;
    if (Date.now() > deadline) break;
    await sleep(3000);
  }
  const execs = (await api("GET", "/api/state")).json?.executions || [];
  const exec = execs.find((e) => e.id === launch.json?.execution?.id) || null;
  return { task: final, exec, elapsedMs: Date.now() - launchedAt, workspace: join(DATA_DIR, "workspaces", launch.json?.execution?.id || "") };
}

async function main() {
  const getLog = startServer();
  try {
    section("SETUP — CE server, company, model, slots, project");
    const state = await waitForServer();
    log("codingRuntime:", JSON.stringify(state?.codingRuntime));

    await api("POST", "/api/onboard", {
      companyName: "Proof Co", companyDoes: "closing the dogfood gaps", departments: ["technical"],
    });
    const conn = await api("POST", "/api/connect-runtime", {
      runtime: "local-openai", authSource: "local", provider: "brainoutput-local", model: "coder",
      endpoint: "http://192.168.1.14:9000/v1/chat/completions", modelLocation: "local",
    });
    const c = (conn.json?.connections || []).find((x) => x.provider === "brainoutput-local" && x.model === "coder");
    if (!c) throw new Error("model connection failed");
    await api("POST", "/api/assign", { slot: "coding-free", connectionId: c.id });
    await api("POST", "/api/assign", { slot: "high-trust-review", connectionId: c.id });
    const proj = await api("POST", "/api/project", { name: "oc-proof-project" });
    const projectId = proj.json?.project?.id;
    log("project:", projectId, "| connection:", c.id);

    // ── B1: an UNKNOWN skill must be refused fail-closed, fast, without ever prompting ─────────
    section("B1 — unknown skill directive must FAIL CLOSED (and must be fast: no model call)");
    const b1 = await runTask({
      projectId, title: "B1: unknown skill directive",
      objective: "Write nothing. This task exists to exercise the skills gate.",
      acceptanceCriteria: ["never reached — the directive gate must refuse first"],
      skills: ["definitely-not-a-real-skill-xyz"], waitMs: 120000,
    });
    const b1note = b1.refusedAtLaunch ? b1.launchError
      : String(b1.task?.review?.note || b1.task?.result?.summary || "");
    finding("an unknown skill directive is refused fail-closed, never routed to a default",
      (b1.refusedAtLaunch && /skill/i.test(b1note)) || (b1.task?.status === "blocked" && /skill/i.test(b1note)),
      `refusedAtLaunch=${!!b1.refusedAtLaunch} status=${b1.launchStatus || b1.task?.status} ` +
      `elapsed=${(b1.elapsedMs / 1000).toFixed(1)}s\nreason: ${b1note.slice(0, 260)}`);
    finding("the refusal costs NO model call (sub-30s on a box where one turn takes minutes)",
      b1.elapsedMs < 30000, `elapsed ${(b1.elapsedMs / 1000).toFixed(1)}s`);

    // ── B2: a REAL skill from the live registry must be accepted ───────────────────────────────
    section("B2 — a CE-accepted skill: does the OpenCode registry gate then refuse it?");
    // CE's router accepts: node-esm, browser-js, connectors, docs, ops, research, i18n, review.
    // OpenCode's own registry contains entirely different names (e.g. customize-opencode). If the
    // OpenCode gate refuses a CE-legal skill, then skills routing is unusable end to end — which is
    // exactly the kind of thing only a real run can tell us.
    const ocSkill = await discoverRealSkill();
    log("OpenCode registry sample skill:", ocSkill);
    const b2 = await runTask({
      projectId, title: "B2: CE-accepted skill directive",
      objective: "Create a file skillcheck.txt containing exactly: ok",
      acceptanceCriteria: ["skillcheck.txt exists and contains exactly: ok"],
      skills: ["node-esm"], waitMs: 300000,
    });
    const b2note = b2.refusedAtLaunch ? b2.launchError
      : String(b2.task?.review?.note || b2.task?.result?.summary || "");
    const refusedByOcGate = /not present in|unknown (skill|agent)|registry/i.test(b2note);
    finding("a CE-legal skill ('node-esm') survives the OpenCode registry gate", !refusedByOcGate,
      `refusedAtLaunch=${!!b2.refusedAtLaunch} status=${b2.launchStatus || b2.task?.status} ` +
      `elapsed=${(b2.elapsedMs / 1000).toFixed(1)}s\nOpenCode registry sample: ${ocSkill}\n` +
      `reason: ${b2note.slice(0, 260)}`);

    // ── A: a real review verdict on real evidence ──────────────────────────────────────────────
    section("A — a REAL review verdict on real evidence (diff + test exit code)");
    const a = await runTask({
      projectId, title: "A: tested add() utility",
      objective: "Create a tiny Node.js ESM utility: write add-lib.mjs exporting a function add(a, b) " +
        "that returns a + b, and write test/add.test.mjs using node:test + node:assert asserting " +
        "add(2, 3) === 5 and add(-1, 1) === 0. No other files.",
      acceptanceCriteria: [
        "add-lib.mjs exists and exports a function add(a,b) that returns a+b",
        "test/add.test.mjs exists, uses node:test, and asserts add(2,3)===5 and add(-1,1)===0",
      ],
    });
    const rv = a.task?.review || null;
    const libPath = join(a.workspace, "add-lib.mjs");
    const libOk = existsSync(libPath) && /function add/.test(readFileSync(libPath, "utf8"));
    finding("the worker wrote the requested files", libOk,
      libOk ? readFileSync(libPath, "utf8").slice(0, 120) : `missing at ${libPath}`);
    finding("a JUDGED review verdict was recorded (by:'reviewer', with per-criterion verdicts)",
      rv?.by === "reviewer" && Array.isArray(rv?.criteria) && rv.criteria.length > 0,
      `status=${a.task?.status} elapsed=${(a.elapsedMs / 1000).toFixed(1)}s\n` +
      `review: by=${rv?.by} ok=${rv?.ok}\nnote: ${String(rv?.note || "").slice(0, 200)}\n` +
      (rv?.criteria || []).map((x) => `  - ${x.verdict}: ${String(x.criterion).slice(0, 60)}`).join("\n"));

    // ── C: escalation — a question the plan's decisions cannot answer ──────────────────────────
    section("C — worker escalation (best effort: the model must choose to ask)");
    const cRun = await runTask({
      projectId, title: "C: ambiguous task that should provoke a question",
      objective: "Add the company's official retry limit to config.mjs as `export const RETRY_LIMIT`. " +
        "The exact number is an internal policy value that is not stated anywhere in this task or the repo.",
      acceptanceCriteria: ["config.mjs exports RETRY_LIMIT set to the company's official policy value"],
      waitMs: 300000,
    });
    const cnote = String(cRun.task?.review?.note || cRun.task?.result?.summary || "");
    const asked = !!cRun.task?.pendingQuestion || /question|escalat/i.test(cnote);
    finding("an uncovered question escalates rather than being guessed (best effort)", asked,
      `status=${cRun.task?.status} pendingQuestion=${JSON.stringify(cRun.task?.pendingQuestion || null)}\n` +
      `note: ${cnote.slice(0, 220)}\n(if not asked: the model chose to assume — a model behaviour, not a gate defect)`);

    section("SUMMARY");
    for (const f of findings) console.log(`${f.ok ? "PROVEN " : "FAILED "} — ${f.name}`);
    console.log(`\n${findings.filter((f) => f.ok).length}/${findings.length} proven`);
  } catch (e) {
    console.error("\nPROOF DRIVER ERROR:", e?.stack || e);
    console.error("server log tail:\n", getLog().slice(-1500));
    process.exitCode = 1;
  } finally {
    stopServer();
    await sleep(500);
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

await main();
