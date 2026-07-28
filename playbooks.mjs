// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — company playbooks (item 5, 2026-07-28).
// A PLAYBOOK is a ready-made company you can stand up fast. The flagship: build a whole company on
// OPEN-SOURCE tools + free/local models — $0 from the very first minute, every connector READ-ONLY by
// default. Pure data; zero-dep.
import { runtimeConnection } from "./runtimes.mjs";
import { newConnector } from "./connectors.mjs";

const free = (model, provider = "free-provider", extra = {}) =>
  runtimeConnection({ runtime: "generic-llm", provider, model, authSource: "free", ...extra });
const local = (model = "qwen2.5-7b-32k") =>
  runtimeConnection({ runtime: "local-openai", provider: "ollama", model, authSource: "local", modelLocation: "local", contextLimit: 32000 });

/**
 * The free open-source company: five departments, each on a free or local runtime, each wired to an
 * OSS business system READ-ONLY. Nothing SaaS, nothing BrainOutput-funded, nothing that can write or
 * send without an explicit grant + approval. This is the "create your company for free from day one"
 * starting point.
 */
export function ossCompanyPlaybook() {
  const agents = [
    { id: "engineering-lead", department: "technical", role: "architect",
      runtime: runtimeConnection({ runtime: "opencode", provider: "free-coding", model: "(free coding model)", authSource: "free" }),
      capabilities: { worker: "coding-free", reviewer: "high-trust-review" },
      connectors: [newConnector("gitea")], permissions: ["read:gitea"], approvalThresholds: { deploy: "human" }, activation: "dormant" },
    { id: "support-agent", department: "customer-service", role: "support",
      runtime: free("(free multilingual model)"),
      capabilities: { worker: "multilingual" },
      connectors: [newConnector("chatwoot")], permissions: ["read:chatwoot"], approvalThresholds: { "send-reply": "human" }, activation: "dormant" },
    { id: "commerce-manager", department: "operations", role: "ops",
      runtime: free("(free model)"),
      capabilities: { worker: "fast-cheap" },
      connectors: [newConnector("medusa")], permissions: ["read:medusa"], approvalThresholds: { refund: "human" }, activation: "dormant" },
    { id: "finance-controller", department: "finance", role: "controller",
      runtime: local(),
      capabilities: { worker: "private-local", reviewer: "high-trust-review" },
      connectors: [newConnector("erpnext"), newConnector("lago")], permissions: ["read:erpnext", "read:lago"], approvalThresholds: { payment: "human", transfer: "human" }, activation: "dormant" },
    { id: "marketing-content", department: "marketing", role: "content",
      runtime: free("(free model)", "free-provider", { capabilities: ["multilingual", "tools"] }),
      capabilities: { worker: "fast-cheap", "image-gen": "image-gen" },
      connectors: [newConnector("mastodon")], permissions: ["read:mastodon"], approvalThresholds: { publish: "human" }, activation: "dormant" },
  ];
  return {
    company: { name: "Your OSS Company", brainoutputFundedInference: "forbidden" },
    departments: ["technical", "customer-service", "operations", "finance", "marketing"],
    agents,
    stack: [...new Set(agents.flatMap((a) => a.connectors.map((c) => c.label)))],
    note: "A whole company on open-source tools + free/local models — free to start, every connector read-only by default.",
  };
}

export function listPlaybooks() {
  return [{ key: "oss-company", label: "Free open-source company", build: ossCompanyPlaybook }];
}

/**
 * Validate a playbook's promises: every runtime is free/local (never BrainOutput-funded), every
 * connector is READ-ONLY (no elevated grants), every agent is dormant. Returns {ok, errors}.
 */
export function validatePlaybook(pb) {
  const errors = [];
  for (const a of pb.agents || []) {
    if (a.activation !== "dormant") errors.push(`${a.id}: not dormant`);
    const f = a.runtime?.funder;
    if (!["free", "local"].includes(f)) errors.push(`${a.id}: runtime funder '${f}' is not free/local`);
    for (const c of a.connectors || [])
      if ((c.grants || []).length) errors.push(`${a.id}: connector ${c.connector} is not read-only (has grants)`);
  }
  if ((pb.company?.brainoutputFundedInference || "forbidden") !== "forbidden") errors.push("brainoutputFundedInference must be forbidden");
  return { ok: errors.length === 0, errors };
}
