// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — projects: group conversations by what you're building
// (2026-07-30, Directive 6 D6-2). A project is the durable memory anchor: its threads,
// missions, executions and artifacts stay grouped so nothing is lost between sessions.
// Pure logic over the runtime store object; zero-dep.
//
// The runtime `projects` collection is shared with saved workflows (kind:"workflow") —
// everything here filters on kind:"project" and never touches workflow records.
export const PROJECT_KIND = "project";

export function newProject({ id, name, at = null } = {}) {
  const n = String(name || "").trim();
  if (!n) throw new Error("a project needs a name");
  return { id: id || `proj-${Date.now().toString(36)}`, kind: PROJECT_KIND, name: n,
    summary: null, createdAt: at, updatedAt: at };
}

export const listProjects = (runtime) =>
  (runtime.projects || []).filter((p) => p && p.kind === PROJECT_KIND)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

/** Find by id, or by name (case-insensitive) so a user can say "move this to pdf-saas". */
export function findProject(runtime, idOrName) {
  const want = String(idOrName || "").trim().toLowerCase();
  if (!want) return null;
  return listProjects(runtime).find((p) => p.id === idOrName || p.name.toLowerCase() === want) || null;
}

export const projectThreads = (runtime, projectId) =>
  (runtime.conversations || []).filter((c) => c.projectId === projectId);

/** Ad-hoc threads: conversations nobody assigned to a project. */
export const adHocThreads = (runtime) =>
  (runtime.conversations || []).filter((c) => !c.projectId);

/**
 * Move a conversation into a project — creating the project from a name when needed
 * ("promote an ad-hoc thread to a project in one click"). Returns the records to persist;
 * the caller writes them (this module stays pure).
 */
export function promoteConversation(runtime, { conversationId, projectId = null, newProjectName = null, at = null } = {}) {
  const conv = (runtime.conversations || []).find((c) => c.id === conversationId);
  if (!conv) throw new Error(`no conversation '${conversationId}'`);
  let project = projectId ? findProject(runtime, projectId) : null;
  if (projectId && !project) throw new Error(`no project '${projectId}'`);
  if (!project) {
    if (!newProjectName) throw new Error("promoting needs a projectId or a newProjectName");
    project = newProject({ name: newProjectName, at });
  }
  const nextConv = { ...conv, projectId: project.id };
  const nextProject = { ...project, updatedAt: at };
  return { project: nextProject, conversation: nextConv, created: !projectId };
}

/**
 * The compact brief a WORKER gets when it starts cold in a project: what the project is,
 * what already shipped, what is open, and the pinned decisions. Transcripts never travel —
 * this digest is the entire cross-run memory contract. Bounded; deterministic.
 */
export function projectBrief(runtime, projectId, { maxLen = 700 } = {}) {
  const project = findProject(runtime, projectId);
  if (!project) return null;
  const digest = projectDigest(runtime, project.id);
  const tasks = (runtime.tasks || []).filter((t) => t.projectId === project.id);
  const done = tasks.filter((t) => t.status === "done" && t.result).slice(-3);
  const open = tasks.filter((t) => t.status !== "done" && !t.parentId).slice(0, 5);
  const pinned = (runtime.conversations || []).filter((c) => c.projectId === project.id)
    .flatMap((c) => c.pinned || []).slice(-5);
  const parts = [`project "${project.name}" — ${digest.missions} mission(s), ${digest.executions} run(s), ${digest.threads} conversation(s).`];
  if (done.length) parts.push(`done: ${done.map((t) => `${t.title} → ${(t.result.summary || "").slice(0, 60)}`).join("; ")}`);
  if (open.length) parts.push(`open: ${open.map((t) => t.title).join("; ")}`);
  if (pinned.length) parts.push(`decisions: ${pinned.map((p) => p.text).join("; ")}`);
  return parts.join("\n").slice(0, maxLen);
}

/**
 * The memory anchor for "remember projects as much as possible": a compact digest of
 * everything a project holds, so a worker resumes with full context and nothing is lost.
 */
export function projectDigest(runtime, projectId) {
  const project = findProject(runtime, projectId);
  if (!project) return null;
  const threads = projectThreads(runtime, project.id);
  const convIds = new Set(threads.map((c) => c.id));
  const missions = (runtime.missions || []).filter((m) => m.projectId === project.id || convIds.has(m.conversationId));
  const missionIds = new Set(missions.map((m) => m.id));
  const executions = (runtime.executions || []).filter((e) => missionIds.has(e.missionId));
  const pendingApprovals = (runtime.approvals || []).filter((a) => a.status === "pending" && missionIds.has(a.missionId));
  return {
    project,
    threads: threads.length,
    missions: missions.length,
    missionsByStatus: missions.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {}),
    executions: executions.length,
    artifacts: executions.flatMap((e) => e.artifacts || []).length,
    pendingApprovals: pendingApprovals.length,
    lastActivity: Math.max(0, ...threads.map((c) => c.updatedAt || 0), ...missions.map((m) => m.approvedAt || 0), ...executions.map((e) => e.createdAt || 0)),
  };
}
