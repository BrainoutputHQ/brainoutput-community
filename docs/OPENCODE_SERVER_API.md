# OpenCode `serve` v2 REST API — pinned contract

Spike output. Pins the exact request/response contract of the OpenCode `serve` v2 REST API
as exercised end-to-end by `tools/oc-api-probe.mjs` (same directory as this doc's parent).

- Binary: `~/.opencode/bin/opencode`, version **1.18.7**.
- Everything below was read from the live OpenAPI document served at `GET /doc` on a running
  `opencode serve` instance, with every `$ref` resolved by hand (`#/components/schemas/...`
  chains). Nothing here is guessed from memory of other opencode versions.
- All endpoints below are driven **only** over HTTP by `tools/oc-api-probe.mjs` — the `opencode
  run` CLI is never invoked.

Run it yourself: `node tools/oc-api-probe.mjs` (zero deps, Node >= 18). It starts a server on a
random port in a throwaway `/tmp` workspace, runs a real prompt through a real model, asserts a
file landed on disk with the exact expected content, prints real token accounting, and cleans up
after itself — twice in a row, see "Verification" at the bottom.

---

## 1. Starting the server

```
~/.opencode/bin/opencode serve --port <N> --hostname 127.0.0.1
```

Stdout: `opencode server listening on http://127.0.0.1:<N>`.
Stderr: `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` (expected/fine for
loopback-only use).

### Two setup traps that will silently produce a no-op run

1. **Workspace permissions.** A headless run auto-rejects any permission that would resolve to
   `"ask"`, then exits having done nothing — no error, no event, nothing. The workspace directory
   needs an `opencode.json`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "permission": {
       "edit": "allow",
       "write": "allow",
       "bash": "allow",
       "webfetch": "deny",
       "external_directory": "allow"
     }
   }
   ```

2. **`$PWD` vs. `location.directory`.** opencode resolves its project root from `$PWD`, and
   `child_process.spawn(cmd, {cwd})` does **not** update the inherited `PWD` env var — so a naive
   spawn can end up rooted in the wrong directory ("no AGENTS.md in this workspace, nothing to
   change"). Two independent fixes, both used by the probe script (belt and suspenders):
   - set `env: {...process.env, PWD: scratchDir}` on the spawned server process, **and**
   - pass `location: {directory: scratchDir}` explicitly in the `POST /api/session` body (see
     §3). This field is real and works — confirmed by starting a server with `cwd`/`PWD` pointed
     at an unrelated directory and still getting a session (and a real file write) correctly
     rooted at the `location.directory` we passed. This is the *more* robust of the two and
     should be treated as authoritative; the `PWD` trick is a fallback in case some internal code
     path still consults it.

---

## 2. `GET /api/health`

No auth, no params.

**Response 200:**
```json
{"healthy": true}
```

---

## 3. `POST /api/session` — create a session

**Request body** (all fields optional; `additionalProperties: false`):
```json
{
  "id": "ses_...",              // optional, must match ^ses if provided
  "agent": "string",            // optional
  "model": { "id": "...", "providerID": "..." },   // optional, see ModelRef in §5
  "location": { "directory": "/abs/path", "workspaceID": "wrk..." }  // optional; "directory" required if object present
}
```

The probe always passes `{"location":{"directory": scratchDir}}` — see the `$PWD` trap above.

**Response 200** — `{"data": SessionV2Info}`:
```json
{
  "data": {
    "id": "ses_034c5f953ffelXi6zJpo0gOiD9",
    "projectID": "global",
    "model": { "id": "coder", "providerID": "brainoutput-local", "variant": "default" },
    "cost": 0,
    "tokens": {
      "input": 0, "output": 0, "reasoning": 0,
      "cache": { "read": 0, "write": 0 }
    },
    "time": { "created": 1785821005653, "updated": 1785821005653 },
    "title": "New session - 2026-08-04T05:23:25.653Z",
    "location": { "directory": "/tmp/oc-api-probe-44ff3f13fdd1" },
    "subpath": "tmp/oc-api-probe-44ff3f13fdd1"
  }
}
```
`tokens` is present but — see §8 — it stays all-zero for the lifetime of the session in this
build even after a real run completes. Do not use this field for accounting.

---

## 4. `GET /api/model` — list the v2-visible model catalog

Query: optional `location` (deepObject: `location[directory]`, `location[workspace]`).

**Response 200** — `{"location": LocationInfo, "data": ModelV2Info[]}`. Each entry has (at
minimum) `id`, `providerID`, `family`, `name`, `capabilities`, `limit.context`, `limit.output`,
`status`.

**Gotcha (reproduced twice):** on a **brand-new** scratch workspace, the very first `GET
/api/model` call — issued immediately after `GET /api/health` already reports `{"healthy":true}`
— can return `{"data": []}` (empty). The catalog warms up asynchronously; it was consistently
populated (36 entries in our environment) within ~1–3 seconds. The probe script polls this
endpoint (300ms interval, 10s budget) rather than trusting the first response.

**The `kimi-for-coding` gap (important — read before you build on this):** this machine's global
opencode config sets `"model": "kimi-for-coding/k3-256k"` as the *default* model, and the
provider is authenticated (`opencode auth list` shows it; `opencode auth.json` has a live key;
`opencode models` CLI lists `kimi-for-coding/k3`, `kimi-for-coding/k3-256k`, etc.). **None of
that provider's models ever appear in `GET /api/model` or `GET /api/provider`** — those v2
endpoints only surfaced the providers explicitly declared under the `provider` block of
`~/.config/opencode/opencode.jsonc` (`fleet`, `brainoutput-local`) plus a built-in `opencode`
(zen) entry. The **legacy** `GET /provider` endpoint (no `/api` prefix) tells a different story:
its `connected` array is `["kimi-for-coding","fleet","brainoutput-local"]`, and `kimi-for-coding`
is fully present with all its models in `all`. So: CLI ✅, legacy `/provider` ✅, v2
`/api/provider` and `/api/model` ❌. See §9 for what happens if you select it anyway.

---

## 5. `POST /api/session/{sessionID}/model` — select the model

### What returns 400 and why

The schema (`ModelRef`, resolved from `$ref` chains under
`#/components/schemas/ModelRef`) is:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "providerID": { "type": "string" },
    "variant": { "type": "string" }
  },
  "required": ["id", "providerID"],
  "additionalProperties": false
}
```

The request body wraps that under a top-level `model` key:
```json
{
  "type": "object",
  "properties": { "model": { "$ref": "#/components/schemas/ModelRef" } },
  "required": ["model"],
  "additionalProperties": false
}
```

The trap: it is natural to assume the pair is `providerID` + `modelID` (that's the vocabulary
`/model` and `/provider` use elsewhere in the API, e.g. `ModelV2Info.providerID` /
`ModelV2Info.id`... but here the *model's own id* field is called `id`, not `modelID`). Two wrong
guesses, both confirmed to fail:

```
# WRONG — missing the required top-level "model" wrapper entirely
POST /api/session/{id}/model
{"providerID":"kimi-for-coding","modelID":"k3-256k"}
→ 400 {"_tag":"InvalidRequestError","message":"Missing key\n  at [\"model\"]","kind":"Payload"}

