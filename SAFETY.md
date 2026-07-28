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

## The local dashboard is guarded (CSRF + DNS rebinding)

The dashboard listens on `127.0.0.1` only — but **loopback alone is not protection**. Any website you
visit can make *your browser* POST to a local port, and a hostname rebound to `127.0.0.1` can read the
response. Since a Work Twin can read (and, once you grant and approve it, send) mail, the local API is
guarded:

- **Host must be loopback** — defeats DNS rebinding. Override deliberately with `BO_CE_ALLOWED_HOSTS`.
- **Any foreign `Origin` or cross-site `Sec-Fetch-Site` is refused** — blocks website-driven requests.
- **State-changing requests must be `Content-Type: application/json`** — a cross-origin form or simple
  POST cannot set that without a preflight, which is then refused.
- **Browser requests must carry the per-process CSRF token** embedded in the page; a cross-origin
  attacker can never read it.
- The API **never** sends CORS headers, and the page sets `nosniff`, `no-referrer` and a CSP.

A local CLI (curl, scripts) sends no browser headers and keeps working. Pinned by `security.test.mjs`.

## Hosting it for someone else

Locally the dashboard binds to `127.0.0.1` and needs no login — that is the whole UX. The moment it
listens anywhere else it holds *someone else's* mail, IMAP password and provider key behind a URL, so:

- it **refuses to start** on a non-loopback interface without `BO_CE_ACCESS_TOKEN`;
- with a token, every request needs it — a sign-in page issues an `HttpOnly; SameSite=Strict` cookie,
  compared in constant time (`Secure` too when you set `BO_CE_SECURE_COOKIE=1` behind TLS);
- `BO_CE_ALLOWED_HOSTS` must name the public hostname, and the CSRF/origin rules still apply;
- one instance per person — the store is single-tenant by design, so isolation comes from running a
  separate instance per user, not from a shared process.

```bash
BO_CE_ACCESS_TOKEN=$(openssl rand -hex 24) BO_CE_WEB_HOST=0.0.0.0 \
BO_CE_ALLOWED_HOSTS=alice.example.com BO_CE_SECURE_COOKIE=1 bo-community serve
```

## Credentials and the local store

The store holds work-source credentials and indexed mail metadata, so:

- the store directory is **0700** and its files **0600** (existing installs are tightened on next run);
- a work-source password is **encrypted at rest** (AES-256-GCM) under a key file kept beside the store
  at 0600 — it is never written as plaintext, and a legacy plaintext value is re-sealed on the next
  write;
- better still, set `passwordEnv` on the connection and keep the credential in your environment — then
  nothing is stored at all;
- credentials are **stripped from every API response** (`publicTwin`).
