// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { planeClient, planeRead, planeComment, planeFetchImpl, PLANE_ACTIONS } from "./plane.mjs";
import { connectorAction } from "./connector-adapters.mjs";
import { newConnector, grantScope } from "./connectors.mjs";

// A fetch stub that answers Plane-shaped payloads per URL, and records every call.
const stubFetch = (routes) => {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    const [status, body] = hit[1];
    return { ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
  };
  f.calls = calls;
  return f;
};

const client = (f) => planeClient({ endpoint: "https://plane.example.com", workspace: "acme", token: "tk", fetchImpl: f });

test("client builds the v1 URL and sends the API key; list shapes normalize", async () => {
  const f = stubFetch({
    "/projects/": [200, { results: [{ id: "p1", name: "PDF SaaS", identifier: "PDF" }] }],
  });
  const out = await planeRead(client(f), "list-projects");
  assert.deepEqual(out.projects, [{ id: "p1", name: "PDF SaaS", identifier: "PDF" }]);
  assert.match(f.calls[0].url, /^https:\/\/plane\.example\.com\/api\/v1\/workspaces\/acme\/projects\/$/);
  assert.equal(f.calls[0].opts.headers["X-API-Key"], "tk");
});

test("bare-array and paginated envelopes both read; issues carry state names", async () => {
  const f = stubFetch({
    "/issues/": [200, [{ id: "i1", name: "Launch checklist", state_detail: { name: "Started" }, priority: "high", assignees: ["u1"], sequence_id: 3 }]],
  });
  const out = await planeRead(client(f), "list-issues", { projectId: "p1" });
  assert.deepEqual(out.issues[0], { id: "i1", name: "Launch checklist", state: "Started", priority: "high", assignees: 1, sequence: 3 });
});

test("a 401 names the key problem; unknown reads are refused", async () => {
  const f = stubFetch({ "/projects/": [401, { detail: "bad key" }] });
  await assert.rejects(() => planeRead(client(f), "list-projects"), /401.*API key/);
  await assert.rejects(() => planeRead(client(f), "delete-everything"), /unknown Plane read/);
  await assert.rejects(() => planeRead(client(f), "list-issues"), /projectId/);
});

test("comments read; planeComment POSTs comment_html", async () => {
  const f = stubFetch({
    "/comments/": [200, { results: [{ id: "c1", comment_stripped: "looking into it", created_at: "2026-07-30" }] }],
  });
  const out = await planeRead(client(f), "list-comments", { projectId: "p1", issueId: "i1" });
  assert.deepEqual(out.comments, [{ id: "c1", text: "looking into it", at: "2026-07-30" }]);

  await planeComment(client(f), { projectId: "p1", issueId: "i1", html: "<p>done</p>" });
  const post = f.calls.find((c) => c.opts.method === "POST");
  assert.ok(post, "a POST happened");
  assert.deepEqual(JSON.parse(post.opts.body), { comment_html: "<p>done</p>" });
});

test("through the permission schema: read executes live, comment stays gated", async () => {
  const f = stubFetch({ "/projects/": [200, { results: [] }] });
  let conn = newConnector("plane");
  conn = { ...conn, endpoint: "https://plane.example.com" };   // a live deployment sets the URL
  conn = grantScope(conn, { scope: "write" });

  const read = await connectorAction(conn, { action: "list-projects" },
    { fetchImpl: planeFetchImpl({ workspace: "acme", resolveToken: async () => "tk", fetchImpl: f }) });
  assert.equal(read.executed, true);
  assert.equal(read.readOnly, true);
  assert.deepEqual(read.data.projects, []);

  // A write is NEVER fired silently — it comes back as a pending human approval with the plan.
  const write = await connectorAction(conn, { action: "comment", resource: "issue/i1", payload: { html: "<p>hi</p>" } });
  assert.equal(write.executed, false);
  assert.equal(write.status, "pending-human-approval");
  assert.equal(f.calls.length, 1, "no extra HTTP fired for the gated write");
});

test("every advertised read action is implemented", () => {
  for (const a of PLANE_ACTIONS) assert.ok(["list-projects", "list-issues", "get-issue", "list-comments"].includes(a));
});
