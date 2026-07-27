#!/usr/bin/env node --test
// Tests for the real OpenCode adapter's config generation + isolation guarantees (pure; no run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionToConfig, buildExecutorEnv, assertHostOwnedCredentials } from "./opencode-adapter.mjs";

const OLLAMA = { id: "local:q", kind: "local", provider: "ollama", model: "qwen2.5:7b", endpoint: "http://127.0.0.1:11434/v1/chat/completions", costSource: "local-compute", funder: "local", contextSize: 8192 };
const BYOK = { id: "byok:x", kind: "byok", provider: "user-openai", model: "gpt-4o", endpoint: "https://api.example.com/v1", apiKeyEnv: "USER_OWN_KEY", costSource: "user-api-account", funder: "user" };

test("connectionToConfig builds an isolated provider from a local connection", () => {
  const { modelRef, config } = connectionToConfig(OLLAMA);
  assert.equal(modelRef, "ollama/qwen2.5:7b");
  assert.equal(config.provider.ollama.options.baseURL, "http://127.0.0.1:11434/v1"); // /chat/completions stripped
  assert.equal(config.provider.ollama.options.apiKey, "local");
  assert.ok(config.provider.ollama.models["qwen2.5:7b"]);
});

test("BrainOutput's dev model provider is disabled; the user's model is pinned; permissions confine writes", () => {
  const { config } = connectionToConfig(OLLAMA);
  // BrainOutput's dev/paid provider is disabled; NOT "opencode" (disabling it hangs init) and not
  // anthropic/openai (isolation is via the auth-less isolated HOME/XDG — no key = unusable).
  assert.ok(config.disabled_providers.includes("kimi-for-coding"));
  assert.ok(!config.disabled_providers.includes("opencode"));
  assert.ok(config.provider.ollama, "user's provider present");
  assert.equal(config.permission.external_directory, "deny");   // writes confined to the workspace
});

test("BYOK connection references the user's own key env, never a literal or founder key", () => {
  const { config } = connectionToConfig(BYOK);
  assert.equal(config.provider["user-openai"].options.apiKey, "{env:USER_OWN_KEY}");
  assert.equal(config.provider["user-openai"].options.baseURL, "https://api.example.com/v1");
});

test("the adapter REFUSES any BrainOutput-funded connection", () => {
  assert.throws(() => connectionToConfig({ ...OLLAMA, funder: "brainoutput" }), /refuses|user\/free\/local/i);
  assert.throws(() => connectionToConfig(null), /refuses|user\/free\/local/i);
});

// Host-owned credentials: the executor gets a minimal whitelisted env — never a hosted/founder key.
test("buildExecutorEnv grants a local connection NO credential env", () => {
  process.env.ANTHROPIC_ADMIN_KEY = "sk-should-not-leak";       // a hosted cred sitting in the host env
  process.env.KIMI_API_KEY = "sk-should-not-leak-either";
  const env = buildExecutorEnv(OLLAMA, "/tmp/iso-x");
  assert.ok(!("ANTHROPIC_ADMIN_KEY" in env) && !("KIMI_API_KEY" in env), "no host credential leaks to the executor");
  assert.ok(env.HOME === "/tmp/iso-x" && env.OPENCODE_DISABLE_AUTOUPDATE === "1");
  delete process.env.ANTHROPIC_ADMIN_KEY; delete process.env.KIMI_API_KEY;
});

test("buildExecutorEnv passes ONLY the user's own key for a user-funded BYOK connection", () => {
  process.env.USER_OWN_KEY = "sk-user";
  process.env.OPENAI_API_KEY = "sk-not-mine";                   // some other hosted key in the env
  const env = buildExecutorEnv(BYOK, "/tmp/iso-y");
  assert.equal(env.USER_OWN_KEY, "sk-user", "the user's own named key is granted");
  assert.ok(!("OPENAI_API_KEY" in env), "an unrelated hosted key is NOT granted");
  delete process.env.USER_OWN_KEY; delete process.env.OPENAI_API_KEY;
});

test("assertHostOwnedCredentials throws if a hosted credential would reach the executor", () => {
  assert.throws(() => assertHostOwnedCredentials({ ANTHROPIC_API_KEY: "x" }, { funder: "local" }), /leak a host credential/);
  // the user's OWN named key on a user connection is allowed through
  assert.doesNotThrow(() => assertHostOwnedCredentials({ USER_OWN_KEY: "x" }, { funder: "user", apiKeyEnv: "USER_OWN_KEY" }));
});
