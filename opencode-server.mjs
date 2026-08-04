// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — server-backed OpenCode runtime (2026-08-04).
//
// Drives `opencode serve`'s v2 REST API over plain HTTP + SSE instead of spawning `opencode run`
// per task. One fresh, isolated `opencode serve` process per call — started, driven, torn down.
// Opt-in only, gated behind BO_CE_OPENCODE_SERVER=1 at the single call site in opencode-adapter.mjs
// (runOpenCode). When the flag is unset this module is never imported and behaviour is unchanged.
//
// Ground truth for every trap below: docs/OPENCODE_SERVER_API.md, verified end-to-end by
// tools/oc-api-probe.mjs (run it: `node tools/oc-api-probe.mjs`). Isolation guarantees here are
// IDENTICAL to the CLI runtime in opencode-adapter.mjs — same isolated HOME/XDG (prepareOpenCodeWorkspace),
// same confined + approved workspace, same fail-closed credential guard (assertHostOwnedCredentials,
// enforced inside buildExecutorEnv which prepareOpenCodeWorkspace already calls).
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { prepareOpenCodeWorkspace, WORKSPACE_PERMISSION_GRANT } from "./opencode-adapter.mjs";
import { canonical, within } from "./workspace-registry.mjs";
import { detectNoWork } from "./work-evidence.mjs";
import { t } from "./i18n.mjs";
import { safeSlice } from "./ce-core.mjs";
// Live activity registry (oc-live-view, 2026-08-04): lets a browser watch THIS session while the
// run below is still in flight, and lets a stop button reach the real interrupt endpoint — without
// this module or the registry ever handing the OpenCode server's baseURL/port to anything outside
// this file. See live-session.mjs for the full rationale.
import { liveSessions } from "./live-session.mjs";

const HOME = process.env.HOME || homedir();
// Same binary resolution as opencode-adapter.mjs (BO_OPENCODE_BIN override, then the standard install path).
export const OPENCODE_BIN = process.env.BO_OPENCODE_BIN || join(HOME, ".opencode", "bin", "opencode");

// ── Tunables — all overridable per call; defaults mirror tools/oc-api-probe.mjs ──────────────────
// HARD REQUIREMENT: every HTTP request needs an explicit timeout. Node's built-in fetch (undici)
// has NO default and wedges forever against a not-yet-ready server — measured, not theoretical.
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_BOOT_TIMEOUT_MS = 30000; // process must print its bound loopback address by then
export const DEFAULT_HEALTH_TIMEOUT_MS = 15000; // GET /api/health must go green by then
// GET /api/model can be empty for 1-3s on a brand-new workspace even after /api/health is healthy
// (the provider/model catalog warms up asynchronously) — poll, don't trust the first response.
export const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 10000;
export const MODEL_CATALOG_POLL_MS = 300;
export const DEFAULT_RUN_TIMEOUT_MS = 240000; // overall budget: prompt admitted -> terminal step
// GET /api/skill and GET /api/agent can ALSO be transiently empty right after boot — verified live,
// same warmup gotcha as GET /api/model (docs §4): a brand-new workspace's registry populated within
// ~1s in our probes. Poll with a bounded retry before concluding a name is absent (requirement below).
export const DEFAULT_REGISTRY_TIMEOUT_MS = 10000;
export const REGISTRY_POLL_MS = 300;
// Fraction of the model's own context window (GET /api/model .limit.context) at which we trigger a
// mid-run compaction. 0.8 leaves real headroom for the step that pushed usage over the line to
// actually finish before the window is exhausted.
export const DEFAULT_CONTEXT_COMPACT_THRESHOLD = 0.8;
// CONTEXT RELIEF (2026-08-04) — POST /compact reproducibly 503s "not available yet" in this
// OpenCode build (verified live, docs §12): there is no in-place compaction to fall back on. The
// runtime OWNS session lifecycle though, so the "clear context" half is still achievable: rotate
// to a brand-new session carrying a compact brief instead. Bounded — a task that keeps re-crossing
// the threshold after this many rotations is a planning failure no amount of rotating fixes;
// past the cap the run stops honestly rather than rotating forever (mission hard requirement 4).
export const DEFAULT_MAX_CONTEXT_ROTATIONS = 2;
// HARD REQUIREMENT — worker escalation (permission replies + worker questions), verified live
// 2026-08-04: NEITHER a pending permission ask NOR a pending question tool call ever produces an
// SSE event on the session's own event stream (confirmed against a real `opencode serve` 1.18.7 —
// the stream simply goes quiet after `session.next.tool.called`/`tool.input.ended` until someone
// replies). The ONLY way to discover either is to POLL GET /api/session/{id}/permission and
// GET /api/session/{id}/question while the run is in flight — this is why a poll loop runs
// alongside (not instead of) the SSE-driven terminal watcher below. Merge note (2026-08-04, oc-
// context-relief): the runtime is now a rotation loop over several SESSIONS per call — the poll
// loop is scoped PER SESSION (created fresh, and torn down, inside each loop iteration) so a
// rotation never leaves it polling a session the loop has already abandoned.
export const DEFAULT_ESCALATION_POLL_MS = 300;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A cancelable delay: resolves after `ms` UNLESS canceled first. Used for races (Promise.race)
// so the loser's underlying timer is always cleared — a bare `sleep()` left in a race would keep
// a handle alive (and, worst case, keep the process/test runner alive) long after the race settled.
function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------------------------------------
// Low-level HTTP. One shared helper so every call site gets the mandatory AbortSignal.timeout.
// ---------------------------------------------------------------------------------------------
export async function apiCall(baseURL, method, urlPath, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const res = await fetch(baseURL + urlPath, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, ok: res.ok, json, text };
}