# WRONG — wrapped correctly, but "modelID" is not a ModelRef property
#         (additionalProperties:false rejects it silently as "missing id")
POST /api/session/{id}/model
{"model":{"providerID":"kimi-for-coding","modelID":"k3-256k"}}
→ 400 {"_tag":"InvalidRequestError","message":"Missing key\n  at [\"model\"]","kind":"Payload"}
```

### The correct, verified-working payload

```
POST /api/session/{sessionID}/model
Content-Type: application/json

{"model":{"id":"k3-256k","providerID":"kimi-for-coding"}}
```
→ **`204 No Content`**

Generalized: `{"model":{"id":"<modelID>","providerID":"<providerID>"}}`. Optional third field
`variant` (string) is also part of `ModelRef` but was not required for any model we exercised.

Other response codes per `/doc`: `401 UnauthorizedError`, `404 SessionNotFoundError` (an
`anyOf` of the same schema twice — an apparent spec-authoring artifact, harmless).

**This endpoint does NOT validate the model against the provider registry.** It happily returns
204 for `kimi-for-coding/k3-256k` even though that provider is invisible to `/api/model` (§4) —
see §9 for the consequence.

---

## 6. `POST /api/session/{sessionID}/prompt` — send a message

**Request body:**
```json
{
  "id": "msg_...",                     // optional, pattern ^msg_
  "prompt": { "text": "...", "files": [...], "agents": [...] },  // "text" required, rest optional
  "delivery": "steer" | "queue",       // optional; server default is "steer" if omitted
  "resume": true                       // optional bool; per /doc: "schedule agent-loop execution unless resume is false"
}
```
Minimal working body: `{"prompt":{"text":"..."}}`.

**Response 200** — `{"data": SessionInputAdmitted}`:
```json
{
  "data": {
    "admittedSeq": 2,
    "id": "msg_fcb3e29f7001J6mkzcSzLO0nfh",
    "sessionID": "ses_...",
    "prompt": { "text": "..." },
    "delivery": "queue",
    "timeCreated": 1785821276665
  }
}
```
HTTP 200 here means the input was **durably admitted**, not that the agent loop has run — see §7
for how we actually detected completion. Other codes: `400`, `401`, `404`, `409 ConflictError`.

**On `delivery`:** both `"steer"` and `"queue"` were observed to eventually execute correctly
against an idle session in our testing; the probe uses `"queue"` as the semantically correct
choice for the first message into a fresh/idle session. Do not assume delivery affects whether
the run starts — see §9 for the one case where it never started regardless of delivery
(`kimi-for-coding`).

---

## 7. `GET /api/session/{sessionID}/event` — SSE event stream, and how we actually detect "done"

Query: optional `after` (string) to resume a stream past a given point.

Per `/doc`, each SSE frame's schema is `{id, event, data}` with `data` typed as
`SessionDurableEventStream` (a string whose `contentSchema` is `SessionDurableEvent`, a `oneOf`
of ~28 event shapes: `SessionNextModelSwitched`, `SessionNextPromptAdmitted`,
`SessionNextPrompted`, `SessionNextStepStarted`, `SessionNextReasoningStarted/Ended`,
`SessionNextToolInputStarted/Ended`, `SessionNextToolCalled`, `SessionNextToolSuccess`/`Failed`,
`SessionNextTextStarted/Ended`, `SessionNextStepEnded`, `SessionNextMoved`, etc).

**What actually goes over the wire** (verified with raw byte inspection, not just a text client):
only `data: <json>\n\n` frames — there is no separate `event:` or `id:` SSE field on the wire in
this build, despite the schema modeling them as siblings of `data`. The full envelope (`id`,
`type`, `durable`, `location`, `data`) is all inside that one JSON blob. Example frame:

```
data: {"id":"evt_fcb3e328c0027VllVOmgWAQucV","type":"session.next.step.started","durable":{"aggregateID":"ses_...","seq":4,"version":1},"data":{"timestamp":1785821278860,"sessionID":"ses_...","assistantMessageID":"msg_...","agent":"build","model":{"id":"coder","providerID":"brainoutput-local","variant":"default"}}}

