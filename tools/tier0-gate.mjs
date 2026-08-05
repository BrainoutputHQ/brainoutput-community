#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TIER-0 GATE — the thing that actually enforces tier 0 in the pipeline.
//
// Why a poller and not a plugin: Paperclip's plugin SDK exposes environment/workspace provider
// hooks only (onRealizeWorkspace, leases, templates). There is NO issue- or run-lifecycle hook,
// so nothing can intercept "a reviewer is about to wake" and veto it. `events.subscribe` exists,
// but the emitted issue events are coarse (`issue.updated`, no status-change event), and a plugin
// could only ever be advisory — it cannot stop a wake.
//
// So the gate takes the one position from which it CAN enforce: it owns reviewer assignment.
// Nothing else assigns a reviewer. A worker marks its issue `done`; this gate is what decides
// whether a reviewer is ever woken.
//
//     worker finishes -> issue `done` -> THIS GATE runs tier0 against the real branch
//                                         |-- FAIL: comment the failing checks, hand the issue
//                                         |          back to the worker. NO model is woken.
//                                         '-- PASS: comment the evidence, assign the reviewer,
//                                                    set `in_review`, wake it.
//
// A tier-0 failure costs ~150ms instead of a multi-minute review call, and judgement adds nothing
// to "the branch is empty" or "it edited files it was told not to touch".
//
// Scope comes from a fenced block in the issue description — the orchestrator declares it when it
// decomposes. Absent, tier 0 still runs (empty-diff and tests) but cannot check scope:
//
//     ```tier0
//     expect: docs/**, tools/**
//     forbid: *.mjs
//     ```
//
// Usage:
//   node tools/tier0-gate.mjs --api http://127.0.0.1:3220 --company <id> --reviewer <agentId>
//                             [--once] [--interval 20]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const API = arg("api", "http://127.0.0.1:3220");
const COMPANY = arg("company");
const REVIEWER = arg("reviewer");
const ONCE = flag("once");
const INTERVAL = Number(arg("interval", "20")) * 1000;
const STATE = arg("state", join(HERE, ".tier0-gate-state.json"));
// Hard cap per pass. Pointing this at an existing backlog wakes a reviewer PER ISSUE — done once
// against 10 stale test issues it launched 9 concurrent model calls before anyone noticed. A gate
// that can spend unbounded money on its first run is not a safe gate. Raise deliberately.
const MAX_PER_PASS = Number(arg("max-per-pass", "3"));

if (!COMPANY || !REVIEWER) { console.error("usage: --company <id> --reviewer <agentId> [--once] [--interval 20]"); process.exit(2); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const api = async (method, path, body) => {
  const res = await fetch(API + path, { method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch {}
  return { status: res.status, ok: res.ok, json, text };
};
// This API is inconsistent: most endpoints wrap in {data}, the skills list returns a bare array.
const rows = (r) => Array.isArray(r.json) ? r.json : (r.json?.data ?? []);

// Dedupe on branch@SHA, not on issue id: a reworked branch MUST be re-gated, and a re-comment on
// an unchanged branch is pure noise.
function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } }
function saveState(s) { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function parseScope(description = "") {
  const m = description.match(/```tier0\s*([\s\S]*?)```/);
  if (!m) return { expect: null, forbid: null };
  const get = (k) => { const g = m[1].match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "mi")); return g ? g[1].trim() : null; };
  return { expect: get("expect"), forbid: get("forbid") };
}

function runTier0({ repo, base, branch, expect, forbid }) {
  const args = [join(HERE, "tier0.mjs"), "--repo", repo, "--branch", branch, "--base", base, "--json"];
  if (expect) args.push("--expect", expect);
  if (forbid) args.push("--forbid", forbid);
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 180000 });
    return { pass: true, report: JSON.parse(out) };
  } catch (e) {
    const out = String(e.stdout || "");
    try { return { pass: false, report: JSON.parse(out) }; }
    // A gate that cannot run is NOT a pass. Fail closed and say why.
    catch { return { pass: false, report: null, error: String(e.stderr || e.message || e).slice(0, 600) }; }
  }
}

