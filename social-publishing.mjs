#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Deterministic social publishing. Instagram first (Meta Graph API).
//
// THE INVARIANT THIS FILE EXISTS TO ENFORCE
// -----------------------------------------
// An LLM agent never receives, sees, logs or displays the access token or the app secret. Agents
// deal only in an opaque SecretRef — a name like "instagram:acme". The secret is resolved from the
// customer's own sealed store inside this module, used to sign one HTTP call, and never returned.
//
// That is not a policy comment; it is enforced three ways and each has a test:
//   1. resolve happens HERE, at execution time, never in anything an agent can read;
//   2. every value leaving this module passes through redact(), which strips secret-shaped strings
//      even out of the vendor's own error text (Meta echoes request params back on failure);
//   3. publishInstagram REFUSES a draft that carries a literal token, so a confused agent that
//      somehow obtained one cannot launder it through the publish path.
//
// CONNECTION MODES (founder decision, 2026-07-29)
//   own-meta-app     — the customer's OWN Meta app, their token, in their store. Available now.
//                      Genuinely BYOK: we never hold the credential and cannot post without them.
//   brainoutput-app  — one BrainOutput Meta app for everyone. NOT available: it requires Meta App
//                      Review, which has not happened. It refuses rather than silently degrading,
//                      because a "connect" button that quietly does something else is the worst
//                      possible failure here.
//
// Endpoints and limits are the CURRENT documented ones
// (developers.facebook.com/docs/instagram-platform/content-publishing, retrieved 2026-07-29):
//   POST /{ig-id}/media            -> container id
//   POST /{ig-id}/media_publish    -> media id      (param: creation_id)
//   GET  /{container-id}?fields=status_code
//   GET  /{ig-id}/content_publishing_limit
//   100 API-published posts per rolling 24h. A carousel counts as one.
import { request as httpsRequest } from "node:https";

export const GRAPH_HOST = "graph.facebook.com";
export const GRAPH_VERSION = "v21.0";

/** Documented ceiling: 100 API-published posts per rolling 24 hours. A carousel counts as one. */
export const IG_DAILY_POST_LIMIT = 100;

export const IG_CONNECTION_MODES = {
  "own-meta-app": {
    available: true,
    label: "Connect Instagram with your own Meta app",
    detail:
      "You create a Meta app, you hold the token. It stays in your secret store; BrainOutput never receives it and cannot post without you.",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    facebookLoginScopes: ["instagram_basic", "instagram_content_publish", "pages_read_engagement"],
  },
  "brainoutput-app": {
    available: false,
    label: "Connect with BrainOutput",
    detail: "One click, no Meta app of your own.",
    blockedBy:
      "Meta App Review has not been completed, so this option does not exist yet. It is shown so the choice is honest, not to imply it is coming imminently.",
  },
};

/**
 * The only shape an agent is ever allowed to hold. It names a secret; it never carries one.
 * Frozen so a downstream caller cannot decorate it with the real value "just this once".
 */
export function secretRef(name) {
  if (!name || /\s/.test(String(name))) throw new Error("a secret ref needs a name with no whitespace");
  return Object.freeze({ __secretRef: true, name: String(name) });
}
export const isSecretRef = (v) => !!v && v.__secretRef === true && typeof v.name === "string";

