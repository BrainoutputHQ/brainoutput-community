# Connectors & permissions

An agent reaches a business system through a **connector** with **explicit, scoped permissions**.
The rule that never bends: **a newly connected system is read-only**, and writes / communication /
destructive / financial / permission-changing actions each need a **separate explicit grant** *and*
**human approval** by risk policy. Community Edition may support writes — but **never silently**.

## Mechanisms (`connectors.mjs`)

`oauth · api-key-local · mcp · openapi · webhook · database · file-rag · chat`. Auth references a
**locally-stored** secret (an env-var name) — a credential value is never copied into the connector.

## Scopes (increasing capability / risk)

| scope | meaning | default? | approval |
|-------|---------|----------|----------|
| `read` | read data | ✅ allowed by default | none |
| `draft` | prepare content, don't send | ✅ allowed by default | none |
| `write` | create / update records | ❌ needs a grant | human (default) |
| `communicate` | send externally (email, chat, SMS) | ❌ needs a grant | human (default) |
| `sensitive` | destructive · financial · permission-changing | ❌ needs a grant | **human, always** |

Scopes are **separate capabilities, not a hierarchy** — granting `communicate` never implies `write`.
`actionScope(verb)` maps an action to its scope; an **unknown mutating verb is `write`, never read**.

## Permissions per org / department / agent / tool / action / resource

`grantScope(connector, { scope, principal:{level,id}, tool?, action?, resource? })` adds a grant.
`principal.level` is `organization ⊇ department ⊇ agent`. A grant can be narrowed to a specific
tool, action, and resource/channel. `sensitive` is forced to human approval regardless of the grant.

## Resolving a permission

```js
import { newConnector, grantScope, resolvePermission } from "./connectors.mjs";

let z = newConnector("zendesk");                       // read-only
resolvePermission(z, { action: "read-ticket" });        // { allowed:true,  requiresApproval:false }
resolvePermission(z, { action: "send-reply" });         // { allowed:false } — no grant

z = grantScope(z, { scope: "communicate", principal: { level: "agent", id: "cs-agent" } });
resolvePermission(z, { action: "send-reply", agent: { id: "cs-agent" } });
// { allowed:true, requiresApproval:true } — granted, but never silent
```

`resolvePermission` **decides**; it never executes. The runtime honours the decision: a `read`/`draft`
runs; anything `requiresApproval` stops at the human-approval gate.

Initial targets: **GitHub · Jira · Odoo · Zendesk · Twilio** + generic **MCP · OpenAPI · RAG/file ·
chat** connectors. Tests: `connectors.test.mjs`.