```
(blank line terminates the frame). Lines starting with `:` are SSE comments used as heartbeats —
none were observed in our runs (they only fire on true idle gaps), but the parser skips them.

**Full ordered event sequence for one successful `write`-tool turn** (from a real run, `delivery:
"queue"`, model `brainoutput-local/coder`):

```
session.next.model.switched
session.next.prompt.admitted
session.next.prompted
session.next.step.started
session.next.reasoning.started
session.next.reasoning.ended
session.next.tool.input.started
session.next.tool.input.ended
session.next.tool.called
session.next.tool.success
session.next.step.ended        <-- data.finish == "tool-calls" (NOT terminal)
session.next.step.started
session.next.reasoning.started
session.next.reasoning.ended
session.next.text.started
session.next.text.ended
session.next.step.ended        <-- data.finish == "stop"  (TERMINAL)
```

A `session.next.step.ended` event fires after **every** step, but `data.finish` distinguishes an
intermediate step (`"tool-calls"`: more steps are coming) from the actual end of the turn
(`"stop"`). **The probe treats `session.next.step.ended` with `data.finish === "stop"` as the
sole completion signal** — see §8 for why `POST /wait` could not be used for this instead.

Each `step.ended` event also carries the step's real token usage inline, e.g.:
```json
{"finish":"stop","cost":0,"tokens":{"input":116,"output":94,"reasoning":0,"cache":{"read":2882,"write":0}}}
```

---

## 8. `POST /api/session/{sessionID}/wait` — reproducibly unusable in this build

No request body (`/doc` lists no `requestBody` for this operation — only the `sessionID` path
param). Documented behavior: *"Wait for a session agent loop to become idle."* Documented
responses: `204 No Content` (idle) / `400` / `401` / `404` / `503 ServiceUnavailableError`.

**What we actually observed, every single time, across many sessions and two full clean runs of
the probe script:**

```
POST /api/session/{id}/wait
→ 503 {"_tag":"ServiceUnavailableError","message":"Session wait is not available yet","service":"session.wait"}
```

This happened:
- immediately after prompting (arguably reasonable — the run hasn't started yet), **and**
- again several seconds *after* `session.next.step.ended{finish:"stop"}` had already fired on the
  event stream, the output file already existed on disk with the correct content, and
  `GET /api/session/{id}/message` already showed the completed assistant message with real
  `finish:"stop"` and real token counts.

We never once observed `204` from this endpoint in this environment, at any point in a session's
lifecycle. **Do not build a runtime that depends on `/wait` to detect completion.** The probe
script calls it twice per run purely to record its (unchanging) behavior, and relies exclusively
on the SSE event stream (§7) for the actual completion signal.

---

## 9. The `kimi-for-coding` puzzle, resolved

Restating the setup: `kimi-for-coding/k3-256k` is authenticated on this machine and is the
account's configured *default* model, yet is invisible to `GET /api/provider` / `GET /api/model`
(§4). We tested what happens if you select and prompt it anyway, through the *correct* `/model`
payload from §5:

1. `POST /api/session/{id}/model {"model":{"id":"k3-256k","providerID":"kimi-for-coding"}}` →
   **204 No Content**. Accepted. `GET /api/session/{id}` afterwards shows
   `"model":{"id":"k3-256k","providerID":"kimi-for-coding"}` as if everything were fine — no
   server-side existence validation against the provider registry happens at selection time.
2. `POST /api/session/{id}/prompt {"prompt":{"text":"..."}}` → **200**, durably admitted
   (`session.next.prompt.admitted` and `session.next.prompted` both fire on the event stream).
3. **And then nothing else, ever.** No `session.next.step.started`. No error event of any kind.
   `GET /api/session/active` stays `{"data":{}}` (i.e. opencode does not consider any session
   "active"/running). We left one such session running and rechecked after **5+ minutes**: still
   nothing, no file written, no further events. We reproduced the identical (correct) prompt
   against `brainoutput-local/coder` in a fresh session in the same server process at the same
   time and it completed normally in under a minute.

Conclusion: as of 1.18.7, the v2 execution path silently drops runs against providers that exist
only in the auth store / models.dev catalog and are not declared under the config's `provider`
block, even though the same provider is fully "connected" per the legacy `/provider` endpoint and
the CLI. There is no error surfaced anywhere in the v2 REST surface for this — it just never
starts. **Anything built on this API must stick to models that are confirmed present in `GET
/api/model` immediately before selecting them** — which is exactly what the probe script asserts
(§4, "verify the model we intend to select is actually present").

We did **not** track this down further into opencode's source (out of scope for this spike, and
opencode itself is not vendored into this repo) — this section documents observed behavior, not
root cause internal to opencode.

---

## 10. Token accounting — where the real numbers actually live

- `GET /api/session/{sessionID}` → `data.tokens` — **stays `{"input":0,"output":0,"reasoning":0,
  "cache":{"read":0,"write":0}}` for the entire lifetime of the session** in every run we
  observed, including well after a successful completion. Do not use this field.
- `GET /api/session/{sessionID}/message` → each entry with `"type":"assistant"` carries its own
  real `tokens` object (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) plus `cost`
  and `finish`. **This is the authoritative source.** The probe script sums this across every
  assistant message belonging to the turn.
- The SSE `session.next.step.ended` event (§7) carries the same per-step `tokens` object inline,
  in real time, before you'd even need to poll the message list.

Example real output from a run (2-step turn, `brainoutput-local/coder`):
```
input tokens        : 2973
output tokens       : 288
reasoning tokens    : 0
cache read tokens   : 3079
cache write tokens  : 0
```

---

## 11. Endpoint summary (everything used by the probe)

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/api/health` | liveness | `{"healthy":true}` |
| POST | `/api/session` | create session | pass `location.directory` explicitly (§1, §3) |
| GET | `/api/model` | list v2 model catalog | can be empty for ~1-3s on a fresh workspace (§4); `kimi-for-coding` never appears (§9) |
| POST | `/api/session/{id}/model` | select model | body is `{"model":{"id","providerID"}}`, **not** `modelID` (§5) |
| POST | `/api/session/{id}/prompt` | send message | body `{"prompt":{"text"},"delivery":"queue"}`; 200 = admitted, not = done |
| GET | `/api/session/{id}/event` | SSE event stream | subscribe **before** prompting; watch for `session.next.step.ended` + `data.finish==="stop"` (§7) |
| POST | `/api/session/{id}/wait` | wait for idle | reliably 503 in this build, never depend on it (§8) |
| GET | `/api/session/{id}` | session snapshot | `tokens` field is stale/zero, don't use for accounting (§10) |
| GET | `/api/session/{id}/message` | message history | authoritative source of real per-step token accounting (§10) |
| GET | `/api/skill` | list registered skills | can be empty for ~1s on a fresh workspace, same warmup gotcha as §4 (§12) |
| GET | `/api/agent` | list registered agents | same warmup gotcha; only lists custom agents, not opencode's built-ins (§12) |
| POST | `/api/session/{id}/agent` | switch session agent | body `{"agent":"<id>"}`; **not validated** against the registry — mirrors the §9 trap (§12) |
| GET | `/api/session/{id}/context` | active (uncompacted) messages | **not** a usage percentage — compute usage from the tokens on the messages yourself (§12) |
| POST | `/api/session/{id}/compact` | compact session | reproducibly 503 in this build, same as `/wait` (§8) — see §12 |