/** Poll GET /api/health until it reports {healthy:true}, the process dies, or timeoutMs elapses. */
export async function waitForHealth(baseURL, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, isAlive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive()) throw new Error("opencode serve process exited before becoming healthy");
    try {
      const r = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.healthy === true) return;
      }
    } catch { /* not up yet, or this single attempt hung/timed out — retry */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy within ${timeoutMs}ms`);
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------------------------
// HARD REQUIREMENT — model registry gate, fail-closed. `kimi-for-coding` is authenticated and
// selectable via POST /api/session/{id}/model (204!) but is INVISIBLE to GET /api/model. Prompting
// it gets durably admitted (session.next.prompted fires) and then NEVER progresses — no error, no
// event, forever (docs §9, reproduced twice with a 5+ minute wait). We refuse anything that is not
// CONFIRMED present in this registry, polling briefly first because a fresh workspace's catalog can
// be empty for ~1-3s even after /api/health already reports healthy (docs §4).
// ---------------------------------------------------------------------------------------------
export async function verifyModelPresent(baseURL, { providerID, modelID,
  timeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS, pollMs = MODEL_CATALOG_POLL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let catalog = [];
  for (;;) {
    const res = await apiCall(baseURL, "GET", "/api/model", undefined, requestTimeoutMs);
    catalog = res.json?.data || [];
    const found = catalog.find((m) => m.providerID === providerID && m.id === modelID);
    if (found) return { present: true, model: found, catalog };
    if (Date.now() > deadline) return { present: false, model: null, catalog };
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------------------------
// Skill/agent routing onto the LIVE registry. Mirrors ce-core.mjs's KNOWN_SKILLS/checkTaskDirectives
// in spirit — a task's `skills`/`agentSlot` directives BIND the route and are FAIL CLOSED — but
// against OpenCode's OWN skill/agent registry (GET /api/skill, GET /api/agent), which is a distinct
// vocabulary from Community's capability slots. Verified live: POST /api/session/{id}/agent does
// NOT validate its `agent` field against the registry server-side — an unknown id still returns
// 204, exactly the same silent-acceptance trap as POST /model for an absent-catalog model (docs
// §5/§9). These functions are what makes switchAgent (below) safe to call at all: it must only ever
// run after the id was CONFIRMED present in GET /api/agent.
// ---------------------------------------------------------------------------------------------

/** Poll GET /api/skill until every name in `skillNames` is present or timeoutMs elapses (same
 *  bounded-retry shape as verifyModelPresent). Returns the last-seen catalog either way, so a
 *  fail-closed caller can name what IS actually available. Empty `skillNames` trivially passes. */
export async function verifySkillsPresent(baseURL, { skillNames = [], timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
  pollMs = REGISTRY_POLL_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!skillNames.length) return { present: true, missing: [], catalog: [] };
  const deadline = Date.now() + timeoutMs;
  let catalog = [];
  for (;;) {
    const res = await apiCall(baseURL, "GET", "/api/skill", undefined, requestTimeoutMs);
    catalog = res.json?.data || [];
    const missing = skillNames.filter((s) => !catalog.some((c) => c.name === s));
    if (missing.length === 0) return { present: true, missing: [], catalog };
    if (Date.now() > deadline) return { present: false, missing, catalog };
    await sleep(pollMs);
  }
}

/** Poll GET /api/agent until `agentId` is present or timeoutMs elapses (same bounded-retry shape
 *  as verifyModelPresent). A null/absent agentId trivially passes — the agentSlot directive is
 *  optional per task. */
export async function verifyAgentPresent(baseURL, { agentId, timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
  pollMs = REGISTRY_POLL_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!agentId) return { present: true, agent: null, catalog: [] };
  const deadline = Date.now() + timeoutMs;
  let catalog = [];
  for (;;) {
    const res = await apiCall(baseURL, "GET", "/api/agent", undefined, requestTimeoutMs);
    catalog = res.json?.data || [];
    const found = catalog.find((a) => a.id === agentId);
    if (found) return { present: true, agent: found, catalog };
    if (Date.now() > deadline) return { present: false, agent: null, catalog };
    await sleep(pollMs);
  }
}

/**
 * Fail-closed resolution of a task's OpenCode routing directives (task.skills, task.agentSlot)
 * against the LIVE skill/agent registry. An unknown name BLOCKS the task with a clear, localized,
 * NAMED reason — never a silent drop, never a default route (task-pm-04's rule, applied here to
 * OpenCode's own registry instead of Community's capability slots). Empty/absent directives always
 * pass — a task carrying neither is unaffected, migration-safe. Never throws.
 */
export async function resolveRoutingDirectives(baseURL, task = {}, { locale = "en",
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS, pollMs = REGISTRY_POLL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const skillNames = Array.isArray(task.skills) ? task.skills.filter((s) => typeof s === "string") : [];
  const agentId = typeof task.agentSlot === "string" && task.agentSlot ? task.agentSlot : null;

  if (skillNames.length) {
    const sk = await verifySkillsPresent(baseURL, { skillNames, timeoutMs, pollMs, requestTimeoutMs });
    if (!sk.present) {
      const available = sk.catalog.map((c) => c.name).join(", ") || "(none)";
      return { ok: false, agentId: null,
        reason: t(locale, "opencode.directive.unknownSkill").replace("{name}", sk.missing.join(", ")).replace("{available}", available) };
    }
  }
  if (agentId) {
    const ag = await verifyAgentPresent(baseURL, { agentId, timeoutMs, pollMs, requestTimeoutMs });
    if (!ag.present) {
      const available = ag.catalog.map((c) => c.id).join(", ") || "(none)";
      return { ok: false, agentId: null,
        reason: t(locale, "opencode.directive.unknownAgent").replace("{name}", agentId).replace("{available}", available) };
    }
  }
  return { ok: true, agentId };
}

/** POST /api/session/{id}/agent — switch the session's agent. Body is `{"agent":"<id>"}` (verified
 *  live against opencode 1.18.7's actual /doc, not just the mission's endpoint list). Expects 204. */
export async function switchAgent(baseURL, sessionID, agentId, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", `/api/session/${sessionID}/agent`, { agent: agentId }, requestTimeoutMs);
  if (res.status !== 204) throw new Error(`agent switch failed: HTTP ${res.status} ${res.text}`);
}

// ---------------------------------------------------------------------------------------------
// Context monitoring + compaction. GET /api/session/{id}/context returns the ACTIVE (uncompacted)
// message list — verified live: NOT a usage percentage/counter despite the endpoint's name. Usage
// is computed from the tokens on the LAST assistant message in that list (each carries the real
// per-step tokens.input/tokens.cache — same authoritative shape as GET /.../message, docs §10)
// against the model's own limit.context (from GET /api/model). Compaction is NEVER silent: any
// attempt — successful or not — is recorded as a planner defect signal, localized. A task large
// enough to need compaction means the plan decomposed it badly; that is the point being recorded,
// independent of whether the server's own /compact accepted it this build (see report: verified
// live to reproducibly 503 "not available yet", the same unusable-endpoint pattern docs §8 already
// found for /wait — handled the same way: never depended on, never silently swallowed either).
// ---------------------------------------------------------------------------------------------

/** GET /api/session/{id}/context. */
export async function getSessionContext(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "GET", `/api/session/${sessionID}/context`, undefined, requestTimeoutMs);
  return res.json?.data || [];
}

/** Current context occupancy: the most recent assistant message's tokens.input + cache.read +
 *  cache.write. NOT a sum across the turn (sumAssistantTokens' sum is for COST accounting across
 *  every step); this is what is CURRENTLY loaded into the window, which each step's own `input`
 *  already reflects in full — summing would double-count. Pure. */
export function computeContextUsage(contextData, contextLimit) {
  const assistantMsgs = (contextData || []).filter((m) => m?.type === "assistant" && m.tokens);
  const last = assistantMsgs[assistantMsgs.length - 1];
  const used = last ? (last.tokens.input || 0) + (last.tokens.cache?.read || 0) + (last.tokens.cache?.write || 0) : 0;
  const ratio = contextLimit ? used / contextLimit : 0;
  return { used, limit: contextLimit || null, ratio };
}

/**
 * Read the session's context and, if usage has crossed `threshold` of the model's context window,
 * compact it — recording the ATTEMPT as a planner defect signal either way (a 204 success, or a
 * non-204 such as the reproducibly-503 behaviour observed live for this endpoint, see module doc
 * comment above). Returns null when no contextLimit is known (nothing to compare usage against —
 * callers skip the check rather than compare against an invented number), otherwise a record:
 * { usage, triggered, compacted, status, defect: {reason} | null }. Never throws — a failed context
 * read is reported as a zero-usage, non-triggering check rather than aborting the run.
 */
export async function checkContextAndCompact(baseURL, sessionID, { contextLimit,
  threshold = DEFAULT_CONTEXT_COMPACT_THRESHOLD, locale = "en", requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (!contextLimit) return null;
  const data = await getSessionContext(baseURL, sessionID, { requestTimeoutMs });
  const usage = computeContextUsage(data, contextLimit);
  if (usage.ratio < threshold) return { usage, triggered: false, compacted: false, status: null, defect: null };

  // HARD REQUIREMENT — compaction is never silent: the ATTEMPT itself is the planner-defect signal,
  // independent of whether the server accepted it this build.
  const res = await apiCall(baseURL, "POST", `/api/session/${sessionID}/compact`, undefined, requestTimeoutMs);
  const pct = String(Math.round(usage.ratio * 100));
  const defect = res.status === 204
    ? { reason: t(locale, "opencode.context.compacted").replace("{pct}", pct) }
    : { reason: t(locale, "opencode.context.compactUnavailable").replace("{pct}", pct).replace("{status}", String(res.status)) };
  return { usage, triggered: true, compacted: res.status === 204, status: res.status, defect };
}

// ---------------------------------------------------------------------------------------------
// Worker escalation: permission replies + question routing (2026-08-04). Verified live against a
// real `opencode serve` 1.18.7: today, a headless run whose action resolves to permission "ask"
// (or whose worker calls the native `question` tool) never gets an SSE event for it — the run just
// sits there until our own overall timeoutMs elapses and gets interrupted, having silently done
// nothing. Both mechanisms below poll the session (there is no other way — see the tunable's doc
// comment above) and resolve what they find:
//   - permissions: bounded, POLICY-DRIVEN against WORKSPACE_PERMISSION_GRANT — the SAME grant
//     prepareOpenCodeWorkspace already wrote into this exact workspace's opencode.json. NEVER wider
//     than that grant; a resource that would escape the confined workspace is refused even when its
//     action IS granted (defense in depth — `resources` are model-supplied strings).
//   - questions: routed through the CALLER-supplied `onWorkerQuestion` hook (web-server.mjs wires
//     this to the EXISTING planner-auto-answer / owner-escalation logic — task-pm-05's
//     maybeAutoAnswer/askTaskQuestion/answerTaskQuestion, capped exactly as today). This module
//     never talks to the task store directly — same layering as `onSessionStart`.
// ---------------------------------------------------------------------------------------------

/** GET /api/session/{id}/permission — pending permission requests owned by this session. A
 *  transient/unreachable response is treated as "nothing pending yet", never thrown — a stray
 *  failed poll must never take the run down (same discipline as checkContextAndCompact). */
export async function fetchPendingPermissions(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  try {
    const res = await apiCall(baseURL, "GET", `/api/session/${sessionID}/permission`, undefined, requestTimeoutMs);
    return res.ok ? (res.json?.data || []) : [];
  } catch { return []; }
}

/** POST /api/session/{id}/permission/{requestID}/reply — body `{"reply":"once"|"always"|"reject"}`
 *  (+ optional `message`, verified live via GET /doc). We only ever send "once" or "reject" — never
 *  "always", which would durably widen the session's own standing grant beyond this one call. */
export async function replyToPermission(baseURL, sessionID, requestID, reply, { message, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const body = message ? { reply, message } : { reply };
  return apiCall(baseURL, "POST", `/api/session/${sessionID}/permission/${requestID}/reply`, body, requestTimeoutMs);
}

/**
 * Pure policy decision for ONE pending permission request — bounded to exactly what
 * WORKSPACE_PERMISSION_GRANT already permits for THIS confined workspace. Never throws, never
 * touches the network.
 *   - An action the grant does not mark "allow" (webfetch/external_directory, or anything the
 *     grant doesn't even name) is refused — fail-closed, the same posture as resolveRoutingDirectives.
 *   - An "edit" action (verified live: this is also what the "write" tool is gated under) is
 *     additionally checked resource-by-resource: each resource is resolved against `workspace`
 *     (relative paths are workspace-relative, verified live) and must stay confined — a path that
 *     escapes it is refused even though "edit" itself is granted.
 *   - "bash"'s resources are literal shell command strings, not paths — bash:"allow" in the grant
 *     IS the bound (the workspace itself is already fully confined: isolated HOME/XDG, no host
 *     credentials, approved-root directory — there is no narrower "inside the workspace" check to
 *     apply to a command string the way there is to a file path).
 */
export function decidePermissionRequest(request, { workspace, locale = "en" } = {}) {
  const action = typeof request?.action === "string" ? request.action : "";
  const resources = Array.isArray(request?.resources) ? request.resources : [];
  if (WORKSPACE_PERMISSION_GRANT[action] !== "allow") {
    return { allow: false, reply: "reject",
      reason: t(locale, "opencode.permission.refusedAction").replace("{action}", action || "(unknown)") };
  }
  if (action === "edit" && workspace) {
    const root = canonical(workspace);
    for (const r of resources) {
      if (typeof r !== "string" || !r) continue;
      const resolved = canonical(isAbsolute(r) ? r : join(workspace, r));
      if (!within(resolved, root)) {
        return { allow: false, reply: "reject",
          reason: t(locale, "opencode.permission.outsideWorkspace").replace("{resource}", r) };
      }
    }
  }
  return { allow: true, reply: "once", reason: null };
}

/** Poll once, decide, and reply to EVERY currently-pending permission request on this session.
 *  Returns one record per request (`{id, action, resources, allow, reason}`) regardless of whether
 *  the reply call itself succeeded — the decision was already made and is what gets recorded/logged;
 *  a failed reply is a transient-delivery problem, not a reason to hide the policy decision. */
async function resolvePendingPermissions(baseURL, sessionID, { workspace, locale = "en", requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const pending = await fetchPendingPermissions(baseURL, sessionID, { requestTimeoutMs });
  const events = [];
  for (const req of pending) {
    const decision = decidePermissionRequest(req, { workspace, locale });
    try { await replyToPermission(baseURL, sessionID, req.id, decision.reply, { message: decision.reason, requestTimeoutMs }); }
    catch { /* best-effort delivery — the decision below is recorded either way */ }
    events.push({ id: req.id, action: req.action, resources: req.resources || [], allow: decision.allow, reason: decision.reason });
  }
  return events;
}

/** GET /api/session/{id}/question — pending question-tool requests owned by this session. Same
 *  transient-failure discipline as fetchPendingPermissions: never throws, an unreachable poll is
 *  just "nothing pending yet". */
export async function fetchPendingQuestions(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  try {
    const res = await apiCall(baseURL, "GET", `/api/session/${sessionID}/question`, undefined, requestTimeoutMs);
    return res.ok ? (res.json?.data || []) : [];
  } catch { return []; }
}

/** POST /api/session/{id}/question/{requestID}/reply — body `{"answers":[[label,...],...]}`, one
 *  answer array per question in the request, in order (verified live via GET /doc). */
export async function replyToQuestion(baseURL, sessionID, requestID, answers, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return apiCall(baseURL, "POST", `/api/session/${sessionID}/question/${requestID}/reply`, { answers }, requestTimeoutMs);
}

/** POST /api/session/{id}/question/{requestID}/reject — no request body (verified live via GET
 *  /doc). Used whenever the question is not going to be answered from this call (no hook, the hook
 *  declined, or the request shape is one we don't handle) — a real reply, never a silent hang. */
export async function rejectQuestion(baseURL, sessionID, requestID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return apiCall(baseURL, "POST", `/api/session/${sessionID}/question/${requestID}/reject`, undefined, requestTimeoutMs);
}

/**
 * Poll once, and resolve EVERY currently-pending question request on this session through the
 * caller-supplied `onWorkerQuestion` hook. Bounded to CE's existing escalation vocabulary: a
 * request is only ever handed to the hook when it carries EXACTLY one question (parseWorkerQuestion,
 * plan-tasks.mjs, already enforces "at most ONE question" for the CLI path — the same bound applies
 * here); anything else (no hook wired, the hook throws, the hook declines, or more than one question
 * in the request) is REJECTED rather than left to hang forever. Returns one record per request:
 * `{id, question, resolved: "answered" | "escalated"}` — "escalated" is the caller's cue (via the
 * hook's own side effects, e.g. the task record it flips to blocked) that the owner is now needed.
 */
async function resolvePendingQuestions(baseURL, sessionID, { onWorkerQuestion = null, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const pending = await fetchPendingQuestions(baseURL, sessionID, { requestTimeoutMs });
  const events = [];
  for (const req of pending) {
    const singleQuestion = Array.isArray(req.questions) && req.questions.length === 1 ? req.questions[0] : null;
    let handled = null;
    if (singleQuestion && typeof onWorkerQuestion === "function") {
      try { handled = await onWorkerQuestion(req); } catch { handled = null; } // the hook must never take the run down with it
    }
    if (handled && Array.isArray(handled.answers) && handled.answers.length) {
      try { await replyToQuestion(baseURL, sessionID, req.id, handled.answers, { requestTimeoutMs }); } catch { /* best-effort */ }
      events.push({ id: req.id, question: singleQuestion?.question ?? null, resolved: "answered" });
    } else {
      try { await rejectQuestion(baseURL, sessionID, req.id, { requestTimeoutMs }); } catch { /* best-effort */ }
      events.push({ id: req.id, question: singleQuestion?.question ?? null, resolved: "escalated" });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Session lifecycle calls.
// ---------------------------------------------------------------------------------------------

/** POST /api/session — pass location.directory explicitly (requirement 6: cleaner + more robust
 *  than the $PWD env trick, and it works even if the server's own cwd resolution differs). */
export async function createSession(baseURL, { directory, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", "/api/session", directory ? { location: { directory } } : {}, requestTimeoutMs);
  if (!res.ok || !res.json?.data?.id) throw new Error(`session creation failed: HTTP ${res.status} ${res.text}`);
  return res.json.data;
}

/** POST /api/session/{id}/model — the payload trap (docs §5): the field is `id`, NOT `modelID`,
 *  and the whole ModelRef must be wrapped under a top-level "model" key. Expects 204 No Content. */
export async function selectModel(baseURL, sessionID, { id, providerID, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", `/api/session/${sessionID}/model`, { model: { id, providerID } }, requestTimeoutMs);
  if (res.status !== 204) throw new Error(`model selection failed: HTTP ${res.status} ${res.text}`);
}

/** POST /api/session/{id}/prompt — HTTP 200 means DURABLY ADMITTED, not that the run finished. */
export async function sendPrompt(baseURL, sessionID, text, { delivery = "queue", requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "POST", `/api/session/${sessionID}/prompt`, { prompt: { text }, delivery }, requestTimeoutMs);
  if (!res.ok) throw new Error(`prompt failed: HTTP ${res.status} ${res.text}`);
  return res.json?.data;
}

/** POST /api/session/{id}/interrupt — best-effort. Called on our own timeout (never on /wait,
 *  which reliably 503s in this build per docs §8). Its own failure never masks the timeout we're
 *  already reporting — the caller has already decided the run failed by the time this runs. */
export async function interruptSession(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  try { return await apiCall(baseURL, "POST", `/api/session/${sessionID}/interrupt`, undefined, requestTimeoutMs); }
  catch (e) { return { status: 0, ok: false, text: String(e.message || e) }; }
}

/** GET /api/session/{id}/message — the AUTHORITATIVE token source (docs §10). GET /api/session/{id}
 *  itself stays permanently {input:0,output:0,...} even after a real completed run — never use it. */
export async function fetchMessages(baseURL, sessionID, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const res = await apiCall(baseURL, "GET", `/api/session/${sessionID}/message`, undefined, requestTimeoutMs);
  return res.json?.data || [];
}

/** Sum real per-step token usage across every assistant message in a turn (docs §10). Pure. */
export function sumAssistantTokens(messages) {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of messages || []) {
    if (m?.type !== "assistant") continue;
    totals.input += m.tokens?.input || 0;
    totals.output += m.tokens?.output || 0;
    totals.reasoning += m.tokens?.reasoning || 0;
    totals.cacheRead += m.tokens?.cache?.read || 0;
    totals.cacheWrite += m.tokens?.cache?.write || 0;
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// SSE event subscription (docs §7). Only `data: <json>\n\n` frames are on the wire in this build
// — no separate `event:`/`id:` SSE fields despite the OpenAPI schema modeling them. Lines starting
// with ":" are heartbeat comments and are skipped.
// ---------------------------------------------------------------------------------------------
export function subscribeEvents(baseURL, sessionID, onEvent) {
  const controller = new AbortController();
  let firstByteResolve;
  const firstByte = new Promise((r) => { firstByteResolve = r; });

  // The whole body (including the initial fetch) lives inside ONE try/catch — deliberately wider
  // than the reference probe's scope, because here `stop()` can legitimately race the connection
  // itself (e.g. an early model-selection failure aborts the subscription almost immediately);
  // an abort during `fetch()` must be swallowed exactly like an abort during the read loop.
  const streamPromise = (async () => {
    try {
      const res = await fetch(`${baseURL}/api/session/${sessionID}/event`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`event subscription failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteResolve) { firstByteResolve(); firstByteResolve = null; }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line || line.startsWith(":")) continue; // blank / heartbeat comment
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try { onEvent(JSON.parse(payload)); } catch { /* one malformed frame never kills the subscription */ }
            }
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // expected on stop()
      throw err;
    }
  })();
  // Never let a genuinely failed/aborted subscription surface as an unhandled rejection — callers
  // that only ever read `sub.stop()`/events (never await `sub.done`) must not crash the process.
  streamPromise.catch(() => {});

  return { ready: firstByte, stop: () => controller.abort(), done: streamPromise };
}

