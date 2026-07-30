// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Plane connector: live client (2026-07-30, Directive 6 D6-6).
// Read-only by design here: list projects / issues / comments. Commenting back is a WRITE —
// it goes through the connector permission schema (executeApprovedAction), never silently.
// Works against Plane Cloud (api.plane.so) and any self-hosted Plane — the customer's endpoint.
// Zero-dep (Node ≥18 fetch). The API key arrives as a resolved secret, never from the definition.
//
//   const client = planeClient({ endpoint: "https://plane.example.com", workspace: "acme", token });
//   await planeRead(client, "list-projects");
//   await planeRead(client, "list-issues", { projectId });
//   await planeComment(client, { projectId, issueId, html })          // write — gated upstream
export const PLANE_ACTIONS = ["list-projects", "list-issues", "get-issue", "list-comments"];

export function planeClient({ endpoint, workspace, token, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error("planeClient needs an http(s) endpoint — the customer's Plane URL");
  if (!workspace) throw new Error("planeClient needs a workspace slug");
  const base = `${endpoint.replace(/\/+$/, "")}/api/v1/workspaces/${encodeURIComponent(workspace)}`;

  async function call(path, { method = "GET", body = null } = {}) {
    const r = await fetchImpl(`${base}${path}`, {
      method,
      headers: { "X-API-Key": token || "", "Content-Type": "application/json", ...(body ? {} : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`Plane ${method} ${path} → ${r.status}${r.status === 401 || r.status === 403 ? " (check the API key and workspace access)" : ""}: ${text.slice(0, 200)}`);
    }
    return r.json();
  }
  return { call, base };
}

/** Plane list endpoints answer either a bare array or a paginated { results } envelope. */
const rows = (data) => (Array.isArray(data) ? data : data?.results || []);

const normProject = (p) => ({ id: p.id, name: p.name, identifier: p.identifier || null });
const normIssue = (i) => ({ id: i.id, name: i.name, state: i.state_detail?.name || i.state || null,
  priority: i.priority || null, assignees: (i.assignees || []).length, sequence: i.sequence_id || null });

export async function planeRead(client, action, { projectId = null, issueId = null } = {}) {
  switch (action) {
    case "list-projects":
      return { projects: rows(await client.call("/projects/")).map(normProject) };
    case "list-issues": {
      if (!projectId) throw new Error("list-issues needs a projectId");
      return { issues: rows(await client.call(`/projects/${projectId}/issues/`)).map(normIssue) };
    }
    case "get-issue": {
      if (!projectId || !issueId) throw new Error("get-issue needs projectId and issueId");
      const i = await client.call(`/projects/${projectId}/issues/${issueId}/`);
      return { issue: { ...normIssue(i), description: i.description_stripped || null } };
    }
    case "list-comments": {
      if (!projectId || !issueId) throw new Error("list-comments needs projectId and issueId");
      return { comments: rows(await client.call(`/projects/${projectId}/issues/${issueId}/comments/`))
        .map((c) => ({ id: c.id, text: c.comment_stripped || null, at: c.created_at || null })) };
    }
    default:
      throw new Error(`unknown Plane read '${action}' — one of ${PLANE_ACTIONS.join(", ")}`);
  }
}

/** WRITE: a comment on an issue. Only ever called behind the approval gate (communicate scope). */
export async function planeComment(client, { projectId, issueId, html } = {}) {
  if (!projectId || !issueId || !html) throw new Error("a Plane comment needs projectId, issueId and html");
  return client.call(`/projects/${projectId}/issues/${issueId}/comments/`, { method: "POST", body: { comment_html: html } });
}

/**
 * Bridge to the connector permission schema (connector-adapters.mjs): a fetchImpl that performs
 * the requested READ via a live client. Secrets resolve at execution time, never from the
 * exportable definition — pass a resolver that yields the API key (e.g. store.secretResolver()).
 */
export function planeFetchImpl({ endpoint, workspace, resolveToken, fetchImpl = fetch } = {}) {
  return async (connector, req) => {
    const token = typeof resolveToken === "function" ? await resolveToken() : resolveToken;
    const client = planeClient({ endpoint: endpoint || connector.endpoint, workspace, token, fetchImpl });
    return planeRead(client, req.action, req);
  };
}
