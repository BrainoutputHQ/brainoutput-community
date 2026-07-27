#!/usr/bin/env node --test
// Tests for the real OpenCode adapter's config generation + isolation guarantees (pure; no run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionToConfig } from "./opencode-adapter.mjs";

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