// Anything that looks like a Meta credential. Long opaque runs, and the token forms Meta issues.
const SECRET_PATTERNS = [
  /\bEAA[A-Za-z0-9_-]{20,}/g,          // Meta user/page access tokens
  /\bIGQ[A-Za-z0-9_-]{20,}/g,          // Instagram tokens
  /\b[A-Fa-f0-9]{32}\b/g,              // app secret (32 hex)
  /access_token=[^&\s"']+/g,
  /client_secret=[^&\s"']+/g,
];

/**
 * Strip anything credential-shaped. Applied to EVERY value leaving this module, including vendor
 * error text — Meta echoes request parameters back in some errors, so an unredacted upstream message
 * is a real leak path into a log an agent later reads.
 */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    let out = value;
    for (const p of SECRET_PATTERNS) out = out.replace(p, (m) => (m.includes("=") ? `${m.split("=")[0]}=[redacted]` : "[redacted]"));
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|secret|password|credential/i.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

/** True if a string plausibly contains a live credential — used to refuse tainted input. */
export const looksSecret = (s) => typeof s === "string" && SECRET_PATTERNS.some((p) => { p.lastIndex = 0; return p.test(s); });


// ── shared publishing core ──────────────────────────────────────────────────────────────────────
// Every platform inherits the SAME refusals. Adding a network must not be a chance to forget one,
// so the gates live here and each publisher calls this before it touches a wire.

/**
 * The gates that must pass before anything is posted anywhere.
 *   approval    — a human said yes to THIS draft (communicate scope is never silent)
 *   attestation — the customer owns or manages the account. BYOK makes the credential theirs; it
 *                 does not make posting to someone else's account acceptable.
 *   taint       — a draft carrying anything credential-shaped is refused before any HTTP call, so a
 *                 confused agent cannot launder a token through a caption.
 */
export function assertPublishable({ platform, authorization, attestation, texts = [] }) {
  if (!authorization?.approved) throw new Error(`publishing to ${platform} needs an approved authorization (communicate scope + human approval)`);
  if (!attestation?.ownsAccount) throw new Error(`publishing to ${platform} needs the customer's attestation that they own or manage this account`);
  for (const t of texts) if (looksSecret(t)) throw new Error(`refusing to publish to ${platform}: the draft contains something that looks like a credential`);
  return true;
}

/**
 * Resolve the image a post needs.
 *
 * This is where the `image-gen` capability slot finally earns its place: a social draft usually
 * needs a picture, and the agent writing the copy is not the thing that should be making it.
 *   • an explicit https URL wins — the customer supplied it, nothing to generate;
 *   • a prompt goes to the configured image capability;
 *   • an UNCONFIGURED capability is not an error to swallow. It reports the free/local options,
 *     exactly like every other slot in this codebase, and never silently reaches for a paid one.
 */
export async function resolveImage({ imageUrl = null, imagePrompt = null, imageCapability = null } = {}) {
  if (imageUrl) {
    if (!/^https:\/\//.test(String(imageUrl))) throw new Error("an image url must be public https — the platform fetches it itself");
    return { url: imageUrl, source: "supplied" };
  }
  if (!imagePrompt) return { url: null, source: "none" };
  if (typeof imageCapability !== "function") {
    const e = new Error("this post needs an image but no image-gen capability is configured");
    e.needsConfiguration = "image-gen";
    e.options = ["Run a local image model (e.g. SDXL via ComfyUI)", "Connect your own image provider (BYOK)", "Supply the image URL yourself", "Post without an image"];
    throw e;
  }
  const url = await imageCapability({ prompt: imagePrompt });
  if (!url || !/^https:\/\//.test(String(url))) throw new Error("the image capability did not return a public https URL");
  return { url, source: "generated" };
}

function graph({ path, method = "GET", form = null, requestImpl = null }) {
  // An injected transport is still a transport: its failures pass through the same filter. Without
  // this, a deployment's own HTTP layer could throw "…access_token=EAA…" and it would propagate
  // unredacted — the exact leak this module exists to prevent, arriving through the back door.
  if (requestImpl) return Promise.resolve(requestImpl({ path, method, form }))
    .catch((e) => { throw new Error(redact(e?.message || String(e))); });
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : null;
    const req = httpsRequest(
      { host: GRAPH_HOST, path: `/${GRAPH_VERSION}${path}`, method,
        headers: body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {} },
      (res) => {
        res.setEncoding("utf8");
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let j = null;
          try { j = d ? JSON.parse(d) : {}; } catch { j = { raw: d }; }
          if (res.statusCode >= 400) {
            const e = j?.error || {};
            // redact BEFORE the message is ever constructed — it may quote our own request
            return reject(new Error(redact(`Instagram publish failed (${res.statusCode}) ${e.code || ""} ${e.message || d.slice(0, 200)}`.trim())));
          }
          resolve(j ?? {});
        });
      },
    );
    req.on("error", (e) => reject(new Error(redact(e.message))));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * The deterministic publisher.
 *
 * `resolveSecret` is the ONLY way a credential enters, and it is called here — not by the caller,
 * not by an agent. In a real deployment it is the sealed store's opener; the module never keeps a
 * reference to what it returns beyond the calls below.
 */
export function instagramPublisher({ mode = "own-meta-app", igUserId, tokenRef, resolveSecret, requestImpl = null, imageCapability = null } = {}) {
  const modeSpec = IG_CONNECTION_MODES[mode];
  if (!modeSpec) throw new Error(`unknown Instagram connection mode '${mode}'`);
  if (!modeSpec.available) throw new Error(`${modeSpec.label} is not available: ${modeSpec.blockedBy}`);
  if (!igUserId) throw new Error("instagramPublisher needs the Instagram professional account id");
  if (!isSecretRef(tokenRef)) throw new Error("instagramPublisher needs a secretRef, never a literal token");
  if (typeof resolveSecret !== "function") throw new Error("instagramPublisher needs resolveSecret() to read the customer's own store");

  const token = async () => {
    const t = await resolveSecret(tokenRef.name);
    if (!t) throw new Error(`no credential named '${tokenRef.name}' in your secret store — connect Instagram first`);
    return t;
  };

  return {
    connector: "instagram",
    mode,
    verified: false,          // no live Meta app has exercised this
    accountId: `instagram:${igUserId}`,

    /** Remaining quota. Checked before publishing so we fail with a clear reason, not a 429. */
    async quota() {
      const r = await graph({ path: `/${encodeURIComponent(igUserId)}/content_publishing_limit?fields=config,quota_usage&access_token=${encodeURIComponent(await token())}`, requestImpl });
      const used = Number(r?.data?.[0]?.quota_usage ?? 0);
      const cap = Number(r?.data?.[0]?.config?.quota_total ?? IG_DAILY_POST_LIMIT);
      return { used, cap, remaining: Math.max(0, cap - used) };
    },

    async containerStatus(containerId) {
      const r = await graph({ path: `/${encodeURIComponent(containerId)}?fields=status_code&access_token=${encodeURIComponent(await token())}`, requestImpl });
      return r.status_code || "UNKNOWN";
    },

    /**
     * Publish one image. Two documented steps: create a container, then publish it.
     *
     * Refuses unless the caller proves (a) a human approved this exact draft, and (b) the customer
     * attested they own or manage the account. Publishing to an account you do not control is the
     * abuse case Meta's policies exist for, and BYOK does not make it our customer's problem alone.
     */
    async publishImage({ imageUrl = null, imagePrompt = null, caption = "", authorization = null, attestation = null } = {}) {
      assertPublishable({ platform: "Instagram", authorization, attestation, texts: [caption, imageUrl, imagePrompt] });
      // An Instagram post is an image post — there is no text-only form. So this is where the
      // image-gen slot is load-bearing: give a prompt and a configured capability, or a URL.
      const img = await resolveImage({ imageUrl, imagePrompt, imageCapability });
      if (!img.url) throw new Error("Instagram posts need an image: supply imageUrl, or imagePrompt with an image-gen capability configured");
      imageUrl = img.url;

      const q = await this.quota();
      if (q.remaining <= 0) throw new Error(`Instagram's ${q.cap}-post rolling 24h limit is used up (${q.used}/${q.cap}) — try later`);

      const access = await token();
      const created = await graph({ path: `/${encodeURIComponent(igUserId)}/media`, method: "POST",
        form: { image_url: imageUrl, caption, access_token: access }, requestImpl });
      if (!created?.id) throw new Error("Instagram did not return a container id");

      const published = await graph({ path: `/${encodeURIComponent(igUserId)}/media_publish`, method: "POST",
        form: { creation_id: created.id, access_token: access }, requestImpl });

      // redact() on the way out even though these fields are ids — the rule is that NOTHING leaves
      // this module unfiltered, so a future field cannot quietly become a leak.
      return redact({ containerId: created.id, mediaId: published?.id || null, quotaRemaining: q.remaining - 1, imageSource: img.source });
    },
  };
}

/** What onboarding shows. The unavailable option is listed honestly rather than hidden. */
export function instagramConnectionOptions() {
  return Object.entries(IG_CONNECTION_MODES).map(([key, m]) => ({
    key, label: m.label, detail: m.detail, available: m.available,
    ...(m.available ? { scopes: m.scopes } : { blockedBy: m.blockedBy }),
  }));
}

/**
 * What an AGENT is allowed to see about a publishing connection. No token, no ref value, no store
 * path — just enough to reason about whether it can draft a post.
 */
export function agentVisibleConnection(pub) {
  return Object.freeze({
    connector: pub.connector, mode: pub.mode, accountId: pub.accountId,
    canDraft: true, canPublish: false,      // an agent DRAFTS; the connector publishes
    note: "You draft. A deterministic connector publishes, using a credential you never see.",
  });
}

// ── LinkedIn ────────────────────────────────────────────────────────────────────────────────────
// POST https://api.linkedin.com/rest/posts  (learn.microsoft.com/linkedin/marketing/community-
// management/shares/posts-api, retrieved 2026-07-29). Same credential boundary as Instagram: the
// agent holds a secretRef, this module resolves it, nothing sensitive comes back.

export const LINKEDIN_HOST = "api.linkedin.com";

/**
 * LinkedIn requires a Linkedin-Version header in YYYYMM form, and it SUNSETS old versions — the
 * docs carry a deprecation warning for exactly that. Pinning it in code with no way to change it
 * would guarantee a silent breakage months from now, so it is configurable and defaulted here.
 */
export const LINKEDIN_DEFAULT_VERSION = "202607";

export const LINKEDIN_SCOPES = {
  member: ["w_member_social"],
  organization: ["w_organization_social"],
};

/** urn:li:person:{id} for a member, urn:li:organization:{id} for a company page. */
export function linkedinAuthorUrn({ as = "member", id }) {
  if (!id) throw new Error("a LinkedIn author needs an id");
  if (!["member", "organization"].includes(as)) throw new Error(`unknown LinkedIn author type '${as}'`);
  return as === "member" ? `urn:li:person:${id}` : `urn:li:organization:${id}`;
}

function linkedinRequest({ path, method = "POST", body, token, version, requestImpl }) {
  if (requestImpl) return Promise.resolve(requestImpl({ path, method, body }))
    .catch((e) => { throw new Error(redact(e?.message || String(e))); });
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = httpsRequest({ host: LINKEDIN_HOST, path, method, headers: {
      authorization: `Bearer ${token}`,
      "x-restli-protocol-version": "2.0.0",
      "linkedin-version": version,
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
    } }, (res) => {
      res.setEncoding("utf8");
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          let j = null; try { j = JSON.parse(d); } catch { /* raw */ }
          return reject(new Error(redact(`LinkedIn publish failed (${res.statusCode}) ${j?.code || ""} ${j?.message || d.slice(0, 200)}`.trim())));
        }
        // The post id arrives in a RESPONSE HEADER, not the body. Reading the body for it — the
        // obvious guess — yields null on a perfectly successful 201.
        resolve({ status: res.statusCode, id: res.headers["x-restli-id"] || null });
      });
    });
    req.on("error", (e) => reject(new Error(redact(e.message))));
    if (payload) req.write(payload);
    req.end();
  });
}

