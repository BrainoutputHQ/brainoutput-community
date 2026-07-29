#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
//
// The point of these tests is one claim: a real Instagram token goes in, and it never comes out
// anywhere an LLM agent could read it. Everything else is secondary.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instagramPublisher, linkedinPublisher, facebookPagePublisher, instagramConnectionOptions, agentVisibleConnection,
  secretRef, isSecretRef, redact, looksSecret,
  IG_CONNECTION_MODES, IG_DAILY_POST_LIMIT,
} from "./social-publishing.mjs";

// Realistically shaped, entirely fake.
const TOKEN = "EAAGm0PX4ZCpsBA" + "x".repeat(40);
const APP_SECRET = "a3f5c9e1b7d24680a3f5c9e1b7d24680";

const store = new Map([["instagram:acme", TOKEN], ["meta-app-secret", APP_SECRET], ["linkedin:acme", TOKEN], ["facebook:page:acme", TOKEN]]);
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
  // Two distinct failures, and they deserve distinct messages: a url we cannot use…
  for (const bad of ["http://x/a.jpg", "/local/a.jpg"])
    await assert.rejects(() => pub.publishImage({ imageUrl: bad, authorization: APPROVED, attestation: OWNS }), /public https/);
  // …versus no image at all, which on Instagram is not a post.
  for (const missing of ["", null, undefined])
    await assert.rejects(() => pub.publishImage({ imageUrl: missing, authorization: APPROVED, attestation: OWNS }), /Instagram posts need an image/);
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

// ── shared core ────────────────────────────────────────────────────────────────────────────────
test("assertPublishable applies the same refusals to every platform", async () => {
  const { assertPublishable } = await import("./social-publishing.mjs");
  assert.equal(assertPublishable({ platform: "X", authorization: APPROVED, attestation: OWNS, texts: ["hello"] }), true);
  assert.throws(() => assertPublishable({ platform: "X", attestation: OWNS }), /approved authorization/);
  assert.throws(() => assertPublishable({ platform: "X", authorization: APPROVED }), /own or manage/);
  assert.throws(() => assertPublishable({ platform: "X", authorization: APPROVED, attestation: OWNS, texts: [`k ${TOKEN}`] }), /looks like a credential/);
});

test("resolveImage: supplied url wins, prompt needs a capability, unconfigured is loud and never paid", async () => {
  const { resolveImage } = await import("./social-publishing.mjs");
  assert.deepEqual(await resolveImage({ imageUrl: "https://cdn.example.com/a.jpg" }), { url: "https://cdn.example.com/a.jpg", source: "supplied" });
  assert.deepEqual(await resolveImage({}), { url: null, source: "none" });
  await assert.rejects(() => resolveImage({ imageUrl: "http://insecure/a.jpg" }), /public https/);

  const gen = await resolveImage({ imagePrompt: "a launch banner", imageCapability: async () => "https://cdn.example.com/gen.jpg" });
  assert.deepEqual(gen, { url: "https://cdn.example.com/gen.jpg", source: "generated" });

  // an unconfigured slot reports options — and none of them is a paid BrainOutput fallback
  await assert.rejects(() => resolveImage({ imagePrompt: "x" }), (e) => {
    assert.equal(e.needsConfiguration, "image-gen");
    assert.ok(e.options.length >= 3);
    for (const o of e.options) assert.doesNotMatch(o, /paid|brainoutput/i);
    return true;
  });
  await assert.rejects(() => resolveImage({ imagePrompt: "x", imageCapability: async () => "not-a-url" }), /public https URL/);
});

// ── LinkedIn ───────────────────────────────────────────────────────────────────────────────────
function linkedinSpy(opts = {}) {
  const calls = [];
  const requestImpl = async ({ path, method, body }) => {
    calls.push({ path, method, body });
    if (opts.fail) throw new Error(opts.fail);
    return { status: 201, id: "urn:li:share:6844785523593134080" };
  };
  const pub = linkedinPublisher({ as: opts.as || "member", authorId: "5abc", tokenRef: secretRef("linkedin:acme"), resolveSecret, requestImpl });
  return { pub, calls };
}

test("LinkedIn sends exactly the documented body", async () => {
  const { pub, calls } = linkedinSpy();
  const r = await pub.publishPost({ commentary: "Launch day", authorization: APPROVED, attestation: OWNS });
  assert.equal(calls[0].path, "/rest/posts");
  const b = calls[0].body;
  assert.equal(b.author, "urn:li:person:5abc");
  assert.equal(b.commentary, "Launch day");
  assert.equal(b.visibility, "PUBLIC");
  assert.equal(b.lifecycleState, "PUBLISHED");
  assert.deepEqual(b.distribution, { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] });
  assert.equal(b.isReshareDisabledByAuthor, false);
  // the id comes from the x-restli-id RESPONSE HEADER, not the body — reading the body returns null
  assert.equal(r.postId, "urn:li:share:6844785523593134080");
});

