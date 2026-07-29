# BrainOutput Community — Clean Install (alpha)

The shortest reliable path to run BrainOutput Community on **your own free / local / BYOK models**.
No BrainOutput account, no BrainOutput API key — **runs on your own models**.

Requires only **Node.js ≥ 18**. (A local model via [Ollama](https://ollama.com) is optional but
recommended for real runs.)

## Clean-install command

```bash
git clone https://github.com/BrainoutputHQ/brainoutput-community.git
cd brainoutput-community
node bo-community.mjs setup      # loads a starter company (agents dormant)
node bo-community.mjs serve      # dashboard → http://127.0.0.1:3100
```

First run with **no company yet** launches onboarding automatically (`node bo-community.mjs onboard`).

Verify the whole path in a throwaway temp dir (touches nothing of yours):

```bash
npm run smoke:community-clean
# → ✓ CLEAN-INSTALL SMOKE PASSED — 12/12 checks · runs on your own models
```

## Uninstall / cleanup

All state lives in one directory — remove it and you're clean:

```bash
rm -rf ~/.local/share/bo-community     # or: rm -rf "$BO_CE_DATA"
```

Then delete the cloned folder. No system packages, services, or global installs are created.

## Sample configuration

Ready-made samples are in [`samples/`](samples/):

- `samples/starter-company.json` — a small technical / customer-service / finance company.
- `samples/connections.local.json` — local (Ollama) model connections.
- `samples/connections.free.json` — free-model connections.
- `samples/connections.byok.json` — bring-your-own-key connections (env-var **names** only).

Point setup at one with: `node bo-community.mjs setup --config samples/starter-company.json`.

## Local-model example (Ollama)

```bash
ollama pull qwen3-coder-30b          # any OpenAI-compatible local model works
node bo-community.mjs doctor    # detects local models on 127.0.0.1:11434
```

Connection shape (cost source = your machine):

```json
{ "id": "local:qwen", "kind": "local", "provider": "ollama", "model": "qwen3-coder-30b",
  "endpoint": "http://127.0.0.1:11434/v1/chat/completions", "costSource": "local-compute", "funder": "local" }
```

## Free-model example

```json
{ "id": "free:coder", "kind": "opencode-free", "provider": "opencode-free",
  "model": "(current free coding model)", "costSource": "free", "funder": "free" }
```

Free models are paid for by the **provider**, not you and not BrainOutput. If a free model is
unavailable, BrainOutput leaves the slot **unconfigured** and offers free / BYOK / local / stop — it
**never** falls back to a paid model.

## BYOK example (bring your own key)

Set your key in the environment, then reference it by **name** (the key value is never written to disk):

```bash
export USER_OWN_OPENROUTER_KEY=sk-...
```

```json
{ "id": "byok:openrouter", "kind": "byok", "provider": "openrouter", "model": "your/model",
  "endpoint": "https://openrouter.ai/api/v1/chat/completions", "apiKeyEnv": "USER_OWN_OPENROUTER_KEY",
  "costSource": "user-api-account", "funder": "user" }
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SMOKE FAILED: …` | Node ≥ 18? Run from the repo root. A blocked 127.0.0.1 port can fail the stub server. |
| `node: command not found` | Install Node.js ≥ 18 (`node --version`). |
| Dashboard won't load | Check the port in the `serve` output; set `BO_CE_WEB_PORT` to change it. |
| "No local model detected" | Start Ollama (`ollama serve`) or connect a free/BYOK model in the dashboard. |
| A task says `UNCONFIGURED` | That capability slot has no model — assign free / BYOK / local (never auto-paid). |
| Model call failed | The demo/dashboard prints an actionable message; connect a model or run with `--dry`. |

## Alpha safety notice

This is **early alpha software for local, technical evaluation**. See [`SAFETY.md`](SAFETY.md) for the
full notice. In short: agents are **dormant** until you submit an objective; money movement /
publishing / deploys require **human approval**; your API keys stay local (env-var names only);
**Every model is your own** and there is no paid automatic fallback. Review any
free/BYOK provider's data-use terms before sending real data.
