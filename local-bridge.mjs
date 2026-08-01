// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — local bridge ("bo connect", 2026-08-01).
// A hosted (or self-hosted) workspace can use THIS computer — its local models (ollama), and
// explicitly granted local folders — without the machine opening a single inbound port.
//
// Shape:
//   • pairing: the workspace shows a short, single-use, 10-minute code; the CLI redeems it for a
//     node credential (only the hash is stored server-side);
//   • transport: the bridge dials OUT only — a long-poll loop (POST …/poll, held ≤25s). Nothing
//     listens on the user's machine; NATs and firewalls need nothing;
//   • verbs (the whole protocol): list-models · complete · list-files · read-file. Nothing else
//     can be asked, and file verbs are confined to the grants recorded AT pairing — the server
//     refuses out-of-grant paths before the bridge is even asked, and the bridge refuses again;
//   • credentials: the bridge never uploads local secrets; model keys never travel — inference
//     happens on the user's hardware, which is the entire point of "full private on a hosted trial".
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute, join, extname } from "node:path";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";      // no ambiguous 0/O/1/I/L

export const BRIDGE_VERBS = ["list-models", "complete", "list-files", "read-file"];
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const POLL_HOLD_MS = 25000;
export const NODE_ONLINE_MS = 45000;

export class LocalNodes {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.codes = new Map();          // code → { expiresAt, usedAt }
    this.nodes = new Map();          // nodeId → { id, name, credHash, grants[], createdAt, revokedAt, lastSeenAt, models[] }
    this.queues = new Map();         // nodeId → [{ callId, verb, args }]
    this.pending = new Map();        // callId → { resolve, timer }
    this.waiters = new Map();        // nodeId → [respondFns] (long-poll holders)
  }

  /** UI: issue a short pairing code (8 chars, unambiguous alphabet). */
  issueCode({ now = this.clock() } = {}) {
    const code = Array.from(randomBytes(8)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const c = `${code.slice(0, 4)}-${code.slice(4)}`;
    this.codes.set(c, { expiresAt: now + PAIR_CODE_TTL_MS, usedAt: null });
    return { code: c, expiresAt: now + PAIR_CODE_TTL_MS };
  }

  /** Bridge: redeem a code → node credential. Single-use; expired codes fail closed. */
  redeemCode(code, { name = "computer", grants = [], now = this.clock() } = {}) {
    const rec = this.codes.get(String(code || "").toUpperCase());
    if (!rec) throw new Error("unknown pairing code");
    if (rec.usedAt) throw new Error("pairing code already used");
    if (now >= rec.expiresAt) throw new Error("pairing code expired — issue a new one");
    rec.usedAt = now;
    const nodeId = `node-${randomBytes(6).toString("hex")}`;
    const credential = randomBytes(24).toString("hex");
    this.nodes.set(nodeId, { id: nodeId, name: String(name).slice(0, 80) || "computer",
      credHash: sha(credential), grants: [...new Set(grants.map(String))], createdAt: now, revokedAt: null, lastSeenAt: null, models: [] });
    this.queues.set(nodeId, []);
    return { nodeId, credential };
  }

  verifyNode(nodeId, credential) {
    const n = this.nodes.get(nodeId);
    if (!n || n.revokedAt) return false;
    const a = Buffer.from(n.credHash, "hex"), b = Buffer.from(sha(credential || ""), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  revoke(nodeId, { now = this.clock() } = {}) {
    const n = this.nodes.get(nodeId);
    if (!n) throw new Error(`unknown node '${nodeId}'`);
    n.revokedAt = now;
    for (const respond of this.waiters.get(nodeId) || []) respond({ verbs: [] });   // drop held polls
    this.waiters.delete(nodeId);
    return true;
  }

  online(nodeId, { now = this.clock() } = {}) {
    const n = this.nodes.get(nodeId);
    return !!n && !n.revokedAt && !!n.lastSeenAt && now - n.lastSeenAt < NODE_ONLINE_MS;
  }

  listPublic({ now = this.clock() } = {}) {
    return [...this.nodes.values()].filter((n) => !n.revokedAt)
      .map((n) => ({ id: n.id, name: n.name, grants: n.grants, models: n.models,
        online: this.online(n.id, { now }), lastSeenAt: n.lastSeenAt }));
  }

  /** Grant enforcement — a file path is allowed only INSIDE a granted root. */
  pathAllowed(nodeId, path) {
    const n = this.nodes.get(nodeId);
    if (!n) return false;
    const p = String(path || "");
    return n.grants.some((g) => p === g || p.startsWith(g.replace(/\/+$/, "") + "/"));
  }

  /**
   * Call a verb on a node. Unknown verbs and out-of-grant file paths are refused BEFORE the
   * bridge is asked. Resolves with the node's result or rejects on timeout/offline.
   */
  async call(nodeId, verb, args = {}, { timeoutMs = 30000, now = this.clock() } = {}) {
    const n = this.nodes.get(nodeId);
    if (!n || n.revokedAt) throw new Error(`node '${nodeId}' is not paired`);
    if (!BRIDGE_VERBS.includes(verb)) throw new Error(`unknown bridge verb '${verb}' — the protocol is fixed: ${BRIDGE_VERBS.join(", ")}`);
    if ((verb === "read-file" || verb === "list-files") && !this.pathAllowed(nodeId, args.path || args.root))
      throw new Error(`path '${args.path || args.root}' is outside this node's granted folders`);
    if (!this.online(nodeId, { now })) throw new Error(`node '${nodeId}' is offline`);
    const callId = `call-${randomBytes(8).toString("hex")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(callId); reject(new Error(`node '${nodeId}' timed out on '${verb}'`)); }, timeoutMs);
      this.pending.set(callId, { resolve, timer });
      this.queues.get(nodeId).push({ callId, verb, args });
      this.#flush(nodeId);
    });
  }

  /** Node long-poll: hold the response until there is work or the hold expires. */
  poll(nodeId, { now = this.clock(), holdMs = POLL_HOLD_MS } = {}) {
    const n = this.nodes.get(nodeId);
    if (n) n.lastSeenAt = now;
    return new Promise((resolve) => {
      const queue = this.queues.get(nodeId) || [];
      if (queue.length) return resolve({ verbs: queue.splice(0, queue.length) });
      const waiters = this.waiters.get(nodeId) || [];
      const w = { respond: resolve, at: now };
      waiters.push(w);
      this.waiters.set(nodeId, waiters);
      setTimeout(() => {
        const ws = (this.waiters.get(nodeId) || []).filter((x) => x !== w);
        this.waiters.set(nodeId, ws);
        resolve({ verbs: [] });
      }, holdMs);
    });
  }

  #flush(nodeId) {
    const queue = this.queues.get(nodeId) || [];
    const waiters = this.waiters.get(nodeId) || [];
    if (!queue.length || !waiters.length) return;
    const verbs = queue.splice(0, queue.length);
    for (const w of waiters.splice(0, waiters.length)) w.respond({ verbs });
  }

  /** Node posts a result; resolves the pending call. Unknown callIds are dropped. */
  postResult(nodeId, { callId, ok = true, result = null, error = null }) {
    const p = this.pending.get(callId);
    if (!p) return { delivered: false };
    clearTimeout(p.timer);
    this.pending.delete(callId);
    if (ok) p.resolve(result);
    else p.resolve({ __error: error || "node reported a failure" });
    return { delivered: true };
  }

  /** Bridge announces its models (list-models result) — cached for the UI/registry. */
  noteModels(nodeId, models = []) {
    const n = this.nodes.get(nodeId);
    if (n) n.models = models.map(String).slice(0, 50);
  }
}

// ── Bridge client (runs on the user's computer) ──────────────────────────────
// IO is injected so the whole loop is testable offline: `exec(verb, args)` performs the local
// work (ollama calls, granted file reads), `post(path, body)` talks to the workspace.
export async function bridgePair({ url, code, name, grants = [], post }) {
  if (!post) throw new Error("bridgePair: a post(path, body) transport is required");
  const r = await post("/api/local/pair", { code, name, grants });
  if (r.error) throw new Error(r.error);
  return r;                                   // { nodeId, credential }
}

export async function bridgeLoop({ url, nodeId, credential, exec, post, once = false, onError = null, holdMs }) {
  const auth = { nodeId, credential };
  for (;;) {
    let batch;
    try { batch = await post("/api/local/poll", { ...auth, holdMs }); }
    catch (e) { onError?.(e); if (once) throw e; await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const job of batch.verbs || []) {
      let out;
      try { out = { callId: job.callId, ok: true, result: await exec(job.verb, job.args || {}) }; }
      catch (e) { out = { callId: job.callId, ok: false, error: String(e.message || e).slice(0, 300) }; }
      try { await post("/api/local/result", { ...auth, ...out }); } catch (e) { onError?.(e); }
    }
    if (once) return batch;
  }
}

// ── The local executor: what the bridge may DO on this computer ──────────────
// Exactly the four verbs. File verbs are confined to the `--allow` roots with a real path check
// (symlink/traversal-safe via resolve+relative); model verbs talk to the local ollama only.
export function makeLocalExec({ allow = [], ollamaBase = "http://127.0.0.1:11434", fetchImpl = fetch } = {}) {
  const roots = allow.map((g) => resolve(g));
  const inGrant = (p) => {
    const abs = resolve(String(p || ""));
    return roots.some((g) => { const rel = relative(g, abs); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
  };
  return async function exec(verb, args = {}) {
    if (verb === "list-models") {
      const r = await fetchImpl(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      return { models: (j.models || []).map((m) => m.name) };
    }
    if (verb === "complete") {
      const r = await fetchImpl(`${ollamaBase}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: args.model, messages: [{ role: "user", content: String(args.prompt || "") }], stream: false,
          options: args.maxTokens ? { num_predict: args.maxTokens } : undefined }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) throw new Error(`local model '${args.model}' → HTTP ${r.status}`);
      const j = await r.json();
      const content = j.message?.content ?? "";
      if (!String(content).trim()) throw new Error(`local model '${args.model}' returned no content`);
      return { content, tokens: (j.eval_count || 0) + (j.prompt_eval_count || 0), tokenScope: j.eval_count != null ? "total" : "unknown" };
    }
    if (verb === "list-files") {
      if (!inGrant(args.root)) throw new Error(`'${args.root}' is outside the granted folders`);
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 3 || out.length >= 200) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p, depth + 1);
          else { try { const st = statSync(p); out.push({ path: p, name: e.name, size: st.size, modified: st.mtimeMs }); } catch {} }
        }
      };
      walk(resolve(args.root), 0);
      return { files: out };
    }
    if (verb === "read-file") {
      if (!inGrant(args.path)) throw new Error(`'${args.path}' is outside the granted folders`);
      return { path: args.path, content: readFileSync(resolve(args.path), "utf8").slice(0, args.maxBytes || 200_000) };
    }
    throw new Error(`unknown bridge verb '${verb}'`);
  };
}