function renderChecks(report) {
  return (report?.checks ?? []).map((c) => `- ${c.ok ? "PASS" : "**FAIL**"} — ${c.name}\n  \`${c.detail}\``).join("\n");
}

async function tick() {
  const state = loadState();
  const issues = rows(await api("GET", `/api/companies/${COMPANY}/issues?limit=50`));
  const candidates = issues.filter((i) => i.status === "done" && i.executionWorkspaceId && i.assigneeAgentId !== REVIEWER);
  if (!candidates.length) return;

  if (candidates.length > MAX_PER_PASS) {
    log(`NOTE: ${candidates.length} issues are ready; gating only ${MAX_PER_PASS} this pass ` +
        `(--max-per-pass to change). The rest carry over — nothing is dropped.`);
  }
  let gated = 0;
  for (const issue of candidates) {
    if (gated >= MAX_PER_PASS) break;
    const ws = (await api("GET", `/api/execution-workspaces/${issue.executionWorkspaceId}`)).json;
    const w = ws?.data ?? ws;
    const branch = w?.branchName, repo = w?.cwd, base = w?.baseRef || "main";
    if (!branch || !repo) { log(`skip ${issue.identifier}: no branch/repo on its workspace (mode=${w?.mode})`); continue; }

    let sha = "";
    try { sha = execFileSync("git", ["-C", repo, "rev-parse", branch], { encoding: "utf8" }).trim(); } catch {}
    const key = `${issue.id}@${sha}`;
    if (state[key]) continue;                       // already gated at this exact commit

    const { expect, forbid } = parseScope(issue.description || "");
    const { pass, report, error } = runTier0({ repo, base, branch, expect, forbid });

    if (!pass) {
      const detail = report ? renderChecks(report) : `- **FAIL** — tier 0 could not run\n  \`${error}\``;
      await api("POST", `/api/issues/${issue.id}/comments`, { body:
        `## TIER 0 FAILED — no reviewer was woken\n\nMechanical checks against \`${base}..${branch}\`:\n\n${detail}\n\n` +
        `Judgement adds nothing here. Fix the failing checks on your branch and mark it done again.` });
      await api("PATCH", `/api/issues/${issue.id}`, { status: "in_progress" });
      log(`GATE FAIL  ${issue.identifier}  ${branch}  -> back to worker, 0 model calls`);
    } else {
      await api("POST", `/api/issues/${issue.id}/comments`, { body:
        `## TIER 0 PASSED — mechanical facts established (do not re-derive)\n\n` +
        `\`${base}..${branch}\` — ${report.changedFiles.length} file(s): ${report.changedFiles.map((f) => `\`${f}\``).join(", ")}\n\n` +
        `${renderChecks(report)}\n\n` +
        `Tests: ${report.tests?.ran ? `\`${report.tests.command}\` exit ${report.tests.exitCode}` : "none detected"}\n\n` +
        `**Reviewer:** spend your call on whether this is CORRECT and HONEST — the above is settled.` });
      await api("PATCH", `/api/issues/${issue.id}`, { status: "in_review", assigneeAgentId: REVIEWER });
      await api("POST", `/api/agents/${REVIEWER}/wakeup`, { issueId: issue.id, reason: `tier 0 passed for ${branch}` });
      log(`GATE PASS  ${issue.identifier}  ${branch}  -> reviewer woken`);
    }
    state[key] = { at: new Date().toISOString(), pass };
    saveState(state);
    gated++;
  }
}

log(`tier0-gate watching company ${COMPANY}; reviewer ${REVIEWER}; ${ONCE ? "single pass" : `every ${INTERVAL / 1000}s`}`);
do {
  try { await tick(); } catch (e) { console.error("tick error:", e.message || e); }
  if (!ONCE) await new Promise((r) => setTimeout(r, INTERVAL));
} while (!ONCE);