test("LinkedIn author urn and scopes follow member vs organization", async () => {
  const { linkedinAuthorUrn, LINKEDIN_SCOPES } = await import("./social-publishing.mjs");
  assert.equal(linkedinAuthorUrn({ as: "member", id: "5abc" }), "urn:li:person:5abc");
  assert.equal(linkedinAuthorUrn({ as: "organization", id: "2414183" }), "urn:li:organization:2414183");
  assert.throws(() => linkedinAuthorUrn({ as: "robot", id: "1" }), /unknown LinkedIn author type/);
  assert.throws(() => linkedinAuthorUrn({ as: "member" }), /needs an id/);
  assert.deepEqual(linkedinSpy({ as: "organization" }).pub.scopes, LINKEDIN_SCOPES.organization);
  assert.deepEqual(linkedinSpy().pub.scopes, LINKEDIN_SCOPES.member);
});

test("LinkedIn refuses a raw image url rather than silently dropping the picture", async () => {
  const { pub, calls } = linkedinSpy();
  await assert.rejects(
    () => pub.publishPost({ commentary: "hi", imageUrl: "https://cdn.example.com/a.jpg", authorization: APPROVED, attestation: OWNS }),
    /Images API upload is not implemented/);
  await assert.rejects(
    () => pub.publishPost({ commentary: "hi", imageUrn: "urn:li:video:123", authorization: APPROVED, attestation: OWNS }),
    /urn:li:image/);
  assert.equal(calls.length, 0);
  const ok = linkedinSpy();
  await ok.pub.publishPost({ commentary: "hi", imageUrn: "urn:li:image:C49klciosC89", authorization: APPROVED, attestation: OWNS });
  assert.deepEqual(ok.calls[0].body.content, { media: { id: "urn:li:image:C49klciosC89" } });
});

test("LinkedIn inherits the credential boundary and the version guard", async () => {
  assert.throws(() => linkedinPublisher({ authorId: "1", tokenRef: TOKEN, resolveSecret }), /secretRef, never a literal token/);
  assert.throws(() => linkedinPublisher({ authorId: "1", tokenRef: secretRef("x"), resolveSecret, version: "2026-07" }), /YYYYMM/);
  const { pub } = linkedinSpy();
  await assert.rejects(() => pub.publishPost({ commentary: "hi", attestation: OWNS }), /approved authorization/);
  const leaky = linkedinSpy({ fail: `boom access_token=${TOKEN}` });
  await assert.rejects(
    () => leaky.pub.publishPost({ commentary: "hi", authorization: APPROVED, attestation: OWNS }),
    (e) => { assert.ok(!e.message.includes(TOKEN)); return true; });
});

test("Instagram uses the image-gen slot when given a prompt, and says which path was taken", async () => {
  const calls = [];
  const mk = (imageCapability) => instagramPublisher({
    igUserId: "178414", tokenRef: secretRef("instagram:acme"), resolveSecret, imageCapability,
    requestImpl: async ({ path, form }) => {
      calls.push({ path, form });
      if (path.includes("content_publishing_limit")) return { data: [{ quota_usage: 0, config: { quota_total: 100 } }] };
      if (path.endsWith("/media")) return { id: "C1" };
      return { id: "M1" };
    },
  });
  const gen = await mk(async ({ prompt }) => `https://cdn.example.com/${encodeURIComponent(prompt)}.jpg`)
    .publishImage({ imagePrompt: "launch banner", caption: "Launch day", authorization: APPROVED, attestation: OWNS });
  assert.equal(gen.imageSource, "generated");
  assert.match(calls.find((c) => c.path.endsWith("/media")).form.image_url, /launch%20banner/);

  // no capability configured -> loud, with free/local options, never a paid fallback
  await assert.rejects(
    () => mk(null).publishImage({ imagePrompt: "x", authorization: APPROVED, attestation: OWNS }),
    (e) => { assert.equal(e.needsConfiguration, "image-gen"); return true; });

  // and a post with neither url nor prompt is refused, because Instagram has no text-only form
  await assert.rejects(
    () => mk(null).publishImage({ caption: "words only", authorization: APPROVED, attestation: OWNS }),
    /Instagram posts need an image/);
});

