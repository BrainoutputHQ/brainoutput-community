# Work Twin

A **Work Twin** is a dedicated agent bound to **one human employee** and that person's authorized
workplace context. It is distinct from a departmental agent: it represents a *person*, not a function.

## Three permission modes

| mode | can do | cannot do |
|------|--------|-----------|
| **Mirror** *(default)* | read, search, summarize, explain | any external modification |
| **Copilot** | + prepare drafts, tasks, briefs, proposed actions | send anything |
| **Delegate** | + execute **explicitly granted** actions | act without a scoped grant and the applicable approval |

The mode is a **ceiling, never a bypass**. In Delegate mode an action *still* needs an explicit grant,
and sending/deleting/permission-changing/financial actions *still* need approval. `sensitive` is never
granted by mode alone. Where a real connector backs an account, **the connector has the final say** —
a twin can never exceed it.

## Two invariants

**1 · No silent impersonation.** Every draft carries attribution — *prepared by the Work Twin on behalf
of the employee*, `sent: false`, approval required to send — and every action writes an audit record:

```
represented employee · work twin · model · runtime · connected account
action · permission used · approval status · sources
```

**2 · The mailbox is not context.** The twin builds a deterministic index of **headers plus a bounded
snippet** — never full bodies — and retrieves only what the current request needs, source-referenced.
Permitted folders/labels gate what is even visible. When delegating, it sends a **compact task packet**
(facts · sources · constraints · permissions) with `mailboxForwarded: false` and
`transcriptForwarded: false`.

## Connected work sources

One abstraction, normalized messages and events (`mail-sources.mjs`):

| source | status |
|--------|--------|
| **IMAP / SMTP** (incl. self-hosted) | ✅ verified against a live IMAP/SMTP server |
| **Local / imported mail** — Maildir · mbox · JSON | ✅ verified |
| **Google Workspace / Gmail** | ⚠️ request shapes implemented; **unverified** — needs your OAuth credentials |
| **Microsoft 365 / Outlook** | ⚠️ request shapes implemented; **unverified** — needs your OAuth credentials |
| **Calendars** — iCalendar (.ics) files and **CalDAV** (Nextcloud, Radicale, Fastmail…) | ✅ verified (ICS); CalDAV client implemented |
| **Drives** — a folder on this computer, and **WebDAV/Nextcloud** | ✅ verified (local); WebDAV verified against a PROPFIND responder |
| **Google Drive · OneDrive · SharePoint** | ⚠️ request shapes implemented; **unverified** — need your OAuth credentials |
| **Workplace chat** — Slack · Discord · Mattermost (open-source) | read by default; posting needs a grant + approval |
| existing connectors & RAG | share the same abstraction |

**Every new connection defaults to Mirror (read-only).** Credentials stay local: a password is stored
in the local store (or referenced via `config.passwordEnv`) and is **stripped from every API response**.

## Documents

Documents are indexed the same way as mail — **metadata plus a bounded snippet, never whole files** —
and `searchFiles` / the chat search across mail *and* documents in one place, with citations.

## Financial accounts (`finance-connectors.mjs`)

**Plaid · Coinbase · Binance.** Reading (balances, transactions, positions) is allowed once connected.
Anything that **moves value** — an order, a transfer, a withdrawal — is `sensitive`: it needs a
**separate explicit grant AND a human approval every time**, a withdrawal destination must be on an
**allowlist**, and an optional **amount ceiling** applies. There is no setting that makes any of it
silent, and an unauthorized action is refused **before a request is ever built**. Plaid is read-only by
design here — no money movement at all. Signing is unit-tested (Binance against the published HMAC
test vector); the **live endpoints are unverified** — no bank or exchange credentials exist here.

## Capabilities

Unread & priority summary (with the *reason* each item is prioritized) · unanswered-thread detection ·
mail and attachment search · commitment/request/deadline extraction · reply drafting · meeting
preparation from mail + calendar · follow-up suggestions · **email → structured mission** · delegation
to a departmental agent · results returned to the Work Twin chat.

## Chat

Scopes: **My Work Twin · My Company · Department · Specific Agent**. The Work Twin chat understands
requests like:

- *"summarize important unanswered emails"*
- *"what commitments and deadlines do I have?"*
- *"draft a reply to the contract email"*
- *"create a mission from this email for the finance department"*
- *"ask the technical department to assess this commitment"*

Every reply shows its **sources** and the **permission** that allowed it. Intent matching is
deterministic, so the chat works even with no model configured; a model only writes prose.

## Dormancy

Work Twins are **dormant**. There is no timer and no polling anywhere in the module — a twin wakes on a
user request or a connector event (`onConnectorEvent`) and goes back to sleep. Indexing is deterministic.

## Onboarding

*"Connect your work and create your Work Twin"* → Continue with Google · Continue with Microsoft ·
Connect another email server · Use local/imported email · Skip for now → a concise permission screen →
**Mirror mode by default**.

Regular mode uses one model for the twin; Advanced mode can set separate conversation, planning,
drafting, reviewing and long-context models (`modelPolicy`).

API: `worktwin.mjs` · sources: `mail-sources.mjs` (mail + calendars), `drive-sources.mjs` (documents),
`finance-connectors.mjs` (bank/crypto) · tests: `worktwin.test.mjs`, `mail-sources.test.mjs`,
`drive-sources.test.mjs`, `finance-connectors.test.mjs`.