---

## 12. Skill/agent registry + context/compaction — live-verified addendum (2026-08-04)

Added for the skill-routing + context-compaction work (opencode-server.mjs's
`resolveRoutingDirectives`/`switchAgent`/`checkContextAndCompact`). Verified against the SAME
running 1.18.7 build as the rest of this document, via `GET /doc`'s OpenAPI schemas plus live
requests (not the probe script — a throwaway ad hoc script, not committed).

**`GET /api/skill`** → `{"location": LocationInfo, "data": SkillV2Info[]}`, each entry
`{name, description, slash?, location, content}` (`name`/`location`/`content` required). Empty
`data` immediately after boot even once `/api/health` is green — populated within ~1s in our
probes. Poll, exactly like the `GET /api/model` gotcha in §4.

**`GET /api/agent`** → `{"location": LocationInfo, "data": AgentV2Info[]}`, each entry
`{id, model?, request, system?, description?, mode, hidden, color?, steps?, permissions}`
(`id`/`request`/`mode`/`hidden`/`permissions` required). Same warmup gotcha. **Important**: in
every environment we tested, this v2 endpoint returned only agents from *custom* project/global
agent config — opencode's own built-in agents (`build`, `plan`, `general`, `explore`, `summary`,
`compaction`, …) are invisible here even though they run every session. The **legacy** `GET
/agent` (no `/api` prefix) DOES list them (with a different shape:
`{name, description, mode, native, hidden, permission, model?, ...}`, keyed by `name` not `id`).
Anything routing a task's `agentSlot` onto a BUILT-IN agent by name will need to fall back to the
legacy endpoint or accept that only custom agents are reachable through the v2 registry gate — out
of scope for this change; flagged here so the next person doesn't re-discover it. Our fail-closed
gate only trusts what `GET /api/agent` (v2) actually reports.

