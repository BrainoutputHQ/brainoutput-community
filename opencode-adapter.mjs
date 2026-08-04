// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — REAL OpenCode adapter (2026-07-27).
// Runs `opencode run` driven by the Community profile's model connection (provider/model/endpoint/
// effort/auth/cost). Isolated HOME/XDG so BrainOutput's own hosted paid models are NEVER reachable; the
// workspace opencode.json confines file ops to the task worktree. Zero BrainOutput-funded inference.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { approvedWorkspaceRoots, resolveApprovedWorkspace } from "./workspace-registry.mjs";
import { detectNoWork } from "./work-evidence.mjs";

const HOME = process.env.HOME || homedir();

// Host-owned-credentials invariant: the sandboxed executor must receive NO credential-looking env
// var except the user's own model key (a user-funded connection's named apiKeyEnv). This defends
// against a hosted/founder credential (Anthropic/Kimi/…) leaking into the child even if one sits in
// the host process env. The executor never holds any credential the host didn't explicitly grant it.
const CREDENTIAL_ENV = /ANTHROPIC|CLAUDE|KIMI|MOONSHOT|OPENAI|OPENROUTER|GROQ|GEMINI|MISTRAL|_API_KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

// ── Loopback model gateway (task-pm-19) ─────────────────────────────────────────────────────────
// Anonymous free providers (OpenCode Zen) REJECT a bogus apiKey — and opencode always sends one
// when the config carries a literal like "local". CE's own calls send NO Authorization header and
// work. The fix: point those connections at a loopback gateway in web-server.mjs that holds the
// per-connection auth rules; the executor only gets a bearer for the gateway itself.
export const GATEWAY_TOKEN_ENV = "BO_OC_GATEWAY_TOKEN";
export const GATEWAY_PORT_ENV = "BO_OC_GATEWAY_PORT";
// Host-generated loopback gateway credentials — not user/provider keys, so the fail-closed guard
// below names them explicitly rather than widening the credential regex's exceptions.
const GATEWAY_ENV = new Set([GATEWAY_TOKEN_ENV, GATEWAY_PORT_ENV]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function isLoopbackEndpoint(endpoint) {
  try { return LOOPBACK_HOSTS.has(new URL(endpoint).hostname.toLowerCase()); } catch { return false; }
}

/** The gateway baseURL for a connection that must be gatewayed: funder "free" with NO key of any
 *  kind (anonymous) and a NON-loopback endpoint (a local endpoint never needs the gateway). Null
 *  when the connection stays direct (byte-compat) or no gateway port is in the run environment. */
export function gatewayBaseURL(connection, env = process.env) {
  if (!connection || connection.funder !== "free" || connection.apiKey || connection.apiKeyEnv) return null;
  if (isLoopbackEndpoint(connection.endpoint || "http://127.0.0.1:11434/v1")) return null;
  const port = env[GATEWAY_PORT_ENV];
  if (!port || !connection.id) return null;
  return `http://127.0.0.1:${port}/internal/oc/v1/${connection.id}`;
}

// Fail-closed guard: throw if `env` carries any credential var other than the connection's own user key.
export function assertHostOwnedCredentials(env, connection) {
  const allowed = connection && connection.funder === "user" ? connection.apiKeyEnv : null;
  for (const k of Object.keys(env)) {
    if (k === allowed || GATEWAY_ENV.has(k)) continue;
    if (CREDENTIAL_ENV.test(k))
      throw new Error(`executor env would leak a host credential (${k}); the host owns credentials — the executor gets only the user's own model key`);
  }
}

// Build the MINIMAL executor env from a whitelist. Only a user-funded connection's own key is passed
// through — never a hosted/founder credential, even one present in the host env. Guarded fail-closed.
export function buildExecutorEnv(connection, iso) {
  const env = {
    HOME: iso, XDG_CONFIG_HOME: join(iso, ".config"), XDG_DATA_HOME: join(iso, ".local", "share"),
    XDG_CACHE_HOME: join(iso, ".cache"), PATH: `${dirname(OPENCODE_BIN)}:/usr/local/bin:/usr/bin:/bin`,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  };
  if (connection && connection.funder === "user" && connection.apiKeyEnv && process.env[connection.apiKeyEnv])
    env[connection.apiKeyEnv] = process.env[connection.apiKeyEnv];
  // A gatewayed anonymous-free connection: the spawned opencode authenticates to the loopback
  // gateway with the host-generated token (resolved via {env:…} from the config — never written
  // to disk). The gateway then calls the provider with the connection's REAL auth rules.
  if (gatewayBaseURL(connection) && process.env[GATEWAY_TOKEN_ENV]) {
    env[GATEWAY_TOKEN_ENV] = process.env[GATEWAY_TOKEN_ENV];
    env[GATEWAY_PORT_ENV] = process.env[GATEWAY_PORT_ENV];
  }
  assertHostOwnedCredentials(env, connection);
  return env;
}
// The user's opencode binary (installed by `opencode` / `opencode upgrade`). Override with
// BO_OPENCODE_BIN if it lives elsewhere. Exported so opencode-server.mjs (the server-backed
// runtime, opt-in via BO_CE_OPENCODE_SERVER=1) resolves the SAME binary — never a divergent path.
export const OPENCODE_BIN = process.env.BO_OPENCODE_BIN || join(HOME, ".opencode", "bin", "opencode");

/** Is a coding runtime actually available? Coding missions degrade to chat delivery without one. */
export function opencodeAvailable() { return existsSync(OPENCODE_BIN); }

// Pure: turn a Community model connection into an isolated opencode config (no founder creds).
// Rejects any connection that isn't user/free/local (defense in depth with ce-core.validateConnection).
export function connectionToConfig(connection) {
  if (!connection || !["local", "user", "free"].includes(connection.funder))
    throw new Error(`opencode adapter refuses non-user/free/local connection (funder=${connection?.funder})`);
  const providerId = (connection.provider || "user-model").replace(/[^a-zA-Z0-9_-]/g, "-");
  // opencode wants the OpenAI-compatible BASE url (it appends /chat/completions).
  // An anonymous free connection goes through the loopback gateway (a bogus apiKey makes Zen
  // reject the call — the gateway strips it). BYOK/local keep their direct baseURL byte-exact.
  const gw = gatewayBaseURL(connection);
  const baseURL = gw || (connection.endpoint || "http://127.0.0.1:11434/v1").replace(/\/chat\/completions\/?$/, "");
  // The gateway token is referenced by NAME only — the written opencode.json carries no token value.
  const apiKey = gw ? `{env:${GATEWAY_TOKEN_ENV}}` : connection.apiKeyEnv ? `{env:${connection.apiKeyEnv}}` : (connection.apiKey || "local");
  const model = connection.model;
  return {
    modelRef: `${providerId}/${model}`,
    // Minimal config that matches a known-good manual run: just the user's provider + permissions.
    // The user's model is pinned via the --model flag. The isolated HOME/XDG has NO auth.json, so no
    // hosted/paid provider (kimi/anthropic/openai/…) can authenticate — isolation holds without a
    // disabled_providers list (which, for "opencode", actually hangs startup).
    config: {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      // Explicit belt on top of the auth-less isolation: BrainOutput's dev/paid providers are
      // disabled. NEVER include "opencode" here — disabling opencode's own provider hangs init.
      disabled_providers: ["kimi-for-coding", "moonshotai", "moonshotai-cn"],
      permission: { edit: "allow", write: "allow", bash: "allow", webfetch: "deny", external_directory: "deny" },
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: connection.name || `User model (${connection.provider})`,
          options: { baseURL, apiKey },
          models: { [model]: { name: model, limit: { context: connection.contextSize || 8192, output: 4096 } } },
        },
      },
    },
  };
}

