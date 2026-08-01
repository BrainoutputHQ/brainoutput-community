// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Google OAuth (2026-08-01). The dance for "Connect Google":
// consent redirect → code exchange → sealed token storage → automatic refresh.
//
// Two credential stories, SAME machinery:
//   A. the customer's own Google Cloud OAuth client (works today; External/testing app);
//   B. a verified BrainOutput OAuth app (hosted product track — Google verification + CASA for
//      restricted scopes). When it exists, it is just different client id/secret here.
// Client secrets and tokens are SEALED at rest (store.sealSecret) and never in the exportable
// definition. State nonces are single-use and short-lived (OAuth CSRF protection). Zero-dep.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

/** Scopes we request — READ-ONLY by design. Widening here is a product decision, not a default. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export class GoogleOAuth {
  constructor({ clientId = null, clientSecretRef = null, redirectUri = null, fetchImpl = fetch, clock = () => Date.now() } = {}) {
    this.clientId = clientId;
    this.clientSecretRef = clientSecretRef;   // the SEALED secret record (opened only at exchange/refresh)
    this.redirectUri = redirectUri;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.states = new Map();                  // nonce hash → { expiresAt, usedAt }
  }

  get configured() { return !!(this.clientId && this.clientSecretRef && this.redirectUri); }

  /** The consent URL + a single-use state nonce (10 min). */
  startAuth({ now = this.clock() } = {}) {
    if (!this.configured) throw new Error("Google OAuth is not configured — set the client id and secret first");
    const state = randomBytes(12).toString("hex");
    this.states.set(sha(state), { expiresAt: now + 10 * 60 * 1000, usedAt: null });
    const params = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri, response_type: "code",
      scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", state,
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state };
  }

  assertState(state, { now = this.clock() } = {}) {
    const rec = this.states.get(sha(String(state || "")));
    if (!rec) throw new Error("unknown OAuth state — possible CSRF; start again");
    if (rec.usedAt) throw new Error("OAuth state already used");
    if (now >= rec.expiresAt) throw new Error("OAuth state expired — start again");
    rec.usedAt = now;
    return true;
  }

  async #tokenRequest(params, openSecret) {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: openSecret(this.clientSecretRef), ...params });
    const r = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`Google token endpoint: ${j.error_description || j.error || "HTTP " + r.status}`);
    return j;
  }

  /** Callback: verify state, exchange the code. Returns the token bundle to SEAL. */
  async exchangeCode({ code, state }, openSecret, { now = this.clock() } = {}) {
    this.assertState(state, { now });
    if (!code) throw new Error("Google returned no code");
    const j = await this.#tokenRequest({
      grant_type: "authorization_code", code, redirect_uri: this.redirectUri,
    }, openSecret);
    if (!j.refresh_token) throw new Error("Google returned no refresh token (consent without offline access) — retry with prompt=consent");
    return { accessToken: j.access_token, refreshToken: j.refresh_token,
      accessTokenExpiresAt: now + (Number(j.expires_in) || 3600) * 1000, scope: j.scope || GOOGLE_SCOPES.join(" ") };
  }

  /** A fresh access token, refreshing when expired. `save` persists the rotated bundle (sealed). */
  async accessToken(bundle, openSecret, { now = this.clock() } = {}) {
    if (bundle.accessToken && now < (bundle.accessTokenExpiresAt || 0) - 60000) return { accessToken: bundle.accessToken, bundle, rotated: false };
    const j = await this.#tokenRequest({ grant_type: "refresh_token", refresh_token: bundle.refreshToken }, openSecret);
    const next = { ...bundle, accessToken: j.access_token,
      accessTokenExpiresAt: now + (Number(j.expires_in) || 3600) * 1000,
      ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}) };
    return { accessToken: next.accessToken, bundle: next, rotated: true };
  }
}