/**
 * HARD REQUIREMENT — completion detection via SSE only. POST /api/session/{id}/wait reliably
 * returns 503 in this build, before AND long after the run actually finishes (docs §8) — never
 * call it to detect completion. The sole signal is `session.next.step.ended` with
 * `data.finish === "stop"`; an intermediate step ends with `data.finish === "tool-calls"` and must
 * NOT be treated as terminal (docs §7 — a real turn is 2+ steps, only the LAST one is "stop").
 */
export function createTerminalWatcher() {
  const events = [];
  let resolveTerminal;
  const terminal = new Promise((r) => { resolveTerminal = r; });
  function onEvent(evt) {
    events.push(evt);
    if (evt && evt.type === "session.next.step.ended" && evt.data && evt.data.finish === "stop") resolveTerminal(evt);
  }
  return { events, onEvent, terminal };
}

// ---------------------------------------------------------------------------------------------
// Server process lifecycle (requirement 10: start/stop, never orphaned).
// ---------------------------------------------------------------------------------------------

/** Spawn a fresh `opencode serve`, loopback-only, on an OS-assigned free port (`--port 0`). Scans
 *  stdout+stderr for the bound address the same way the proven reference (startOpenCodeServer in
 *  opencode-adapter.mjs) does. Captures the full (bounded) output for the lifetime of the process —
 *  used later as part of the run's log evidence, matching the CLI runtime's log-based signals. */
