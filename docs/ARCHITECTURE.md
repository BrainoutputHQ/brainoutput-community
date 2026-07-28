# Editions & repository architecture

Founder decision (2026-07-28). **One authoritative `main` branch per repository — never permanent
`community`/`hosted` branches in the same repo.**

## Repositories

| repo | visibility | contains |
|------|-----------|----------|
| **brainoutput-community** | public | the complete Community Edition — runtime, UI, agent schemas, model routing, execution graphs, free/BYOK/local support, runtime adapters, connector SDK, permissions, RAG, local persistence, local install. |
| **brainoutput-cloud** | private | **only** managed-service extensions: multi-tenancy, hosted sandboxes, billing, managed secrets, provisioning, backups, upgrades, observability, enterprise identity, usage metering, cloud deploy infra. |
| **brainoutput-hq** | private | BrainOutput's own operational company config, internal agents, founder directives, dev automation. **Not** the hosted customer product repo. |

**The hosted product consumes a PINNED, versioned Community release — it must not copy or fork Community
runtime code.**

## Package boundary

- **Community packages:** `runtime-core · agent-schema · capability-model-router · execution-graph ·
  connector-sdk · permissions · opencode-adapter · generic-agent-adapter · local-persistence`.
- **Cloud-only packages:** `control-plane · tenant-manager · billing · hosted-sandbox · managed-secrets ·
  fleet-provisioning · enterprise-policy · cloud-observability`.

These lists live in `editions.mjs` and are **enforced**: `boundary.test.mjs` fails the build if any
Community source imports a cloud package or defines a cloud-only module. That is the "prevent hosted-only
code from entering Community" guard — no big migration required.

## Edition-capability interface (`editions.mjs`)

Cloud adds capabilities by **registering providers**, not by editing Community core. Community ships a
**local default** for every capability point (`secrets · persistence · sandbox · observability · identity
· metering · tenancy · deploy · backups · billing`); core code resolves through `withCapability(name,
default)`, so there are **no cloud conditionals in Community**.

```js
// In Community core — no knowledge of Cloud:
import { withCapability } from "./editions.mjs";
const secrets = withCapability("secrets");        // → { kind: "local-env" } by default

// In brainoutput-cloud (private), at startup:
registerCapability("secrets", vaultProvider);     // Community core now uses the vault, unchanged
```

## Hosted release manifest

Every hosted release records (via `hostedReleaseManifest`): **Community version + commit**, **Cloud
version + commit**, **schema/migration version**, **connector catalog version**.

## Branches & deploys

Feature and release branches are **temporary**. **Staging and production deploy from immutable tags or
commits — never from permanent environment branches.**

## Migration posture

Do **not** interrupt the Community alpha for a large repo migration. The boundary is documented and
guarded now; any code moves happen later, incrementally, in bounded tasks.