export function linkedinPublisher({ as = "member", authorId, tokenRef, resolveSecret, version = LINKEDIN_DEFAULT_VERSION, requestImpl = null, imageCapability = null } = {}) {
  if (!isSecretRef(tokenRef)) throw new Error("linkedinPublisher needs a secretRef, never a literal token");
  if (typeof resolveSecret !== "function") throw new Error("linkedinPublisher needs resolveSecret() to read the customer's own store");
  if (!/^\d{6}$/.test(String(version))) throw new Error("LinkedIn-Version must be YYYYMM, e.g. 202607");
  const author = linkedinAuthorUrn({ as, id: authorId });

  const token = async () => {
    const t = await resolveSecret(tokenRef.name);
    if (!t) throw new Error(`no credential named '${tokenRef.name}' in your secret store — connect LinkedIn first`);
    return t;
  };

  return {
    connector: "linkedin",
    mode: "own-linkedin-app",
    verified: false,
    accountId: author,
    scopes: LINKEDIN_SCOPES[as === "member" ? "member" : "organization"],

    /**
     * A text post, optionally with an already-uploaded image URN.
     *
     * NOT IMPLEMENTED: uploading the image binary. That is LinkedIn's separate Images API
     * (initializeUpload -> PUT the bytes -> urn:li:image:{id}); until it exists, an image post
     * requires a URN the customer already has, and asking for a raw URL is refused rather than
     * quietly dropping the picture from their post.
     */
    async publishPost({ commentary, imageUrn = null, imageUrl = null, imagePrompt = null, visibility = "PUBLIC", authorization = null, attestation = null } = {}) {
      assertPublishable({ platform: "LinkedIn", authorization, attestation, texts: [commentary, imageUrn] });
      if (!commentary || !String(commentary).trim()) throw new Error("a LinkedIn post needs commentary");
      if (imageUrl || imagePrompt)
        throw new Error("LinkedIn needs an uploaded image URN, not a URL: its Images API upload is not implemented yet, so supply imageUrn or post text only");
      if (imageUrn && !/^urn:li:image:/.test(imageUrn)) throw new Error("imageUrn must look like urn:li:image:{id}");

      const body = {
        author,
        commentary: String(commentary),
        visibility,
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(imageUrn ? { content: { media: { id: imageUrn } } } : {}),
      };
      const r = await linkedinRequest({ path: "/rest/posts", method: "POST", body, token: await token(), version, requestImpl });
      return redact({ postId: r.id, status: r.status, author });
    },
  };
}