// Prepare the isolated HOME/XDG + confined workspace an OpenCode process needs. Shared by the
// one-shot runner and the persistent server so both get IDENTICAL isolation guarantees.
// Returns the canonicalized workspace path and the isolated-home path.
export function prepareOpenCodeWorkspace({ connection, workspace, isoBase, approvedRoots }) {
  const { modelRef, config } = connectionToConfig(connection);
  // Approved-workspace registry (prod-readiness gap: repo registry): confine ALL file ops to an
  // approved root and refuse fail-closed if the requested path escapes it (traversal / absolute host
  // path / symlink escape). The canonicalized path `ws` is used everywhere below.
  const ws = resolveApprovedWorkspace(workspace, { roots: approvedRoots || approvedWorkspaceRoots(), create: true });
  // The isolated HOME must live OUTSIDE the workspace — if it's inside, opencode scans its own
  // config/cache as part of the project at init and hangs. Use a sibling dir.
  const iso = isoBase || `${ws.replace(/\/+$/, "")}__oc_iso`;
  mkdirSync(ws, { recursive: true });   // ensure the task workspace exists (git init below needs it)
  mkdirSync(join(iso, ".config", "opencode"), { recursive: true });
  mkdirSync(join(iso, ".local", "share", "opencode"), { recursive: true });
  mkdirSync(join(iso, ".cache", "opencode"), { recursive: true });
  // Warm the isolated cache with the public models.dev catalog so init is OFFLINE-RELIABLE
  // (avoids a network fetch that intermittently stalls opencode init). models.json is public
  // model metadata — NOT a credential; auth.json (Kimi) is deliberately never copied.
  try {
    const cat = process.env.BO_OPENCODE_MODELS_CACHE || join(HOME, ".cache", "opencode", "models.json");
    if (existsSync(cat)) copyFileSync(cat, join(iso, ".cache", "opencode", "models.json"));
  } catch {}
  writeFileSync(join(iso, ".config", "opencode", "opencode.json"), JSON.stringify(config, null, 2));
  // workspace permissions: allow work IN the workspace, deny reaching outside it or the network.
  writeFileSync(join(ws, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "allow", write: "allow", bash: "allow", webfetch: "deny", external_directory: "deny" },
  }));
  if (!existsSync(join(ws, ".git"))) { try { execFileSync("git", ["-C", ws, "init", "-q"]); } catch {} }
  try { execFileSync("git", ["-C", ws, "add", "-A"]); execFileSync("git", ["-C", ws, "-c", "user.email=ce@local", "-c", "user.name=ce", "commit", "-qm", "pre", "--allow-empty"]); } catch {}

  // Host-owned credentials (prod-readiness gap): minimal whitelisted env; only the user's own model
  // key is granted, guarded fail-closed against any hosted/founder credential leaking in.
  return { ws, iso, modelRef, env: buildExecutorEnv(connection, iso) };
}

