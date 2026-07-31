// SPDX-License-Identifier: Apache-2.0
// Shared company-knowledge RAG source — used by the web chat AND the CLI (`bo ask`),
// so both answer from the same company definition with the same citations.
import { connectRagSource, indexDocuments } from "./rag.mjs";
import { listProjects, projectBrief } from "./projects.mjs";

export function companyKnowledgeDocs(def, runtime = null) {
  return [
    { id: "company", resource: "company", text: `Company ${def.company?.name || "(unnamed)"}. Departments: ${(def.departments || []).join(", ")}.` },
    ...(def.agents || []).map((a) => ({ id: a.id, resource: `agent/${a.id}`,
      text: `Agent ${a.id} is the ${a.role} in ${a.department}. Objectives: ${(a.objectives || []).join("; ")}. Tools: ${(a.tools || []).join(", ")}. Permissions: ${(a.permissions || []).join(", ")}. Approvals: ${Object.keys(a.approvalThresholds || {}).join(", ") || "none"}. Activation: ${a.activation}.` })),
    // Projects are company knowledge too: cross-project memory ("where are we on X?") —
    // compact briefs only, never transcripts.
    ...(runtime ? listProjects(runtime).map((p) => ({ id: `project/${p.id}`, resource: `project/${p.id}`,
      text: `Project ${p.name}. ${projectBrief(runtime, p.id) || "(no activity yet)"}` })) : []),
  ];
}

export function buildKnowledgeSource(def, runtime = null) {
  return indexDocuments(connectRagSource({ id: "company-knowledge", label: "Company knowledge", resources: ["company"] }),
    companyKnowledgeDocs(def, runtime), { now: Date.now() });
}
