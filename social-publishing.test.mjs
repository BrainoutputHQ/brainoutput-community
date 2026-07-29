#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// The point of these tests is one claim: a real Instagram token goes in, and it never comes out
// anywhere an LLM agent could read it. Everything else is secondary.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instagramPublisher, instagramConnectionOptions, agentVisibleConnection,
  secretRef, isSecretRef, redact, looksSecret,
  IG_CONNECTION_MODES, IG_DAILY_POST_LIMIT,
} from "./social-publishing.mjs";

// Realistically shaped, entirely fake.
const TOKEN = "EAAGm0PX4ZCpsBA" + "x".repeat(40);
const APP_SECRET = "a3f5c9e1b7d24680a3f5c9e1b7d24680";

const store = new Map([["instagram:acme", TOKEN], ["meta-app-secret", APP_SECRET]]);
const resolveSecret = async (name) => store.get(name) || null;

/** A publisher whose HTTP layer records every request, so we can inspect what was sent. */
function spyPublisher({ quotaUsed = 0, fail = null } = {}) {
  const calls = [];
  const requestImpl = async ({ path, method, form }) => {
    calls.push({ path, method, form });
    if (fail) throw new Error(fail);
    if (path.includes("content_publishing_limit")) return { data: [{ quota_usage: quotaUsed, config: { quota_total: IG_DAILY_POST_LIMIT } }] };
    if (path.endsWith("/media")) return { id: "CONTAINER_1" };
    if (path.endsWith("/media_publish")) return { id: "MEDIA_1" };
    return { status_code: "FINISHED" };
  };
  const pub = instagramPublisher({ igUserId: "178414", tokenRef: secretRef("instagram:acme"), resolveSecret, requestImpl });
  return { pub, calls };
}

const APPROVED = { approved: true };
const OWNS = { ownsAccount: true };

test("an agent can only ever hold a REF — a literal token is refused at construction", () => {
  assert.equal(isSecretRef(secretRef("instagram:acme")), true);
  assert.equal(isSecretRef({ name: "x" }), false);
  assert.throws(() => instagramPublisher({ igUserId: "1", tokenRef: TOKEN, resolveSecret }), /secretRef, never a literal token/);
  assert.throws(() => instagramPublisher({ igUserId: "1", tokenRef: { name: TOKEN }, resolveSecret }), /secretRef/);
  // the ref is frozen, so nobody can smuggle the value onto it later
  const r = secretRef("instagram:acme");
  assert.throws(() => { "use strict"; r.value = TOKEN; }, TypeError);
});

test("THE INVARIANT: the token never appears in anything an agent can see", async () => {
  const { pub } = spyPublisher();
  const surfaces = [
    JSON.stringify(agentVisibleConnection(pub)),
    JSON.stringify(instagramConnectionOptions()),
    JSON.stringify(await pub.publishImage({ imageUrl: "https://cdn.example.com/a.jpg", caption: "Launch day", authorization: APPROVED, attestation: OWNS })),
    JSON.stringify(await pub.quota()),
    JSON.stringify(Object.keys(pub)),
  ];
  for (const s of surfaces) {
    assert.ok(!s.includes(TOKEN), "a token reached an agent-visible surface");
    assert.ok(!s.includes(APP_SECRET), "an app secret reached an agent-visible surface");
  }
});

test("the vendor's own error text is redacted — Meta echoes request params back", async () => {
  const { pub } = spyPublisher({ fail: `Instagram publish failed (400) 190 Invalid OAuth access token: access_token=${TOKEN}` });
  await assert.rejects(
    () => pub.publishImage({ imageUrl: "https://cdn.example.com/a.jpg", authorization: APPROVED, attestation: OWNS }),
    (e) => {
      assert.ok(!e.message.includes(TOKEN), "the upstream error leaked the token");
      assert.match(e.message, /redacted/);
      return true;
    });
});

test("redact scrubs tokens, secrets and credential-named keys anywhere in a structure", () => {
  const out = redact({ ok: true, note: `bearer ${TOKEN}`, nested: { access_token: TOKEN, appSecret: APP_SECRET }, list: [`x ${APP_SECRET}`] });
  const s = JSON.stringify(out);
  assert.ok(!s.includes(TOKEN) && !s.includes(APP_SECRET));
  assert.equal(out.nested.access_token, "[redacted]");   // by key name
  assert.match(out.list[0], /\[redacted\]/);             // by value shape
  assert.equal(out.ok, true);                            // harmless data survives
  assert.equal(looksSecret(TOKEN), true);
  assert.equal(looksSecret("just a caption"), false);
});

