// Google OAuth: the state nonce discipline, the code exchange, and the refresh/rotation flow —
// against a stubbed token endpoint. No real Google call in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleOAuth } from "./oauth-google.mjs";

const NOW = 1_800_000_000_000;
const SEALED = { iv: "x", ct: "y", tag: "z" };
const openSecret = () => "client-secret-value";

const stubTokenEndpoint = (behavior) => async (url, opts) => {
  const params = new URLSearchParams(opts.body);
  calls.push(params);
  return behavior(params);
};
let calls = [];

const okToken = (params) => ({
  ok: true,
  json: async () => params.get("grant_type") === "authorization_code"
    ? { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "openid drive.readonly" }
    : { access_token: "at-2", expires_in: 3600 },
});

const oauth = (fetchImpl) => new GoogleOAuth({
  clientId: "x.apps.googleusercontent.com", clientSecretRef: SEALED,
  redirectUri: "https://ws.example.com/api/oauth/google/callback", fetchImpl, clock: () => NOW,
});

test("startAuth builds the consent URL with offline access and a single-use state", () => {
  const g = oauth(okToken && (() => { throw new Error("no call expected"); }));
  const { url, state } = g.startAuth({ now: NOW });
  assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
  assert.match(url, /scope=.*drive\.readonly/);
  assert.ok(!url.includes("gmail"), "no gmail scope — read-only drive + identity only");
  assert.throws(() => g.assertState("forged", { now: NOW }), /unknown OAuth state/);
  g.assertState(state, { now: NOW });
  assert.throws(() => g.assertState(state, { now: NOW }), /already used/);
  const g2 = oauth(() => { throw 0; });
  const s2 = g2.startAuth({ now: NOW }).state;
  assert.throws(() => g2.assertState(s2, { now: NOW + 11 * 60 * 1000 }), /expired/);
});

test("unconfigured OAuth refuses to start (never a broken redirect)", () => {
  const g = new GoogleOAuth({});
  assert.throws(() => g.startAuth(), /not configured/);
});

test("exchangeCode verifies state, posts the code, and requires a refresh token", async () => {
  calls = [];
  const g = oauth(stubTokenEndpoint(okToken));
  const { state } = g.startAuth({ now: NOW });
  const bundle = await g.exchangeCode({ code: "code-1", state }, openSecret, { now: NOW });
  assert.equal(bundle.refreshToken, "rt-1");
  assert.equal(bundle.accessToken, "at-1");
  assert.equal(calls[0].get("client_secret"), "client-secret-value", "the sealed secret is opened only at exchange");
  assert.equal(calls[0].get("grant_type"), "authorization_code");
  const noRefresh = oauth(stubTokenEndpoint(() => ({ ok: true, json: async () => ({ access_token: "x", expires_in: 1 }) })));
  const s = noRefresh.startAuth({ now: NOW }).state;
  await assert.rejects(() => noRefresh.exchangeCode({ code: "c", state: s }, openSecret, { now: NOW }), /no refresh token/);
});

test("accessToken reuses a fresh token and rotates+returns the bundle when expired", async () => {
  calls = [];
  const g = oauth(stubTokenEndpoint(okToken));
  const fresh = { accessToken: "at-fresh", refreshToken: "rt-1", accessTokenExpiresAt: NOW + 600000 };
  const reuse = await g.accessToken(fresh, openSecret, { now: NOW });
  assert.equal(reuse.rotated, false);
  assert.equal(calls.length, 0, "no refresh call while the token is fresh");
  const expired = { ...fresh, accessTokenExpiresAt: NOW - 1000 };
  const rotated = await g.accessToken(expired, openSecret, { now: NOW });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.accessToken, "at-2");
  assert.equal(rotated.bundle.refreshToken, "rt-1", "Google keeps the refresh token unless it rotates");
  assert.equal(calls[0].get("grant_type"), "refresh_token");
});

test("token endpoint errors surface, never a silent failure", async () => {
  const g = oauth(stubTokenEndpoint(() => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "code expired" }) })));
  const s = g.startAuth({ now: NOW }).state;
  await assert.rejects(() => g.exchangeCode({ code: "old", state: s }, openSecret, { now: NOW }), /code expired/);
});
