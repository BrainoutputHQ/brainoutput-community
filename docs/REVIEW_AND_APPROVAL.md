# Review & approval — an agent CTO/legal reviewer, a minimized human

BrainOutput Community Edition ships **governance as first-class execution nodes**, not as a standing
management hierarchy. A worker finishes; its output is validated; a person is pulled in **only when
the agent reviewer can't clear it** — and when they are, they get a decision-ready brief.

## The two primitives

1. **Reviewer node** (`worker-reviewer`) — an *independent* agent that validates the worker's output.
   It is not a manager and not a relay; it's a peer/specialist check added **only when risk or a
   bound policy requires it** (`planGraph`: `no reviewer unless risk/policy requires`).
2. **Human-approval gate** (`agent-approval-action`) — pauses for a person; **never runs a model**.
   Two flavours:
   - **Unconditional** — a hard real-world mutation (moving money, a deploy) always needs a human.
   - **Conditional** — a policy escalation where the reviewer AGENT clears it, and a human is pulled
     in **only on a flag** (`autoApproveWhenClear: true`). This is the human-minimized path.

## Where the reviewer gets "the instructions for what it validates"

The reviewer does **not** load the worker's raw instructions. The router binds the **policies**
relevant to the work — by department and/or task tag (`selectPolicies`) — and loads **their criteria**
into the reviewer node (`reviewCriteria`). The worker operated under those policies; the reviewer now
validates against exactly them. Only the relevant policies load, so the context stays small.

```
company.policies ──selectPolicies(dept, tags)──▶ bound policies
                                                     │ .criteria
                          reviewer node ◀────────────┘   (reviewContextFor → what it checks against)
```

Add a policy once; every task it binds to gets the reviewer + the gate automatically. No policy on a
task → no reviewer, no gate (smallest sufficient graph).

## The chain (what actually runs)

```
worker (drafts)  →  reviewer AGENT (validates vs the bound policy criteria → {pass, flags[]})
                 →  human-approval gate:
                       reviewer PASS  → auto-cleared        (human stays out)
                       reviewer FLAG  → pending-human-approval + maximum-information BRIEF
```

The **brief** (`escalationBrief`) is a complete, decision-ready package so the human does a fast
yes/no, not research: what was produced, the artifact, every criterion checked, the specific flags,
the reviewer's recommendation, and the single decision to make.

## Worked example — the brainoutput.com `/runtime/` copy (the real case)

Policy `legal-copy-review` (see `demo/company.json`) binds to `department: marketing` **or** tag
`publish-copy`. Its criteria encode exactly the rules our website copy must satisfy:

- claims are honest and verifiable (no unverifiable superlatives);
- no legally-signed / compliance-reviewed wording is altered without re-review;
- data-residency / privacy (DSGVO) statements stay accurate;
- "open source" and pricing claims match the actual license and terms.

Run it (`node bo-community.mjs demo`, scenarios **D1/D2**):

- **D1** — copy: *"Open source. Run it free, host it, or have us build on it."* → reviewer **PASS** →
  gate **auto-cleared**, no human needed.
- **D2** — copy: *"the #1 open-source AI company, MIT-licensed"* → reviewer **FLAGS** two claims
  (`'#1'` is unverifiable; the license is Apache-2.0, **not** MIT) → **escalates to a human with a
  brief**. This is precisely the CTO/legal copy pass — done by an agent, escalated to a person only
  when it must be, with everything the person needs to decide in one place.

## Why this is not "going back to management agents"

The token-efficiency direction removed **management relay** (agents impersonating a CEO/CTO to pass
work along or hold meetings — no decision, pure overhead). It never removed review/approval. Those
live here as targeted nodes added by policy, with the binding sign-off held by a human — leaner than
a hierarchy and safer, because the safety was always in the gate, not the org chart.

API: `selectPolicies` · `planGraph` · `reviewContextFor` · `resolveApprovalGate` · `escalationBrief`
(`ce-core.mjs`); gate resolution in `executePlan` (`adapters.mjs`). Tests: `policies.test.mjs`.