**`POST /api/session/{id}/agent`** → body `{"agent":"<id>"}` (verified: NOT
`{"agentId":...}`/`{"agentSlot":...}` — the single field is literally `agent`), 204 on success.
**Confirmed live: this endpoint does NOT validate `agent` against the registry** — posting a
nonexistent agent id (`totally-bogus-agent-xyz`) still returned 204, and the session's context
subsequently showed a `type:"agent-switched"` message recording it as if it were real. This is the
exact same silent-acceptance trap §5/§9 already documented for `POST /model` — the fix is the same:
never call this endpoint with an id that hasn't been separately confirmed present in `GET
/api/agent` first.

**`GET /api/session/{id}/context`** → `{"data": SessionMessage[]}` — the active (since-last-
compaction) message list, the **same message shape** `GET /.../message` uses (`type`, and for
`type:"assistant"` a real `tokens` object). Despite the name, this is **not** a usage percentage,
counter, or "tokens used / limit" field of any kind — a naive implementation expecting a number
here will find only an array. Usage has to be computed client-side from the tokens on the messages
(we use the most recent assistant message's `tokens.input + tokens.cache.read +
tokens.cache.write`, compared against the model's own `limit.context` from `GET /api/model` — see
opencode-server.mjs's `computeContextUsage`).

**`POST /api/session/{id}/compact`** → **reproducibly 503** `{"_tag":"ServiceUnavailableError",
"message":"Session compact is not available yet","service":"session.compact"}` in every attempt we
made in this build/environment: on a brand-new empty session, mid-run, and immediately after a
real multi-step run reached `finish:"stop"` (several seconds of retrying, still 503 every time).
This is the exact same "documented as real but reproducibly unusable" pattern §8 already found for
`POST /wait` in this same build. **We do not know whether this is environment-specific** (e.g. it
may require a context size the local models we tested never actually reached) or a build-wide gap
— unlike §8's finding this was not exercised against a context that had genuinely grown large
enough to need compaction, since driving a real model past ~800K+ tokens was out of scope for this
verification pass. What we DO know, and what the runtime is built to handle either way: never
depend on this endpoint succeeding, and never treat a non-204 as reason to suppress the defect
signal — the compaction *attempt* (crossing the usage threshold at all) is what gets recorded,
independent of whether the server accepted it.

### The `opencode:` skill namespace — two distinct vocabularies

A task's `skills` directive can contain names from **two different skill vocabularies**, and they
are gated by two different routers. Conflating them once refused every legal task — this is the
convention that keeps the two apart.

1. **CE skills** (plain, unprefixed names) — Community Edition's own capability-slot vocabulary,
   owned by `ce-core.mjs`'s `KNOWN_SKILLS` router (`node-esm`, `browser-js`, `connectors`, `docs`,
   `ops`, `research`, `i18n`, `review`). These are validated fail-closed by `KNOWN_SKILLS` at
   task-launch time — an unknown CE skill is refused with a 400 before any runtime is touched.
   **They are NOT resolved against the OpenCode registry.** `resolveRoutingDirectives` passes them
   through untouched; e.g. `node-esm` and `docs` are never looked up in `GET /api/skill`, and would
   never be found there — the OpenCode registry holds tool-augmentations with entirely different
   names.
2. **OpenCode skills** (explicitly namespaced `opencode:<name>`) — entries in the live OpenCode
   skill registry (`GET /api/skill`, §12 above), e.g. `opencode:customize-opencode` resolves
   against the registry entry `customize-opencode`. Only names carrying the `opencode:` prefix are
   resolved against that registry by `resolveRoutingDirectives` (the prefix is stripped before
   lookup), and the gate is fail-closed exactly like `KNOWN_SKILLS`: an unknown name such as
   `opencode:not-a-real-skill` blocks the task with a named, localized reason instead of a silent
   drop.

Rule of thumb: if a skill name has no `opencode:` prefix, it belongs to CE's `KNOWN_SKILLS` router
and the OpenCode registry is never consulted for it; the prefix is the explicit opt-in to the
OpenCode registry gate. Covered by `opencode-server-routing.test.mjs` (pass-through of plain CE
skills; fail-closed regression on `opencode:`-namespaced unknowns).

---

## 13. Worktree branch integrity (isolated-workspace tasks)

When a task runs in `isolated_workspace` mode, Paperclip creates a git worktree pinned to the
task's own branch and verifies that pin on every subsequent run. If anything switches the worktree
to another branch — the classic case being a well-meaning merge or a `git checkout main` inside the
worktree — the **next** run fails closed with:

```
Execution workspace git worktree expected branch <task-branch> but found main ... Safe repair was not completed
```

This is a fail-closed integrity check, not a bug: the runtime refuses to work on (or silently
"repair") a worktree whose checked-out branch no longer matches the branch the task was created
on, because any commit made there would land on the wrong branch.

**The fix is prevention, and it is absolute:** leave the worktree on its own task branch. Never
merge, never `git checkout`/`git switch` to another branch, and never push from inside an
isolated task worktree. Commit freely on the task branch — that branch is the deliverable and the
handoff; a human opens the PR and decides what merges. If the integrity error has already fired,
the repair is to check the task branch back out in that worktree (or provision a fresh one) — not
to force the runtime past the check.

---

## Verification

`tools/oc-api-probe.mjs` was run twice consecutively from a clean state (no leftover `opencode
serve` processes, no leftover scratch dirs before either run — confirmed both times). Both runs:

- created a fresh scratch workspace under `/tmp`, started a real server on a random port,
- created a session pinned to that workspace via `location.directory`,
- confirmed `brainoutput-local/coder` was present in `GET /api/model` (polling past the cold-start gap),
- subscribed to the session's SSE event stream before sending any prompt,
- selected that model with the corrected `{"model":{"id","providerID"}}` payload (204),
- sent a prompt requiring a `write` tool call,
- detected real completion via `session.next.step.ended{finish:"stop"}` on the event stream (not `/wait`),
- **asserted** (not merely exit-code-checked) that the expected output file existed on disk with
  exactly the expected marker content,
- printed real summed token accounting from `GET /api/session/{id}/message`,
- printed the full ordered list of observed event types,
- shut the server down cleanly and removed the scratch directory,
- exited 0 with `ALL ASSERTIONS PASSED.` printed.

Run 1: session `ses_034b66ed3ffeMqxBAw6ybe01sJ`, 3 assistant steps, 41.4s wall clock,
tokens `{input:3050, output:196, cache.read:6184}`.

Run 2: session `ses_034b5bda4ffeIHVv5gVTJySQ9d`, 2 assistant steps, 45.0s wall clock,
tokens `{input:2973, output:288, cache.read:3079}`.

(Step count and exact token numbers vary run to run — the model is a real LLM and its tool-call
plan is not deterministic — but both runs satisfied every hard assertion above.)