export function spawnServer({ bin = OPENCODE_BIN, cwd, env, bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // stdin closed (ignore): an open stdin pipe makes opencode wait for interactive input at init,
    // exactly like the `run` CLI path (opencode-adapter.mjs runOpenCode) — same reason, same fix.
    const child = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let boot = "";
    let full = "";
    let settled = false;
    const MAX_LOG = 200_000; // bounded — this process can run for the whole timeoutMs budget
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`opencode serve did not report a listening URL within ${bootTimeoutMs}ms: ${boot.slice(-500)}`));
    }, bootTimeoutMs);
    const onChunk = (d) => {
      const s = d.toString();
      full += s;
      if (full.length > MAX_LOG) full = full.slice(-MAX_LOG);
      if (settled) return;
      boot += s;
      const m = boot.match(/https?:\/\/127\.0\.0\.1:(\d+)/) || boot.match(/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      settled = true;
      clearTimeout(timer);
      resolve({ baseURL: `http://127.0.0.1:${m[1]}`, port: Number(m[1]), proc: child, getLog: () => full });
    };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", onChunk);
    child.stderr.setEncoding("utf8"); child.stderr.on("data", onChunk);
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", () => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`opencode serve exited during boot: ${boot.slice(-500)}`)); }
    });
  });
}

/** Terminate the server process and WAIT for it to actually exit (SIGTERM, then SIGKILL after a
 *  grace period) — never returns while the process might still be alive. This is what guarantees
 *  no orphaned `opencode serve` process is ever left behind, including on every error path. */
export function stopServer(proc, { graceMs = 4000 } = {}) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once("exit", finish);
    try { proc.kill("SIGTERM"); } catch { return finish(); }
    const killTimer = setTimeout(() => {
      if (done) return;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, graceMs);
    proc.once("exit", () => clearTimeout(killTimer));
  });
}

// ---------------------------------------------------------------------------------------------
// Context relief support — session rotation. Two small, pure helpers shared by every attempt the
// watch loop below drives (the original session AND every rotated replacement).
// ---------------------------------------------------------------------------------------------

/** The SAME git-diff technique used at real completion (below), factored out so a rotation can
 *  read "what has been changed so far" mid-run for the brief, and the final result computes it
 *  identically regardless of how many sessions this call actually drove. Never touches git state
 *  (no init/commit) — the workspace is shared across every session in this call and must stay
 *  exactly as prepareOpenCodeWorkspace left it (pre-committed once, up front). */
