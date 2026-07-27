# BrainOutput Community Edition — configurable AI company (vertical slice)

A token-efficient AI company where **roles are durable but execution is on-demand**, and every
model is **user-owned / free / local**. HARD INVARIANT: **zero BrainOutput-funded inference** — the
BrainOutput's hosted paid models are dev-only and can never be a Community model connection.

> The role persists; the execution context is created only when work exists.

## Concepts (`ce-core.mjs`)
- **Agent Profile** (durable role): id, department, objectives, instructions, tools, knowledge,
  permissions, approval thresholds, **capability slots** (planner/worker/reviewer), privacy & cost
  policy, activation rules. Deployed **dormant** by default; no idle runs, no LLM heartbeats.
- **Capability Slot** (logical requirement): `reasoning-premium/-free`, `coding-premium/-free`,
  `fast-cheap`, `long-context`, `vision`, `voice`, `embeddings`, `multilingual`, `private-local`,
  `high-trust-review`. Agents reference **slots**, never provider/model names.
- **Model Connection** (`validateConnection`): a user/free/local inference source with a
  `costSource` (free · user-subscription · user-api-account · local-compute) and `funder`
  (free · user · local). `funder: "brainoutput"` or BrainOutput's dev credential is **rejected**.
- **Model Assignment**: user-configurable `slot → connection` map (`departments.mjs` gives
  per-department defaults; the user overrides everything).
- **Execution Graph** (`planGraph`): the **smallest** shape that fits — single · planner-worker ·
  planner-parallel-workers · worker-reviewer · agent-tool · agent-approval-action. No planner for a
  clear task; no reviewer unless risk/policy requires; no CEO unless genuinely strategic.
- **Router** (`routeTask`): department + role + task → agent → smallest graph → least-cost permitted
  model per node. Throws if any node would use BrainOutput-funded inference; unassigned slots →
  offer free/BYOK/local/stop, **never** an automatic paid fallback.
- **Free catalog** (`makeCatalog`): refreshable, health-checked; the free profile picks only
  currently-available free models — never one hardcoded model.

## Adapters (`adapters.mjs`) — executor-neutral
`deterministic-workflow` (no model) · `local-openai-compatible` (ollama/vLLM, local compute) ·
`generic-llm-agent` (OpenAI-compatible free/BYOK) · `human-approval` (a person authorizes actions) ·
`opencode` (repo work through the hardened sandbox with a user/local coding model). Claude Code /
Codex / Hermes are optional later adapters.

## Run the vertical slice
```
node community/bo-ce.mjs          # real local inference via ollama ($0 BrainOutput)
node community/bo-ce.mjs --dry    # routing + graphs + cost sources, no inference
node --test community/ce-core.test.mjs
```
Demo (`demo/company.json`): three departments with **different** models — Technical (premium
planner + free/local coding worker), Customer Service (multilingual worker), Finance (deterministic
reconciliation + human-approved payment; vision slot intentionally unconfigured to show the
no-paid-fallback path). Every run reports model/provider/tokens/**cost source**/artifacts and
asserts BrainOutput-funded tokens = 0.