// ── Facebook Pages ──────────────────────────────────────────────────────────────────────────────
// developers.facebook.com/docs/pages-api/posts (retrieved 2026-07-29). Same Graph host as
// Instagram, same credential boundary, same gates.
//
// Two things here bite people, so they are encoded rather than left to the caller:
//   1. It needs a PAGE access token, not the user token you get from login. A user token fails with
//      a permissions error that reads like a scope problem and is not one.
//   2. The photo endpoint returns BOTH `id` and `post_id`. `id` is the PHOTO; `post_id` identifies
//      the page post. Storing `id` and calling it the post is the easy, wrong choice.

export const FB_PAGE_SCOPES = ["pages_manage_posts", "pages_manage_engagement"];

/** Tasks the authorizing user must hold on the Page, per the docs. Surfaced for onboarding copy. */
export const FB_PAGE_TASKS = ["CREATE_CONTENT", "MANAGE", "MODERATE"];

export function facebookPagePublisher({ pageId, pageTokenRef, resolveSecret, requestImpl = null, imageCapability = null } = {}) {
  if (!pageId) throw new Error("facebookPagePublisher needs the Page id");
  if (!isSecretRef(pageTokenRef)) throw new Error("facebookPagePublisher needs a secretRef, never a literal token");
  if (typeof resolveSecret !== "function") throw new Error("facebookPagePublisher needs resolveSecret() to read the customer's own store");

  const token = async () => {
    const t = await resolveSecret(pageTokenRef.name);
    if (!t) throw new Error(`no credential named '${pageTokenRef.name}' in your secret store — connect this Facebook Page first (a PAGE access token, not your user token)`);
    return t;
  };

  return {
    connector: "facebook",
    mode: "own-meta-app",
    verified: false,
    accountId: `facebook:page:${pageId}`,
    scopes: FB_PAGE_SCOPES,
    requiredPageTasks: FB_PAGE_TASKS,

    /** Text post. POST /{page-id}/feed with message + published. */
    async publishText({ message, authorization = null, attestation = null } = {}) {
      assertPublishable({ platform: "Facebook", authorization, attestation, texts: [message] });
      if (!message || !String(message).trim()) throw new Error("a Facebook post needs a message");
      const r = await graph({ path: `/${encodeURIComponent(pageId)}/feed`, method: "POST",
        form: { message: String(message), published: "true", access_token: await token() }, requestImpl });
      return redact({ postId: r?.id || null, kind: "text" });
    },

    /**
     * Photo post. POST /{page-id}/photos with url (the only documented-required param); the caption
     * is optional. Facebook fetches the image itself, so the URL must be publicly reachable.
     */
    async publishPhoto({ imageUrl = null, imagePrompt = null, caption = "", authorization = null, attestation = null } = {}) {
      assertPublishable({ platform: "Facebook", authorization, attestation, texts: [caption, imageUrl, imagePrompt] });
      const img = await resolveImage({ imageUrl, imagePrompt, imageCapability });
      if (!img.url) throw new Error("a Facebook photo post needs an image: supply imageUrl, or imagePrompt with an image-gen capability configured");
      const r = await graph({ path: `/${encodeURIComponent(pageId)}/photos`, method: "POST",
        form: { url: img.url, ...(caption ? { caption: String(caption) } : {}), access_token: await token() }, requestImpl });
      // post_id identifies the PAGE POST; id is only the photo. Both are returned so a caller that
      // genuinely wants the photo can have it, but postId is the one that means "the post".
      return redact({ postId: r?.post_id || null, photoId: r?.id || null, kind: "photo", imageSource: img.source });
    },
  };
}

