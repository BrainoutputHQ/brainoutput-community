#!/usr/bin/env bash
# BrainOutput Community Edition — one-command install (local alpha).
# Zero npm dependencies. Requires only Node ≥18 and at least one model source you own
# (a local model, a free model, or your own API key). Never needs a BrainOutput account,
# BrainOutput credits, Claude, or Kimi.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "BrainOutput Community Edition — install"
echo "======================================"

# 1) Node check
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required (≥18). Install from https://nodejs.org and re-run."; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "✗ Node ≥18 required (found $(node -v))."; exit 1; }
echo "✓ Node $(node -v)"

# 2) Prerequisite / model-source check
node bo-community.mjs doctor || true

# 3) Load the starter company into your local store (~/.local/share/bo-community by default)
echo
echo "Loading the starter company…"
node bo-community.mjs setup

cat <<'NEXT'

Install complete. Nothing here bills BrainOutput — $0 funded inference.

Start it:
  node bo-community.mjs serve         # web dashboard → http://127.0.0.1:4177
  node bo-community.mjs onboard        # or: guided first-run onboarding (auto-detect your models)
  node bo-community.mjs demo           # or: run the 3 sample workflows headless

Connect your own models (pick any):
  • Local:  install ollama, `ollama pull qwen2.5:3b` (see samples/connections.local.json)
  • Free:   a currently-available free OpenAI-compatible model (samples/connections.free.json)
  • BYOK:   your own provider key via an env var (samples/connections.byok.json)

Docs: QUICKSTART.md · TROUBLESHOOTING.md · SAFETY.md · FEEDBACK.md
NEXT
