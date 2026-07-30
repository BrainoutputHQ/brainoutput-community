// SPDX-License-Identifier: Apache-2.0
// Shared company-knowledge RAG source — used by the web chat AND the CLI (`bo ask`),
// so both answer from the same company definition with the same citations.
import { connectRagSource, indexDocuments } from "./rag.mjs";

export function companyKnowledgeDocs(def) {
  return [
    { id: "company", resource: "company", text: `Company ${def.company?.name || "(unnamed)"}. Departments: ${(def.departments || []).join(", ")}.` },
    ...(def.agents || []).map((a) => ({ id: a.id, resource: `agent/${a.id}`,
      text: `Agent ${a.id} is the ${a.role} in ${a.department}. Objectives: ${(a.objectives || []).join("; ")}. Tools: ${(a.tools || []).join(", ")}. Permissions: ${(a.permissions || []).join(", ")}. Approvals: ${Object.keys(a.approvalThresholds || {}).join(", ") || "none"}. Activation: ${a.activation}.` })),
  ];
}

export function buildKnowledgeSource(def) {
  return indexDocuments(connectRagSource({ id: "company-knowledge", label: "Company knowledge", resources: ["company"] }),
    companyKnowledgeDocs(def), { now: Date.now() });
}
