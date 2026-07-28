# BrainOutput Community Edition — Quickstart (local alpha)

A configurable, token-efficient **AI company** that runs entirely on **your own free / local / BYOK
models**. Roles are durable; execution happens only when there's work. **It never uses a BrainOutput
account, BrainOutput credits, Claude, or Kimi — runs on your own models.**

## 1. Install (one command)
```bash
./install.sh
```
Requires only **Node ≥18** and at least one model source you own. No npm dependencies.

Check prerequisites any time:
```bash
node bo-community.mjs doctor
```

## 2. Connect a model (pick any — all run on models you own or control)
- **Local** (recommended): install [ollama](https://ollama.com), then `ollama pull qwen2.5:3b`
  (and optionally `qwen2.5:7b` for coding). See `samples/connections.local.json`.
- **Free**: a currently-available free OpenAI-compatible model. See `samples/connections.free.json`.
  The app only ever picks a free model that is actually available; it **never** falls back to paid.
- **BYOK**: your own provider key. `export USER_OWN_ANTHROPIC_KEY=sk-...` See
  `samples/connections.byok.json`. Your key stays local and is never stored in or exported with the
  company definition.

## 3. Run it
```bash
node bo-community.mjs serve      # web dashboard → http://127.0.0.1:4177
# or a guided first run that auto-detects your models:
node bo-community.mjs onboard
```
In the dashboard: connect models → describe your company + pick departments → review the generated
org → edit model assignments → submit an objective → watch it execute → see the result, model,
provider, **cost source**, tokens, artifacts, and any approvals. The header always shows
**Runs on your own models.**

## 4. Three sample workflows

Headless (runs all three against your local models, prints model/provider/cost source):
```bash
node bo-community.mjs demo
```

Or in the dashboard (page 6, *New objective*):

**A · Technical project** — Department `technical`, objective:
> *Add a `slugify(title)` function and a matching unit test.*
A clear task invokes only the **worker**; a complex one adds a **planner → compact PLAN → worker**.
(Repository coding through the OpenCode adapter uses your local/BYOK coding model.)

**B · Customer-service workflow** — Department `customer-service`, objective:
> *Reply in Spanish to: "¿Cómo restablezco mi contraseña?"*
A single fast multilingual worker on your local model.

**C · Finance workflow with human approval** — Department `finance`, objective:
> *Reconcile the ledger to the statement, then pay the balance.* — tick **needs human approval**.
Reconciliation runs as a **deterministic tool** (no model); **any payment requires you to approve**
in the execution view before it can proceed. (Invoice image extraction uses a **vision** model,
which is unconfigured by default → the app offers free/BYOK/local/stop, never a paid fallback.)

## 5. Save / move your company
```bash
node bo-community.mjs store show            # what's persisted (survives restarts)
node bo-community.mjs store export co.json  # export the company definition — NO credentials
node bo-community.mjs store import co.json   # load it elsewhere
```

See also: `SAFETY.md` (local-alpha notice), `TROUBLESHOOTING.md`, `FEEDBACK.md`.
