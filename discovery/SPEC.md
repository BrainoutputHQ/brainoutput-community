# BrainOutput Discovery & Diagnostics — vertical slice spec

Pipeline, and it is one-directional:

    approved scope -> deterministic collectors -> normalized evidence
      -> rule-based checks -> [optional model: correlation/explanation ONLY]
      -> evidence-based findings -> remediation plan -> explicit approval before any change

## The rule that outranks every other

**A model may never invent a scan result, and may never replace a deterministic check.**
Every finding traces to an Observation produced by a collector. A model may group, rank and
explain findings; it may not create one. `explain()` is handed findings that already exist and
its output is stored in a separate field that carries no authority.

## Normalized schema (one shape for every platform)

    Observation { id, kind, subject, value, unit?, collector, method: "passive"|"active"|"api",
                  platform, at (epoch ms), confidence: 0..1, raw?: hash only }
    Asset       { id, kind, identifiers{mac,serial,hostname,ip[],certFingerprint,vendor},
                  firstSeen, lastSeen, observations[], uncertain?: reason }
    Finding     { id, severity, title, evidence[obsId], confidence, alternativeCauses[],
                  nextVerification, remediation{steps[], requiresApproval: true} }

Rules:
- Every collector declares `method`. Passive/API preferred; active needs explicit scope+limits.
- Identity correlation uses MAC > serial > certFingerprint > hostname > IP. **IP alone never
  merges two assets.** When evidence conflicts, keep both and set `uncertain`.
- Evidence is stamped. `staleAfterMs` is enforced: stale evidence is reported as stale, never
  presented as current.
- Large artifacts are hashed, not stored. Logs are bounded and redacted BEFORE storage.

## Safety (deterministic, not advisory)

- Default mode is **observe** (read-only). `act` requires explicit per-action approval.
- Nothing is scanned that is not in an approved scope. Approval names: CIDRs, hosts, accounts,
  collectors, intensity, and what may leave the machine.
- Forbidden, permanently: exploiting, brute force, password-hash collection, device modification,
  service restarts, config changes (DHCP/DNS/VLAN/AD/printer/PBX).
- Credentials never appear in argv, logs, prompts, exports or sync. Secrets resolve from the
  store's sealed vault at execution time only.
- Every command is shown before execution and appended to an audit record.

## Platform isolation

`collectors/<platform>.mjs` per OS. One normalized output. Never parse one OS's output as if it
were another's. Unsupported -> `{ supported: false, reason }`, never a guess.

## Privilege boundary

The runtime does NOT run as root. A privileged collector is a separate, small, auditable helper
invoked for one named task, with its command recorded. Absent privilege -> partial evidence with
a stated reason, never a silent gap.

## Adapters

Switch/VLAN/PoE, AD/Entra, IPBX/SIP, Wi-Fi, servers/backups, Odoo/Zendesk/Jira/GitHub/M365,
remote-site: INTERFACES ONLY in this slice. Each returns `unsupported` | `credentials-required`
| `partial-evidence` explicitly. No universal-support claims.

## Output

inventory · topology/dependencies · findings (evidence, timestamps, confidence, alternative
causes, recommended verification) · remediation plan · optional missions · prioritized AI
opportunities. **Never state financial or productivity gains without the assumptions beside them.**
