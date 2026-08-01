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

const HOME = process.env.HOME || homedir();

// Host-owned-credentials invariant: the sandboxed executor must receive NO credential-looking env
// var except the user's own model key (a user-funded connection's named apiKeyEnv). This defends
// against a hosted/founder credential (Anthropic/Kimi/…) leaking into the child even if one sits in
// the host process env. The executor never holds any credential the host didn't explicitly grant it.
const CREDENTIAL_ENV = /ANTHROPIC|CLAUDE|KIMI|MOONSHOT|OPENAI|OPENROUTER|GROQ|GEMINI|MISTRAL|_API_KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

// Fail-closed guard: throw if `env` carries any credential var other than the connection's own user key.
export function assertHostOwnedCredentials(env, connection) {
  const allowed = connection && connection.funder === "user" ? connection.apiKeyEnv : null;
  for (const k of Object.keys(env)) {
    if (k === allowed) continue;
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
  assertHostOwnedCredentials(env, connection);
  return env;
}
// The user's opencode binary (installed by `opencode` / `opencode upgrade`). Override with
// BO_OPENCODE_BIN if it lives elsewhere.
const OPENCODE_BIN = process.env.BO_OPENCODE_BIN || join(HOME, ".opencode", "bin", "opencode");

/** Is a coding runtime actually available? Coding missions degrade to chat delivery without one. */
export function opencodeAvailable() { return existsSync(OPENCODE_BIN); }

// Pure: turn a Community model connection into an isolated opencode config (no founder creds).
// Rejects any connection that isn't user/free/local (defense in depth with ce-core.validateConnection).
export function connectionToConfig(connection) {
  if (!connection || !["local", "user", "free"].includes(connection.funder))
    throw new Error(`opencode adapter refuses non-user/free/local connection (funder=${connection?.funder})`);
  const providerId = (connection.provider || "user-model").replace(/[^a-zA-Z0-9_-]/g, "-");
  // opencode wants the OpenAI-compatible BASE url (it appends /chat/completions).
  const baseURL = (connection.endpoint || "http://127.0.0.1:11434/v1").replace(/\/chat\/completions\/?$/, "");
  const apiKey = connection.apiKeyEnv ? `{env:${connection.apiKeyEnv}}` : (connection.apiKey || "local");
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

// Run a real OpenCode task. Returns structured result with logs, changed files, model, provider,
// cost source, tokens. NEVER touches BrainOutput's own hosted paid models (isolated env + disabled providers).
export function runOpenCode({ connection, prompt, workspace, effort, isoBase, timeoutMs = 240000, approvedRoots }) {
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

  // --pure skips external plugins, which avoids opencode's slow background `bun install` at startup
  // (that ~60s step is what looked like an "init hang"). Provider config still loads.
  const args = ["run", "--pure", "--model", modelRef, "--print-logs", "--log-level", "INFO"];
  if (effort) args.push("--variant", effort);
  args.push(prompt);
  // Host-owned credentials (prod-readiness gap): minimal whitelisted env; only the user's own model
  // key is granted, guarded fail-closed against any hosted/founder credential leaking in.
  const env = buildExecutorEnv(connection, iso);

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
      resolve({
        ok: code === 0 && !founderLeak, exitCode: code, model: connection.model, provider: connection.provider,
        costSource: connection.costSource, funder: connection.funder, tokens, providersUsed, changedFiles,
        founderCredentialUsed: founderLeak, log: log.slice(-4000),
      });
    });
  });
}