// Start a PERSISTENT OpenCode server for a workspace. One server serves many task runs, so each run
// skips process boot + provider init + repo re-discovery (the cold-start tax). Same isolation as the
// one-shot path: identical iso HOME, identical confined workspace, identical credential guard.
// Returns { url, close() }. Callers MUST close() it.
export function startOpenCodeServer({ connection, workspace, isoBase, approvedRoots, bootTimeoutMs = 60000 }) {
  const { ws, iso, env } = prepareOpenCodeWorkspace({ connection, workspace, isoBase, approvedRoots });
  const args = ["serve", "--pure", "--port", "0", "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"];
  return new Promise((resolve, reject) => {
    // stdin closed for the same reason as `run` — an open stdin pipe makes opencode wait at init.
    const p = spawn(OPENCODE_BIN, args, { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
    let boot = "", settled = false;
    const close = () => { try { p.kill("SIGTERM"); } catch {} };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; close();
      reject(new Error(`opencode serve did not report a listening URL in ${bootTimeoutMs}ms: ${boot.slice(-500)}`));
    }, bootTimeoutMs);
    const scan = (chunk) => {
      if (settled) return;
      boot += chunk;
      // opencode prints the bound address on startup; accept either a full URL or host:port.
      const m = boot.match(/https?:\/\/127\.0\.0\.1:(\d+)/) || boot.match(/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      settled = true; clearTimeout(timer);
      resolve({ url: `http://127.0.0.1:${m[1]}`, port: Number(m[1]), ws, iso, env, close, proc: p });
    };
    p.stdout.setEncoding("utf8"); p.stdout.on("data", scan);
    p.stderr.setEncoding("utf8"); p.stderr.on("data", scan);
    p.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    p.on("close", () => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`opencode serve exited during boot: ${boot.slice(-500)}`)); }
    });
  });
}