test("a draft carrying a credential is REFUSED, so an agent cannot launder one through publish", async () => {
  const { pub, calls } = spyPublisher();
  await assert.rejects(
    () => pub.publishImage({ imageUrl: "https://cdn.example.com/a.jpg", caption: `token ${TOKEN}`, authorization: APPROVED, attestation: OWNS }),
    /looks like a credential/);
  assert.equal(calls.length, 0, "nothing may reach Meta once a draft is tainted");
});

test("publishing refuses without human approval AND without an ownership attestation", async () => {
  const { pub, calls } = spyPublisher();
  const img = "https://cdn.example.com/a.jpg";
  await assert.rejects(() => pub.publishImage({ imageUrl: img, attestation: OWNS }), /approved authorization/);
  await assert.rejects(() => pub.publishImage({ imageUrl: img, authorization: { approved: false }, attestation: OWNS }), /approved authorization/);
  await assert.rejects(() => pub.publishImage({ imageUrl: img, authorization: APPROVED }), /own or manage/);
  assert.equal(calls.length, 0, "no call may be made without both gates");
});

test("the documented two-step flow is what actually goes on the wire", async () => {
  const { pub, calls } = spyPublisher();
  const r = await pub.publishImage({ imageUrl: "https://cdn.example.com/a.jpg", caption: "Launch day", authorization: APPROVED, attestation: OWNS });
  const posts = calls.filter((c) => c.method === "POST");
  assert.match(posts[0].path, /\/178414\/media$/);            // 1. container
  assert.equal(posts[0].form.image_url, "https://cdn.example.com/a.jpg");
  assert.equal(posts[0].form.caption, "Launch day");
  assert.match(posts[1].path, /\/178414\/media_publish$/);    // 2. publish
  assert.equal(posts[1].form.creation_id, "CONTAINER_1");     // documented param name
  assert.equal(r.mediaId, "MEDIA_1");
});

test("a non-https image url is refused — Instagram fetches it itself", async () => {
  const { pub } = spyPublisher();
  for (const bad of ["http://x/a.jpg", "/local/a.jpg", "", null])
    await assert.rejects(() => pub.publishImage({ imageUrl: bad, authorization: APPROVED, attestation: OWNS }), /public https URL/);
});

test("the rolling 24h limit is checked BEFORE posting, not discovered as a 429", async () => {
  const { pub, calls } = spyPublisher({ quotaUsed: IG_DAILY_POST_LIMIT });
  await assert.rejects(
    () => pub.publishImage({ imageUrl: "https://cdn.example.com/a.jpg", authorization: APPROVED, attestation: OWNS }),
    new RegExp(`${IG_DAILY_POST_LIMIT}-post rolling 24h limit`));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  const ok = spyPublisher({ quotaUsed: 99 });
  const r = await ok.pub.publishImage({ imageUrl: "https://cdn.example.com/a.jpg", authorization: APPROVED, attestation: OWNS });
  assert.equal(r.quotaRemaining, 0);
});

test("'Connect with BrainOutput' REFUSES rather than silently using something else", () => {
  assert.equal(IG_CONNECTION_MODES["brainoutput-app"].available, false);
  assert.throws(
    () => instagramPublisher({ mode: "brainoutput-app", igUserId: "1", tokenRef: secretRef("x"), resolveSecret }),
    /Meta App Review/);
  // …and it is still SHOWN, so the choice presented to a customer is honest
  const opts = instagramConnectionOptions();
  const bo = opts.find((o) => o.key === "brainoutput-app");
  assert.equal(bo.available, false);
  assert.match(bo.blockedBy, /App Review/);
  const own = opts.find((o) => o.key === "own-meta-app");
  assert.equal(own.available, true);
  assert.ok(own.scopes.includes("instagram_business_content_publish"));
});

test("a missing credential says what to do instead of failing cryptically", async () => {
  const pub = instagramPublisher({ igUserId: "1", tokenRef: secretRef("instagram:nobody"), resolveSecret, requestImpl: async () => ({}) });
  await assert.rejects(() => pub.quota(), /no credential named 'instagram:nobody'.*connect Instagram first/s);
});

test("the agent's view says plainly that it drafts and does NOT publish", () => {
  const { pub } = spyPublisher();
  const v = agentVisibleConnection(pub);
  assert.equal(v.canDraft, true);
  assert.equal(v.canPublish, false);
  assert.equal(v.mode, "own-meta-app");
  assert.equal(Object.isFrozen(v), true);
  assert.ok(!("tokenRef" in v) && !("resolveSecret" in v));
});