export function gitChangedFilesNow(workspace) {
  let changedFiles = [];
  try {
    changedFiles = execFileSync("git", ["-C", workspace, "diff", "--name-only", "HEAD"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "opencode.json");
  } catch { /* not a git workspace, or nothing changed — changedFiles stays empty, honestly */ }
  try {
    changedFiles.push(...execFileSync("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "opencode.json" && !f.startsWith(".oc-iso")));
  } catch { /* same */ }
  return [...new Set(changedFiles)];
}

/**
 * The compact brief a rotated session opens with — the whole cross-session memory contract for
 * context relief, mirroring projectBrief's "a worker should never start cold" idea (projects.mjs).
 * Plain, un-localized prompt text: it is MODEL input, not UI copy, exactly like workerPartPrompt's
 * (plan-tasks.mjs) task prompts — this repo never localizes text sent TO the model, only text
 * shown/logged FOR a human (the rotation's own planner-defect reason, which IS localized via
 * i18n.mjs, is a separate string — see the "opencode.context.rotated" key). Pure and bounded.
 */
export function buildRotationBrief({ prompt, changedFiles = [], rotationNumber = 1, maxLen = 4000 } = {}) {
  const filesLine = changedFiles.length
    ? `Files already changed this run so far (do not redo this work — read their current contents before touching them again): ${changedFiles.join(", ")}`
    : "No files have been changed yet this run.";
  const brief = `You are CONTINUING an in-progress task in a brand-new session (rotation ${rotationNumber}). The previous session's context window filled up and this runtime has no working in-place compaction, so a fresh session was started instead. Nothing about the task itself changed: same workspace, same objective, same constraints — only the session is new.

ORIGINAL OBJECTIVE (verbatim, unchanged):
${prompt}

WORK DONE SO FAR THIS RUN:
${filesLine}

Continue the work from exactly where it left off. Do not start over and do not repeat work already reflected in the files above.`;
  return safeSlice(brief, maxLen);
}

// ---------------------------------------------------------------------------------------------
// The core session-driving flow, factored out from server process management so it is testable
// against ANY already-running server (a stub HTTP server in tests, a real `opencode serve` in the
// live end-to-end run) without needing to spawn a real opencode binary. Returns a result shape
// that deliberately mirrors the connection-agnostic fields of runOpenCode()'s return value; the
// caller (runOpenCodeServer, below) fills in the connection-derived fields (model/provider/etc).
//
// STRUCTURE (2026-08-04, merge of oc-context-relief + oc-escalation): the whole body is a bounded
// `for (;;)` loop over ATTEMPTS — one per session. The original session is attempt 1; a context-
// relief rotation abandons the current session and `continue`s into a fresh one (a NEW session id,
// re-run through every fail-closed gate again); a worker-escalation permission/question poller is
// started and stopped ONCE PER ATTEMPT, scoped to that attempt's own session id, so a rotation never
// leaves it polling a session the loop has already abandoned. Every accumulator below (`allEventTypes`,
// `allContextChecks`, `allPermissionEvents`, `allQuestionEvents`, `carriedTokens`) is declared OUTSIDE
// the loop and reports the UNION across every attempt this call ends up driving.
// ---------------------------------------------------------------------------------------------
export async function runSessionAgainstServer({ baseURL, workspace, providerID, modelID, prompt,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  modelCatalogTimeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS, getServerLog = () => "",
  // Skill/agent routing directives (task.skills/task.agentSlot — task-pm-04's vocabulary, resolved
  // here against OpenCode's OWN live registry) + context-compaction tunables. `task`/`locale` default
  // to a no-directive/English no-op so every existing caller (and every prior test) is unaffected.
  task = {}, locale = "en", registryTimeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS, registryPollMs = REGISTRY_POLL_MS,
  contextCompactThreshold = DEFAULT_CONTEXT_COMPACT_THRESHOLD,
  // CONTEXT RELIEF (requirement 4): a hard, bounded cap on how many times ONE call to this function
  // will rotate to a fresh session. Past the cap the run stops honestly rather than rotating forever.
  maxContextRotations = DEFAULT_MAX_CONTEXT_ROTATIONS,
  // oc-live-view: fired ONCE PER SESSION (the original, and again for every rotation) — the caller's
  // chance to record the CURRENT live session id somewhere a browser can look it up WHILE this
  // function is still running (e.g. onto an execution record). A throwing hook must never take the
  // run down with it. Requirement 5: a rotation must call this again with the NEW id, or a browser
  // watching the old id sits on a stream this function has already ended.
  onSessionStart = () => {},
  // Worker escalation (2026-08-04): `onWorkerQuestion` routes a pending question-tool request to
  // CE's existing planner-auto-answer/owner-escalation logic (web-server.mjs); absent (the CLI
  // path, and every prior test) means every question is rejected rather than left to hang.
  // `escalationPollMs` is the poll interval for BOTH permissions and questions — see the
  // DEFAULT_ESCALATION_POLL_MS doc comment for why polling is the only way to discover either.
  onWorkerQuestion = null, escalationPollMs = DEFAULT_ESCALATION_POLL_MS }) {
  // Accumulated across EVERY session this call ends up driving (the original, plus any rotations) —
  // the final result reports the union, and the run log carries every session's events in order, so
  // a rotation is always visible in the evidence trail rather than silently swapping identities.
  const allEventTypes = [];
  const allContextChecks = [];
  // Worker escalation (2026-08-04): same union-across-attempts discipline as allEventTypes above —
  // a permission/question resolved on a session that later got rotated away must not vanish from
  // the final report, and a question that escalates to the owner must still be seen even if it
  // happened on attempt 1 and the run went on to rotate through attempts 2 and 3.
  const allPermissionEvents = [];
  const allQuestionEvents = [];
  // Tokens spent by sessions this call ABANDONED (rotated away from). Harvested at the moment of
  // rotation, because once the loop moves on nothing else ever reads that session again. Without
  // this a rotated run under-reports its spend exactly when spend is highest — the run rotated
  // BECAUSE it had filled a context window, so the abandoned session is the expensive one.
  const carriedTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let rotationsUsed = 0;
  let attemptPrompt = prompt; // replaced with buildRotationBrief() output after each rotation

  for (;;) {
    const session = await createSession(baseURL, { directory: workspace, requestTimeoutMs });
    const sessionID = session.id;

    // Register with the live registry as early as physically possible — before the directive gate,
    // before the model gate, before selecting, before prompting — so a browser watching this task
    // sees a gate refusal or a setup failure as it happens instead of only the eventual (possibly
    // much later) final result. Runs again, with the NEW id, on every rotation (requirement 5).
    liveSessions.start(sessionID, { interrupt: () => interruptSession(baseURL, sessionID, { requestTimeoutMs }) });
    try { onSessionStart(sessionID); } catch { /* the caller's bookkeeping must never break the run */ }

    // HARD REQUIREMENT 1a — routing directives are fail-closed BEFORE selecting or prompting, exactly
    // like the model gate below: an unknown skill/agentSlot must never silently degrade to a default
    // route (task-pm-04, mirrored here for OpenCode's own registry — see resolveRoutingDirectives).
    // Re-checked on every rotated session too — never skipped just because the ORIGINAL session
    // already passed it once.
    const directives = await resolveRoutingDirectives(baseURL, task, { locale, timeoutMs: registryTimeoutMs, pollMs: registryPollMs, requestTimeoutMs });
    if (!directives.ok) {
      // This early return is the ONLY one the live-view branch never saw (the directive gate did not
      // exist there), so it must end the live session explicitly — otherwise a browser watching this
      // task would sit on a stream that never closes.
      liveSessions.end(sessionID, { status: "failed", reason: directives.reason });
      return {
        ok: false, sessionId: sessionID, changedFiles: gitChangedFilesNow(workspace), tokens: 0, tokensDetail: null, providersUsed: [],
        log: directives.reason, noWork: true, noWorkReason: directives.reason,
        events: allEventTypes, compactions: allContextChecks.filter((c) => c.triggered), rotations: rotationsUsed,
        permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
      };
    }

    // HARD REQUIREMENT 1b — fail-closed BEFORE selecting or prompting. See createTerminalWatcher's
    // doc comment and docs §9 for exactly what happens if this gate is skipped: silent forever-hang.
    // SAME gate, re-run for a rotated session too — mission hard requirement: never skip the
    // fail-closed model-registry gate on the rotated session.
    const gate = await verifyModelPresent(baseURL, { providerID, modelID, timeoutMs: modelCatalogTimeoutMs, requestTimeoutMs });
    if (!gate.present) {
      const available = gate.catalog.map((m) => `${m.providerID}/${m.id}`).join(", ") || "(none)";
      const reason = `model ${providerID}/${modelID} is not present in GET /api/model — refusing to select/prompt it ` +
        `(an absent-from-registry model can still be selected+admitted and then never executes, silently, forever — see docs/OPENCODE_SERVER_API.md §9)`;
      liveSessions.end(sessionID, { status: "failed", reason });
      return {
        ok: false, sessionId: sessionID, changedFiles: gitChangedFilesNow(workspace), tokens: 0, tokensDetail: null, providersUsed: [],
        log: `model ${providerID}/${modelID} is absent from GET /api/model — refused BEFORE selecting/prompting it. available: ${available}`,
        noWork: true,
        noWorkReason: reason,
        events: allEventTypes, compactions: allContextChecks.filter((c) => c.triggered), rotations: rotationsUsed,
        permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
      };
    }
    // The model's own context window — the denominator context-compaction/rotation monitoring
    // compares usage against. Absent (no `limit.context` on this catalog entry) → the check is a no-op.
    const contextLimit = gate.model?.limit?.context || null;

    // HARD REQUIREMENT 2 — subscribe BEFORE prompting. The subscription's onEvent is wrapped so that
    // EVERY step boundary (intermediate or terminal) also schedules a context-usage check — "while
    // running" compaction/rotation monitoring, not just a single before/after snapshot. Checks are
    // chained sequentially (never run concurrently against the same session) via checkChain.
    const watcher = createTerminalWatcher();
    const contextChecksThisAttempt = [];
    let checkChain = Promise.resolve();
    // CONTEXT RELIEF: resolved (once) the moment a mid-run check crosses the threshold AND the
    // server's own /compact did NOT genuinely succeed — the signal the watch-loop race below acts
    // on to abandon this session and rotate, or to stop the whole run at the cap. `rotationDecided`
    // guards against deciding twice from two checks chained back to back.
    let rotationDecided = false;
    let resolveRotationSignal;
    // The signal carries the DECIDING record inline ({action, record}) rather than making the
    // watch-loop re-derive "the deciding record" from array position afterwards — the pre-run
    // check (below) and this event-driven chain are two INDEPENDENT concurrent HTTP round trips
    // once the event stream is live, so "whatever is last in contextChecksThisAttempt" is not a
    // safe way to identify which record actually triggered the decision.
    const rotationSignal = new Promise((r) => { resolveRotationSignal = r; });
    const scheduleContextCheck = () => {
      checkChain = checkChain
        .then(() => checkContextAndCompact(baseURL, sessionID, { contextLimit, threshold: contextCompactThreshold, locale, requestTimeoutMs }))
        .then((rec) => {
          if (!rec) return;
          contextChecksThisAttempt.push(rec);
          // Requirement 1: try /compact first — a genuine 204 keeps the existing behaviour (no
          // rotation). Only an unavailable/failed attempt (triggered but NOT compacted) is grounds
          // for rotation at all.
          if (rotationDecided || !rec.triggered || rec.compacted) return;
          rotationDecided = true;
          const pct = String(Math.round(rec.usage.ratio * 100));
          if (rotationsUsed >= maxContextRotations) {
            // Requirement 4 — the bounded cap: stop rotating, and stop the run, honestly.
            const reason = t(locale, "opencode.context.rotationCapReached").replace("{pct}", pct).replace("{max}", String(maxContextRotations));
            const record = { usage: rec.usage, triggered: true, compacted: false, status: rec.status, rotationCapReached: true, defect: { reason } };
            contextChecksThisAttempt.push(record);
            resolveRotationSignal({ action: "cap", record });
          } else {
            // Requirement 3 — recorded as a planner-defect signal exactly like a compaction: a task
            // large enough to need this was decomposed badly.
            const reason = t(locale, "opencode.context.rotated").replace("{pct}", pct).replace("{n}", String(rotationsUsed + 1));
            const record = { usage: rec.usage, triggered: true, compacted: false, status: rec.status, rotated: true, defect: { reason } };
            contextChecksThisAttempt.push(record);
            resolveRotationSignal({ action: "rotate", record });
          }
        })
        .catch(() => { /* a failed context check/compaction attempt never breaks the run itself */ });
    };
    // Every event ALSO feeds the live registry (projected + capped there — see live-session.mjs) so
    // a browser watching this session sees the exact same activity the completion-detection watcher
    // is reading, in real time.
    // Set SYNCHRONOUSLY the moment the terminal step is seen. The stream legitimately closes right
    // after a successful run, so "stream closed" alone must never be read as failure — without this
    // flag a normal completion whose close lands in the same tick is misreported as a dead server.
    // It ALSO takes precedence over a rotation signal that arrives in the same tick: a run that
    // already finished has nothing left to rotate.
    let terminalSeen = false;
    const onEvent = (evt) => {
      watcher.onEvent(evt);
      liveSessions.push(sessionID, evt);
      allEventTypes.push(evt?.type);
      if (evt && evt.type === "session.next.step.ended" && evt.data && evt.data.finish === "stop") terminalSeen = true;
      if (contextLimit && evt && evt.type === "session.next.step.ended") scheduleContextCheck();
    };
    const sub = subscribeEvents(baseURL, sessionID, onEvent);
    const readyTimer = timeoutAfter(1500);
    await Promise.race([sub.ready, readyTimer.promise]);
    readyTimer.cancel();

    // "Before running" context check — covers a session that already carries context (e.g. a future
    // resumed/forked session) crossing the threshold before the first prompt of THIS call even lands.
    // Deliberately NOT wired to rotation: a session at this point has not been prompted yet in this
    // call, so there is nothing to abandon/replace — it stays exactly the pre-existing compaction-only
    // signal.
    if (contextLimit) {
      try {
        const pre = await checkContextAndCompact(baseURL, sessionID, { contextLimit, threshold: contextCompactThreshold, locale, requestTimeoutMs });
        if (pre) contextChecksThisAttempt.push(pre);
      } catch { /* best-effort — never blocks the run */ }
    }

    try {
      // The agentSlot directive (already confirmed present in GET /api/agent by resolveRoutingDirectives
      // above) binds which OpenCode agent runs the turn — switched before selecting the model/prompting.
      if (directives.agentId) await switchAgent(baseURL, sessionID, directives.agentId, { requestTimeoutMs });
      await selectModel(baseURL, sessionID, { id: modelID, providerID, requestTimeoutMs });
      await sendPrompt(baseURL, sessionID, attemptPrompt, { requestTimeoutMs });
    } catch (e) {
      sub.stop();
      liveSessions.end(sessionID, { status: "failed", reason: `failed before the run could start: ${e.message || e}` });
      allContextChecks.push(...contextChecksThisAttempt);
      return {
        ok: false, sessionId: sessionID, changedFiles: gitChangedFilesNow(workspace), tokens: 0, tokensDetail: null, providersUsed: [providerID],
        log: String(e.message || e), noWork: true, noWorkReason: `failed before the run could start: ${e.message || e}`,
        events: allEventTypes, compactions: allContextChecks.filter((c) => c.triggered), rotations: rotationsUsed,
        permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
      };
    }

    // Worker escalation poller (2026-08-04) — SCOPED TO THIS ATTEMPT'S SESSION ONLY. Runs on its own
    // timer, concurrently with the SSE-driven wait below — chained (never overlapping against the
    // same session) via pollChain, exactly like scheduleContextCheck chains context checks. Started
    // only now (a permission/question cannot exist before the prompt that would trigger one), and
    // stopped the instant the race below settles — BEFORE the rotate branch's `continue`, so a
    // rotation always tears this down and the NEXT loop iteration builds a brand-new one bound to
    // the NEW session id. Never left running against a session the loop has moved on from.
    const permissionEventsThisAttempt = [];
    const questionEventsThisAttempt = [];
    let pollActive = true;
    let pollChain = Promise.resolve();
    let pollTimer = null;
    const scheduleEscalationPoll = () => {
      if (!pollActive) return;
      pollChain = pollChain
        .then(() => resolvePendingPermissions(baseURL, sessionID, { workspace, locale, requestTimeoutMs }))
        .then((evs) => permissionEventsThisAttempt.push(...evs))
        .then(() => resolvePendingQuestions(baseURL, sessionID, { onWorkerQuestion, requestTimeoutMs }))
        .then((evs) => questionEventsThisAttempt.push(...evs))
        .catch(() => { /* a failed poll round never breaks the run — retried next tick */ });
      pollTimer = setTimeout(scheduleEscalationPoll, escalationPollMs);
    };
    scheduleEscalationPoll();
    const stopEscalationPoll = async () => {
      pollActive = false;
      if (pollTimer) clearTimeout(pollTimer);
      await pollChain; // let an in-flight poll round finish before we read permissionEvents/questionEvents
    };

    // Enforce the overall timeout, detect the event STREAM ITSELF closing early (e.g. the opencode
    // serve process dying mid-run), AND race a mid-run context-relief signal. `sub.done` (the SSE
    // read loop's own promise) settles the moment the underlying connection ends, by any means;
    // during this race that can only be a genuine drop, because our own `sub.stop()` (the only abort
    // we ever issue) runs strictly AFTER this race below. Both branches of `.then(f, f)` count — the
    // stream ending because the fetch itself rejected is just as real a "connection is gone" signal
    // as a clean EOF.
    const termTimer = timeoutAfter(timeoutMs);
    let timedOut = false, streamClosed = false, rotationOutcome = null;
    const onStreamSettled = () => { streamClosed = true; };
    await Promise.race([
      watcher.terminal,
      termTimer.promise.then(() => { timedOut = true; }),
      sub.done.then(onStreamSettled, onStreamSettled),
      rotationSignal.then((r) => { rotationOutcome = r; }),
    ]);
    termTimer.cancel();
    sub.stop();
    await checkChain; // let any context check already scheduled by the last observed step finish
    await stopEscalationPoll(); // and any escalation poll round already in flight — same discipline

    allContextChecks.push(...contextChecksThisAttempt);
    allPermissionEvents.push(...permissionEventsThisAttempt);
    allQuestionEvents.push(...questionEventsThisAttempt);

    // CONTEXT RELIEF — rotate: this session is abandoned mid-run (best-effort interrupt, exactly
    // like the timeout path below), its live entry ends, and the loop goes around again to open a
    // fresh session seeded with a compact brief (requirement 2). `!terminalSeen` matches the same
    // precedence rule the stream-closed branch already uses below: a run that finished has nothing
    // left to rotate, regardless of what the last context check happened to see. Any worker
    // question that escalated to the owner ON THIS ATTEMPT is already recorded in allQuestionEvents
    // (and, via the caller's onWorkerQuestion hook, already persisted as a blocked task) — the loop
    // rotates anyway rather than guessing whether to stop; the final return below (whichever attempt
    // it lands on) still honors the escalation via allQuestionEvents, never lost across a rotation.
    if (!terminalSeen && rotationOutcome?.action === "rotate") {
      await interruptSession(baseURL, sessionID, { requestTimeoutMs });
      // Harvest this session's tokens BEFORE abandoning it — last chance to read them.
      try {
        const spent = sumAssistantTokens(await fetchMessages(baseURL, sessionID, { requestTimeoutMs }));
        carriedTokens.input += spent.input; carriedTokens.output += spent.output;
        carriedTokens.reasoning += spent.reasoning;
        carriedTokens.cacheRead += spent.cacheRead; carriedTokens.cacheWrite += spent.cacheWrite;
      } catch { /* unreadable → the carried total simply omits it, never a fabricated number */ }
      liveSessions.end(sessionID, { status: "rotated", reason: rotationOutcome.record?.defect?.reason || "context rotation" });
      rotationsUsed += 1;
      attemptPrompt = buildRotationBrief({ prompt, changedFiles: gitChangedFilesNow(workspace), rotationNumber: rotationsUsed });
      continue; // next loop iteration creates the replacement session — onSessionStart AND the escalation poller both fire again, fresh
    }

    // CONTEXT RELIEF — cap reached: requirement 4, stop rotating AND stop the run, honestly. This
    // is NOT a silent failure: the exact same defect-signal machinery as a successful rotation
    // recorded WHY, and noWorkReason carries it forward to whatever surfaces noWork today.
    if (!terminalSeen && rotationOutcome?.action === "cap") {
      await interruptSession(baseURL, sessionID, { requestTimeoutMs });
      const reason = rotationOutcome.record?.defect?.reason || `context rotation cap (${maxContextRotations}) reached — stopping rather than rotating forever`;
      liveSessions.end(sessionID, { status: "context-rotation-cap", reason });
      return {
        ok: false, sessionId: sessionID, changedFiles: gitChangedFilesNow(workspace), tokens: 0, tokensDetail: null, providersUsed: [providerID],
        log: `${getServerLog()}\n\n=== events observed before the rotation cap stopped the run ===\n${allEventTypes.join("\n")}`.slice(-4000),
        noWork: true, noWorkReason: reason,
        events: allEventTypes, contextChecks: allContextChecks, compactions: allContextChecks.filter((c) => c.triggered), rotations: rotationsUsed,
        permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
      };
    }

    const compactions = allContextChecks.filter((c) => c.triggered);
    const contextLogLines = compactions.length
      ? `\n\n=== context defects (planner) ===\n${compactions.map((c) => c.defect?.reason).filter(Boolean).join("\n")}` : "";
    // Worker escalation (2026-08-04): fold in permission refusals + escalated questions from EVERY
    // attempt this call has driven so far, not just the current one — mirrors contextLogLines above.
    const permissionRefusals = allPermissionEvents.filter((e) => !e.allow);
    const permissionLogLines = permissionRefusals.length
      ? `\n\n=== permission defects (security) ===\n${permissionRefusals.map((e) => e.reason).filter(Boolean).join("\n")}` : "";
    const escalatedQuestions = allQuestionEvents.filter((e) => e.resolved === "escalated");
    const questionLogLines = escalatedQuestions.length
      ? `\n\n=== worker questions awaiting the owner ===\n${escalatedQuestions.map((e) => e.question).filter(Boolean).join("\n")}` : "";
    const escalationLogLines = `${permissionLogLines}${questionLogLines}`;

    // Only a close WITHOUT the terminal step is a real failure. `terminalSeen` is required here:
    // on a healthy run the server ends the stream immediately after finish:"stop", so streamClosed
    // is routinely true on success.
    if (streamClosed && !timedOut && !terminalSeen) {
      // Best-effort only — the server that would receive this call is most likely the thing that
      // just disappeared, so this is expected to itself fail. Never claims the run completed.
      await interruptSession(baseURL, sessionID, { requestTimeoutMs });
      const reason = "the event stream closed before the run finished (session.next.step.ended{finish:\"stop\"} " +
        "was never observed) — the OpenCode server may have exited";
      liveSessions.end(sessionID, { status: "stream-closed", reason });
      return {
        ok: false, sessionId: sessionID, changedFiles: gitChangedFilesNow(workspace), tokens: 0, tokensDetail: null, providersUsed: [providerID],
        log: `${getServerLog()}\n\n=== events observed before the stream closed ===\n${allEventTypes.join("\n")}${escalationLogLines}`.slice(-4000),
        noWork: true, noWorkReason: reason, events: allEventTypes, rotations: rotationsUsed,
        permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
      };
    }

    if (timedOut) {
      await interruptSession(baseURL, sessionID, { requestTimeoutMs });
      const reason = `timed out after ${timeoutMs}ms waiting for session.next.step.ended{finish:"stop"} on the event stream — interrupted`;
      liveSessions.end(sessionID, { status: "timeout", reason });
      return {
        ok: false, sessionId: sessionID, changedFiles: gitChangedFilesNow(workspace), tokens: 0, tokensDetail: null, providersUsed: [providerID],
        log: `${getServerLog()}\n\n=== events observed before timeout ===\n${allEventTypes.join("\n")}${contextLogLines}${escalationLogLines}`.slice(-4000),
        noWork: true,
        noWorkReason: reason,
        events: allEventTypes, contextChecks: allContextChecks, compactions, rotations: rotationsUsed,
        permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
      };
    }

    // Real completion. changedFiles: same git-diff technique the CLI runtime uses (the workspace is
    // git-init'd + pre-committed by prepareOpenCodeWorkspace, so `diff HEAD` is exactly this run's
    // work — across every session this call drove, since the workspace/git state is shared and never
    // re-initialized or re-committed between rotations).
    const changedFiles = gitChangedFilesNow(workspace);

    // HARD REQUIREMENT 4 — tokens from GET /.../message, summed. GET /api/session/{id} itself stays
    // permanently zero (docs §10) and is never consulted here. The reported total is the FINAL
    // session's messages PLUS whatever every rotated-away session spent (harvested at the moment of
    // rotation, above) — so a rotated run reports what it actually cost, not just its last leg.
    let messages = [];
    try { messages = await fetchMessages(baseURL, sessionID, { requestTimeoutMs }); } catch { /* leaves this leg at 0, honestly */ }
    const finalTotals = sumAssistantTokens(messages);
    const totals = {
      input: finalTotals.input + carriedTokens.input,
      output: finalTotals.output + carriedTokens.output,
      reasoning: finalTotals.reasoning + carriedTokens.reasoning,
      cacheRead: finalTotals.cacheRead + carriedTokens.cacheRead,
      cacheWrite: finalTotals.cacheWrite + carriedTokens.cacheWrite,
    };

    const log = `${getServerLog()}\n\n=== session events ===\n${allEventTypes.join("\n")}${contextLogLines}${escalationLogLines}`.slice(-4000);
    // HARD REQUIREMENT 9 — the SAME no-work guard the CLI runtime uses. A run that changed no files
    // is NOT ok, regardless of how cleanly the API round-trip completed.
    const evidenceGuard = detectNoWork({ exitCode: 0, changedFiles, log });
    // A worker question the plan's decisions do not cover NEEDS THE OWNER (task-pm-05's existing
    // rule, applied here too) — this overrides the evidence guard even when the session already
    // produced real file changes before it paused: the task is not actually done until the owner (or
    // the planner, via the SAME hook) answers, so this run is never reported as a clean success.
    // Uses allQuestionEvents (every attempt, not just the final one) — an escalation on an EARLIER,
    // since-rotated-away attempt must still override a later attempt's clean completion.
    const hasEscalatedQuestion = escalatedQuestions.length > 0;
    const noWork = evidenceGuard.noWork || hasEscalatedQuestion;
    const reason = hasEscalatedQuestion ? t(locale, "opencode.question.escalated") : evidenceGuard.reason;
    // The live view reports the AGENT SESSION's own lifecycle, not the higher-level work-review
    // verdict above — the session genuinely reached its terminal step, so it ends "done" regardless
    // of whether detectNoWork (or the escalation override just above) later judges the run incomplete.
    liveSessions.end(sessionID, { status: "done", reason: null });

    return {
      ok: !noWork, sessionId: sessionID, changedFiles, tokens: totals.output,
      tokensDetail: { input: totals.input, output: totals.output, reasoning: totals.reasoning,
        cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite,
        contextTotal: totals.input + totals.cacheRead + totals.cacheWrite },
      providersUsed: [providerID], log, noWork, noWorkReason: reason,
      events: allEventTypes,
      // Context-compaction/rotation planner-defect signal (requirement 2/3): empty when usage never
      // crossed contextCompactThreshold, or when the model's context limit was unknown.
      contextChecks: allContextChecks, compactions,
      // Honest count of context-relief rotations this call actually performed (0 when none).
      rotations: rotationsUsed,
      // Worker escalation (2026-08-04): every permission request this call resolved across every
      // session it drove (allow/refuse, with an honest reason for a refusal) and every question-tool
      // request it resolved (answered from the plan's decisions, or escalated to the owner). Empty
      // on a run that never asked either.
      permissionEvents: allPermissionEvents, questionEvents: allQuestionEvents,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Top-level entry point — same shape of inputs/outputs as opencode-adapter.mjs's runOpenCode, so
// the flag-dispatch at the call site needs zero special-casing downstream (requirement 9).
// ---------------------------------------------------------------------------------------------
export async function runOpenCodeServer({ connection, prompt, workspace, effort, isoBase, approvedRoots,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS, bin = OPENCODE_BIN, bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, modelCatalogTimeoutMs = DEFAULT_MODEL_CATALOG_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  // task.skills/task.agentSlot routing directives (resolved against the live OpenCode registry) +
  // the locale for any localized fail-closed/defect-signal text; contextCompactThreshold/registry
  // timeouts are exposed for callers that need to tune them, defaults otherwise.
  task = {}, locale = "en", registryTimeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS, registryPollMs = REGISTRY_POLL_MS,
  contextCompactThreshold = DEFAULT_CONTEXT_COMPACT_THRESHOLD, maxContextRotations = DEFAULT_MAX_CONTEXT_ROTATIONS,
  onSessionStart = () => {},
  // Worker escalation (2026-08-04): forwarded verbatim to runSessionAgainstServer — see its own
  // doc comment. Absent means every question this run's worker asks is rejected, never left hanging.
  onWorkerQuestion = null } = {}) {
  // `effort` (--variant on the CLI path) has no REST equivalent surfaced by this build's ModelRef
  // beyond the optional `variant` field — not exercised here; left as a documented gap (see report).
  void effort;

  const meta = { model: connection?.model, provider: connection?.provider, costSource: connection?.costSource, funder: connection?.funder };
  const failResult = (reason, extra = {}) => ({
    ok: false, exitCode: null, ...meta, tokens: 0, providersUsed: [], changedFiles: [],
    founderCredentialUsed: false, log: String(reason).slice(-4000), sessionId: null,
    tokensDetail: null, noWork: true, noWorkReason: reason, compactions: [],
    permissionEvents: [], questionEvents: [], ...extra,
  });

  // HARD REQUIREMENT 8 — identical isolation to the CLI path: isolated HOME/XDG, confined + approved
  // workspace, the fail-closed credential guard (all enforced inside prepareOpenCodeWorkspace /
  // buildExecutorEnv), and the workspace opencode.json that keeps a headless run from auto-rejecting
  // its own write permission (requirement 7).
  let ws, env, modelRef;
  try {
    ({ ws, env, modelRef } = prepareOpenCodeWorkspace({ connection, workspace, isoBase, approvedRoots }));
  } catch (e) {
    return failResult(`workspace preparation failed: ${e.message || e}`);
  }
  // providerId is sanitized to [a-zA-Z0-9_-] by connectionToConfig (opencode-adapter.mjs) so it can
  // never itself contain "/" — the FIRST "/" in modelRef is always exactly the provider/model boundary,
  // even if the model id contains further slashes.
  const slash = modelRef.indexOf("/");
  const providerID = modelRef.slice(0, slash);
  const modelID = modelRef.slice(slash + 1);

  let server;
  try {
    // HARD REQUIREMENT 6 — belt and suspenders on top of location.directory (passed inside
    // runSessionAgainstServer's createSession call): also set PWD in the spawn env, because
    // spawn(cmd,{cwd}) does NOT update the inherited PWD and opencode resolves its project root
    // from $PWD in some code paths.
    server = await spawnServer({ bin, cwd: ws, env: { ...env, PWD: ws }, bootTimeoutMs });
  } catch (e) {
    return failResult(`opencode serve failed to start: ${e.message || e}`);
  }

  // HARD REQUIREMENT 10 — the server process is ALWAYS torn down, on every path out of here,
  // success or failure. No orphaned `opencode serve` process survives this function.
  try {
    await waitForHealth(server.baseURL, { timeoutMs: healthTimeoutMs, isAlive: () => server.proc.exitCode === null });
    const core = await runSessionAgainstServer({
      baseURL: server.baseURL, workspace: ws, providerID, modelID, prompt,
      timeoutMs, requestTimeoutMs, modelCatalogTimeoutMs, getServerLog: server.getLog,
      task, locale, registryTimeoutMs, registryPollMs, contextCompactThreshold, maxContextRotations, onSessionStart,
      onWorkerQuestion,
    });
    return { ...core, ...meta, exitCode: 0, founderCredentialUsed: false };
  } catch (e) {
    return failResult(`server runtime error: ${e.message || e}`);
  } finally {
    await stopServer(server.proc);
  }
}