// Read REAL per-session token accounting out of opencode's own store (`opencode export <id>`).
// The log line only carries tokens.output; the cold-start cost lives in input + cache.read, so
// measuring from the export is the only honest way to compare warm vs cold.
export function readSessionTokens({ sessionId, env }) {
  if (!sessionId) return null;
  try {
    const raw = execFileSync(OPENCODE_BIN, ["export", sessionId], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const t = JSON.parse(raw)?.info?.tokens;
    if (!t) return null;
    const input = Number(t.input || 0), output = Number(t.output || 0);
    const cacheRead = Number(t.cache?.read || 0), cacheWrite = Number(t.cache?.write || 0);
    return { input, output, reasoning: Number(t.reasoning || 0), cacheRead, cacheWrite,
             contextTotal: input + cacheRead + cacheWrite };
  } catch { return null; }
}

// Run a real OpenCode task. Returns structured result with logs, changed files, model, provider,
// cost source, tokens. NEVER touches BrainOutput's own hosted paid models (isolated env + disabled providers).
// Warm-session options (the cold-start fix): pass `attach` (a startOpenCodeServer url) to reuse a
// running server, and `session` + `fork` to inherit an already-warm context instead of rebuilding it.
export function runOpenCode({ connection, prompt, workspace, effort, isoBase, timeoutMs = 240000, approvedRoots,
                             attach = null, session = null, fork = false, task = null, locale = "en",
                             onSessionStart = () => {} }) {
  // Opt-in server-backed runtime (BO_CE_OPENCODE_SERVER=1): drives `opencode serve`'s v2 REST API
  // (see opencode-server.mjs, docs/OPENCODE_SERVER_API.md) instead of spawning `opencode run` per
  // task. This branch is the ENTIRE difference — when the flag is unset, every line below it runs
  // exactly as before, byte-identical. Dynamic import keeps this module free of a static dependency
  // on opencode-server.mjs (which itself imports FROM this module) so there is no import cycle.
  // NOTE: `attach`/`session`/`fork` (CLI-only warm-session reuse) are not yet supported by the
  // server-backed path and are silently ignored when the flag is on — no current caller passes them.
  // Three server-path-only additions, all no-ops on the CLI path below — passing them when the
  // flag is unset changes nothing:
  //  - `task` (skills/agentSlot directives) + `locale`: skill/agent routing onto the live OpenCode
  //    registry, and the localized context-compaction planner-defect signal.
  //  - `onSessionStart`: hands the live session id back mid-run for the live task view. The CLI
  //    path never has one, so it simply never calls the hook — honest, not faked.
  if (process.env.BO_CE_OPENCODE_SERVER === "1") {
    return import("./opencode-server.mjs").then(({ runOpenCodeServer }) =>
      runOpenCodeServer({ connection, prompt, workspace, effort, isoBase, timeoutMs, approvedRoots,
        task, locale, onSessionStart }));
  }
  const { ws, iso, modelRef, env } = prepareOpenCodeWorkspace({ connection, workspace, isoBase, approvedRoots });

  // --pure skips external plugins, which avoids opencode's slow background `bun install` at startup
  // (that ~60s step is what looked like an "init hang"). Provider config still loads.
  const args = ["run", "--pure", "--model", modelRef, "--print-logs", "--log-level", "INFO"];
  if (effort) args.push("--variant", effort);
  // Attach to a persistent server instead of booting a private one. --dir is the path ON that server.
  if (attach) args.push("--attach", attach, "--dir", ws);
  // Continue a specific session; --fork branches it so the parent stays clean and reusable.
  if (session) { args.push("--session", session); if (fork) args.push("--fork"); }
  args.push(prompt);

  return new Promise((resolve) => {
    let out = "", err = "";
    // stdin MUST be closed (ignore) — with an open stdin pipe opencode waits for interactive input
    // and hangs at init. stdout/stderr are captured.
    const p = spawn(OPENCODE_BIN, args, { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.setEncoding("utf8"); p.stdout.on("data", (d) => (out += d));
    p.stderr.setEncoding("utf8"); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      const log = err + out;
      // changed files = git diff since the pre-commit (the real evidence of what OpenCode did)
      let changedFiles = [];
      try { changedFiles = execFileSync("git", ["-C", ws, "diff", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => f !== "opencode.json"); } catch {}
      try { changedFiles.push(...execFileSync("git", ["-C", ws, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => f !== "opencode.json" && !f.startsWith(".oc-iso"))); } catch {}
      const providersUsed = [...new Set((log.match(/llm\.provider=([a-z0-9-]+)/gi) || []).map((s) => s.split("=")[1]))];
      const tokens = (log.match(/tokens\.output=(\d+)/g) || []).reduce((s, m) => s + Number(m.split("=")[1]), 0);
      const founderLeak = /api\.anthropic\.com|api\.kimi\.com|kimi-for-coding/i.test(log);
      // The session this run used (or forked into) — the handle a follow-up task forks from.
      const sessionId = (log.match(/ses_[A-Za-z0-9]+/) || [null])[0];
      // Exit 0 is NOT evidence of work. A headless run auto-REJECTS any permission that resolves
      // to "ask" and still exits 0; a stale $PWD points the agent at the wrong project entirely.
      // Both produce a confident "done" with an empty workspace — caught here, never reported ok.
      const { noWork, reason } = detectNoWork({ exitCode: code, changedFiles, log });
      resolve({
        ok: code === 0 && !founderLeak && !noWork, exitCode: code, model: connection.model, provider: connection.provider,
        costSource: connection.costSource, funder: connection.funder, tokens, providersUsed, changedFiles,
        founderCredentialUsed: founderLeak, log: log.slice(-4000),
        sessionId, tokensDetail: readSessionTokens({ sessionId, env }),
        noWork, noWorkReason: reason,
      });
    });
  });
}
