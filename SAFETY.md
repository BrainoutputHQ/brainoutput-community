# BrainOutput Community Edition — Local Alpha Safety Notice

**This is early alpha software for local, technical evaluation. Read before use.**

## What it is
A local AI-company prototype. It routes objectives to agents and runs them on **your own** models.
It runs on your machine; there is no hosted BrainOutput service involved.

## Cost & credentials
- **You own every model — local, your subscription, or your own key.** The app cannot use any BrainOutput account or the
  BrainOutput's hosted paid models, and never silently falls back to a paid model. Any inference cost is on
  **your** free/local/BYOK source and is your responsibility.
- **Your API keys stay local.** BYOK connections reference an environment-variable *name*, never a
  key value. Exports of your company definition **exclude all credentials**.
- Review any **free** or **BYOK** provider's data-use / privacy terms before sending real data.

## Autonomy & approvals
- Agents are **dormant by default**; execution happens only for a submitted task.
- **Money movement, publishing, ad spend, employment decisions, deploys, and legal commitments
  require explicit human approval** — the app pauses and waits for you. Do not remove those gates.
- The model can produce wrong or unsafe output. **Review results before acting on them**, especially
  anything that touches money, customers, code you'll ship, or production systems.

## Data & isolation (alpha limitations)
- Coding tasks run with file access, but are **confined to an approved workspace root** (by default
  `<data-dir>/workspaces`; extend with `BO_CE_WORKSPACE_ROOTS`). A task whose path escapes that root
  — traversal, an absolute host path, or a symlink escape — is **refused fail-closed** before the
  executor starts. Still: point tasks at a **throwaway directory**, not a production repository, and
  treat all execution as **untrusted** on this alpha.
- Coding runs on an **isolated environment that receives only the model key you configured** — never
  a hosted/founder credential, even if one exists in your shell. The executor cannot reach the
  network for model calls beyond your configured endpoint (`webfetch`/external-dir denied).
- Local persistence is plain JSON under `~/.local/share/bo-community` (or `$BO_CE_DATA`). Back it up
  if it matters; it is not encrypted.
- No warranty. Do not use for anything safety-, security-, financial-, or legally-critical.

## Not required (by design)
BrainOutput credits · BrainOutput credentials · the internal agent fleet · Claude · Kimi · a hosted
BrainOutput account. If any prompt seems to ask for these, stop and report it (see `FEEDBACK.md`).
