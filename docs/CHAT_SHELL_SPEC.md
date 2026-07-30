# Chat-Native Shell — Product Spec (CE, Apache-2.0)

Status: founder-approved direction (Directive 6, 2026-07-30). Replaces the multi-tab
dashboard as the primary UX. The dashboard remains as an advanced/inspect surface.

## Principle

Familiar first: anyone who has used a mainstream chat assistant is trained in
seconds. **Everything is a message** — tasks, plans, approvals, artifacts, reports
are cards inside the thread, not destinations elsewhere.

## Layout

```
┌──────────────┬────────────────────────────────────────┐
│ Projects     │  # <active thread>                     │
│ ▸ project A  │  messages…                             │
│ ▸ project B  │  ┌─ task card ─ status · assignee ──┐  │
│ + New project│  │  3/7 done · blocked: API keys    │  │
│              │  └──────────────── [open in place] ─┘  │
│ Ad-hoc       │  ┌─ plan card ─ 4 steps ────────────┐  │
│ · thread …   │  └─────────────────── [approve] ────┘  │
│              │  ┌─ artifact ─ index.html ─────────┐  │
│              │  └─────────────────── [preview] ────┘  │
│              │  every reply: model · cost · sources   │
└──────────────┴────────────────────────────────────────┘
```

## Objects (all rendered in-thread)

- **Thread** — belongs to a project or to Ad-hoc. One click promotes ad-hoc → project.
- **Project** — sidebar folder grouping threads, tasks, artifacts; durable memory
  anchor (project summary pinned; recall via RAG with citations).
- **Task card** — from MissionSpec: objective, acceptance criteria, status,
  assignee (agent/human), result link.
- **Plan card** — proposed execution graph (smallest-sufficient); inline
  approve/reject; edits before approval allowed.
- **Approval card** — any sensitive/financial/communicate action; blocks until a
  human decides; shows exactly what will happen.
- **Artifact card** — files produced, previewable in place, downloadable.
- **Report card** — scheduled-task output (e.g. weekly figures), posted by cron,
  never by agent heartbeats.
- **Metadata line** — under every reply: model, provider, cost source, permission
  used, sources cited.

## Behavior

- Ask → answer with citations (read-only). Plan → draft plan card, never writes.
  Execute → requires approved plan (existing chat.mjs guards; unchanged).
- System asks clarifying questions when a task is underspecified; one bounded
  planner pass for multi-step work (no manager agents).
- Ad-hoc asks (CLI or UI) route through the same smallest-graph router; no project
  required. Diagnostics packs (discovery) answer infra questions like "why can't
  I reach the printer".
- Memory = project summaries + Plane-free local store + RAG over docs/threads.
  Nothing is kept in prompts; transcripts never forwarded (existing invariant).

## i18n

Message catalogs from day one — zero hardcoded strings. Launch: en, fr, de (real,
reviewed). Replies follow the user's language; system prompts stay English.

## Edition boundary

This shell ships in CE (Apache-2.0): single user, one personal Alter,
mail/calendar/files connectors, local/BYOK models. Pro (cloud repo): multi-employee
roles/SSO/audit, voice, ERP/PMS/social packs, hosted control plane.

## Non-goals (v1)

No multi-user, no voice, no third-party connector writes, no decorative
agent-to-agent conversations, no mobile app.