// ── Facebook Pages ─────────────────────────────────────────────────────────────────────────────
function fbSpy(opts = {}) {
  const calls = [];
  const requestImpl = async ({ path, method, form }) => {
    calls.push({ path, method, form });
    if (opts.fail) throw new Error(opts.fail);
    if (path.endsWith("/photos")) return { id: "PHOTO_1", post_id: "PAGE_1_POST_1" };
    return { id: "PAGE_1_POST_2" };
  };
  const pub = facebookPagePublisher({ pageId: "1234", pageTokenRef: secretRef("facebook:page:acme"), resolveSecret, requestImpl, imageCapability: opts.imageCapability });
  return { pub, calls };
}

test("Facebook text post sends the documented params", async () => {
  const { pub, calls } = fbSpy();
  const r = await pub.publishText({ message: "Launch day", authorization: APPROVED, attestation: OWNS });
  assert.match(calls[0].path, /\/1234\/feed$/);
  assert.equal(calls[0].form.message, "Launch day");
  assert.equal(calls[0].form.published, "true");
  assert.equal(r.postId, "PAGE_1_POST_2");
});

test("Facebook photo post returns post_id as THE post, not the photo id", async () => {
  const { pub, calls } = fbSpy();
  const r = await pub.publishPhoto({ imageUrl: "https://cdn.example.com/a.jpg", caption: "Launch day", authorization: APPROVED, attestation: OWNS });
  assert.match(calls[0].path, /\/1234\/photos$/);
  assert.equal(calls[0].form.url, "https://cdn.example.com/a.jpg");   // documented param is `url`
  assert.equal(calls[0].form.caption, "Launch day");
  // the whole point: post_id identifies the page post; id is only the photo
  assert.equal(r.postId, "PAGE_1_POST_1");
  assert.equal(r.photoId, "PHOTO_1");
});

test("Facebook photo can come from the image-gen slot, and is loud when unconfigured", async () => {
  const gen = fbSpy({ imageCapability: async ({ prompt }) => `https://cdn.example.com/${encodeURIComponent(prompt)}.jpg` });
  const r = await gen.pub.publishPhoto({ imagePrompt: "launch banner", authorization: APPROVED, attestation: OWNS });
  assert.equal(r.imageSource, "generated");
  assert.match(gen.calls[0].form.url, /launch%20banner/);

  const none = fbSpy();
  await assert.rejects(() => none.pub.publishPhoto({ imagePrompt: "x", authorization: APPROVED, attestation: OWNS }),
    (e) => { assert.equal(e.needsConfiguration, "image-gen"); return true; });
  await assert.rejects(() => none.pub.publishPhoto({ authorization: APPROVED, attestation: OWNS }), /needs an image/);
});

test("Facebook inherits every gate and the credential boundary", async () => {
  const { pub, calls } = fbSpy();
  await assert.rejects(() => pub.publishText({ message: "hi", attestation: OWNS }), /approved authorization/);
  await assert.rejects(() => pub.publishText({ message: "hi", authorization: APPROVED }), /own or manage/);
  await assert.rejects(() => pub.publishText({ message: `k ${TOKEN}`, authorization: APPROVED, attestation: OWNS }), /looks like a credential/);
  await assert.rejects(() => pub.publishText({ message: "  ", authorization: APPROVED, attestation: OWNS }), /needs a message/);
  assert.equal(calls.length, 0);
  assert.throws(() => facebookPagePublisher({ pageId: "1", pageTokenRef: TOKEN, resolveSecret }), /secretRef, never a literal token/);
  assert.throws(() => facebookPagePublisher({ pageTokenRef: secretRef("x"), resolveSecret }), /needs the Page id/);

  const leaky = fbSpy({ fail: `boom access_token=${TOKEN}` });
  await assert.rejects(() => leaky.pub.publishText({ message: "hi", authorization: APPROVED, attestation: OWNS }),
    (e) => { assert.ok(!e.message.includes(TOKEN)); return true; });
});

test("a missing Page token says it must be a PAGE token, not a user token", async () => {
  const pub = facebookPagePublisher({ pageId: "1", pageTokenRef: secretRef("facebook:page:nobody"), resolveSecret, requestImpl: async () => ({}) });
  await assert.rejects(() => pub.publishText({ message: "hi", authorization: APPROVED, attestation: OWNS }),
    /PAGE access token, not your user token/);
});

test("no token, no secret and no ref ever reaches an agent-visible surface for any platform", async () => {
  const { agentVisibleConnection } = await import("./social-publishing.mjs");
  const surfaces = [
    fbSpy().pub, linkedinSpy().pub, spyPublisher().pub,
  ].map((p) => JSON.stringify({ view: agentVisibleConnection(p), keys: Object.keys(p), flat: p }));
  for (const s of surfaces) {
    assert.ok(!s.includes(TOKEN), "a token reached an agent-visible surface");
    assert.ok(!s.includes(APP_SECRET));
    assert.ok(!/resolveSecret/.test(s));
  }
});
