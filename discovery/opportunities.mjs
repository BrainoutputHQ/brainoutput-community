#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// AI Opportunity Audit.
//
// The temptation in this feature is to produce a slide that says "save €48,000/year". That number
// is always manufactured, and manufacturing it is how these audits lose their credibility. So the
// rule here is structural, not stylistic: a benefit CANNOT be rendered without the assumptions it
// rests on. `estimate()` refuses to build one, and `renderBenefit()` refuses to print one.
//
// What is inventoried is what the user actually has (installed applications, connected tools) plus
// workflows the user EXPLICITLY selected. Nothing is inferred about how someone works from the
// mere presence of an application — "you have Excel, therefore you spend 10 hours a week in it" is
// a guess wearing a suit.
import { createHash } from "node:crypto";

/** Every opportunity carries its own uncertainty. `speculative` is not a failure, it is honest. */
export const CONFIDENCE = ["speculative", "low", "moderate", "high"];

/**
 * A benefit estimate. Every field is required — there is no constructor path that yields a number
 * without its basis, which is the point.
 */
export function estimate({ metric, value, unit, assumptions = [], basis = null, confidence = "speculative" } = {}) {
  if (!metric) throw new Error("an estimate needs a metric (what is being estimated)");
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("an estimate needs a finite numeric value");
  if (!unit) throw new Error("an estimate needs a unit");
  if (!Array.isArray(assumptions) || assumptions.length === 0)
    throw new Error(`refusing to state '${metric}' without assumptions — an unqualified benefit number is a fabrication`);
  if (!basis) throw new Error("an estimate needs a basis: where the input numbers came from");
  if (!CONFIDENCE.includes(confidence)) throw new Error(`unknown confidence '${confidence}'`);
  return Object.freeze({ metric, value, unit, assumptions: Object.freeze([...assumptions]), basis, confidence });
}

/** Print a benefit only ever WITH its assumptions attached. */
export function renderBenefit(e) {
  if (!e) return "no benefit estimated";
  if (!e.assumptions?.length || !e.basis) throw new Error("refusing to render a benefit without its assumptions");
  return [
    `${e.metric}: ~${e.value} ${e.unit}  (confidence: ${e.confidence})`,
    `  basis: ${e.basis}`,
    ...e.assumptions.map((a) => `  assumes: ${a}`),
    `  → these assumptions are the estimate. Change one and the number changes.`,
  ].join("\n");
}

/**
 * A workflow the USER selected. We do not detect "repetitive work" by watching them — that would
 * be surveillance, and it would be inference dressed as evidence.
 */
export function selectedWorkflow({ name, description, frequency, minutesEach, doneBy, systems = [], selectedBy }) {
  if (!selectedBy) throw new Error("a workflow must record who selected it — these are never auto-detected");
  if (!name || !frequency) throw new Error("a workflow needs a name and a frequency");
  return Object.freeze({ name, description: description || "", frequency, minutesEach: minutesEach ?? null,
                         doneBy: doneBy || "unspecified", systems: Object.freeze([...systems]), selectedBy });
}

/**
 * Inventory what is actually installed/connected. Both inputs are evidence from collectors, not
 * guesses. `connectedTools` comes from the connector catalog — things genuinely authorized.
 */
export function auditInputs({ installedApps = [], connectedTools = [], workflows = [], observations = [] } = {}) {
  return {
    installedApps: installedApps.map((a) => ({ name: a.name, version: a.version ?? null, evidence: a.evidence ?? null })),
    connectedTools: connectedTools.map((t) => ({ connector: t.connector, scopes: t.scopes ?? [], verified: !!t.verified })),
    workflows,
    evidenceCount: observations.length,
  };
}

/**
 * Propose an opportunity. Structure is mandatory: an agent, the tools it needs, the permissions it
 * would hold, a pilot small enough to abandon, the risk, and — only if assumptions exist — a benefit.
 */
export function opportunity({ id, title, workflow, proposedAgent, tools = [], permissions = [], pilot, risks = [], benefit = null, confidence = "speculative", assumptionsVisible = true }) {
  if (!title || !proposedAgent) throw new Error("an opportunity needs a title and a proposed agent");
  if (!pilot) throw new Error("an opportunity needs a pilot: something small enough to abandon cheaply");
  if (!risks.length) throw new Error("an opportunity with no stated risk has not been thought about");
  if (benefit) renderBenefit(benefit);   // throws unless the benefit carries assumptions
  return Object.freeze({
    id: id || `OPP-${createHash("sha256").update(title).digest("hex").slice(0, 6)}`,
    title, workflow: workflow || null, proposedAgent,
    tools: Object.freeze([...tools]), permissions: Object.freeze([...permissions]),
    pilot, risks: Object.freeze([...risks]), benefit, confidence, assumptionsVisible,
  });
}

/**
 * Rank. Deliberately NOT by claimed benefit — that would reward whoever invented the biggest
 * number. Ranked by how cheaply the claim can be TESTED: a small pilot with a stated risk and an
 * honest confidence beats a large speculative saving.
 */
export function prioritize(opportunities) {
  const score = (o) => {
    const conf = { speculative: 0, low: 1, moderate: 2, high: 3 }[o.confidence] ?? 0;
    const cheapPilot = /day|hour|one |single|week/i.test(o.pilot) ? 2 : 0;
    const readOnly = o.permissions.every((p) => /read|observe/i.test(p)) ? 2 : 0;
    const risky = o.risks.some((r) => /irreversible|customer|financial|legal/i.test(r)) ? -2 : 0;
    return conf + cheapPilot + readOnly + risky;
  };
  return [...opportunities].sort((a, b) => score(b) - score(a)).map((o, i) => ({ ...o, rank: i + 1, testability: score(o) }));
}

/**
 * Turn one opportunity into an EDITABLE mission. It is a draft: nothing is scheduled, nothing is
 * granted, and the permissions it names still have to be approved separately.
 */
export function toMission(o, { createdBy = "discovery", at = Date.now() } = {}) {
  return {
    id: `M-${o.id}`, kind: "ai-opportunity", title: o.title, status: "draft", editable: true,
    createdBy, at,
    objective: `Pilot: ${o.pilot}`,
    agent: o.proposedAgent,
    tools: [...o.tools],
    permissionsRequested: [...o.permissions],
    risks: [...o.risks],
    benefit: o.benefit ? { ...o.benefit, assumptions: [...o.benefit.assumptions] } : null,
    approvals: { required: true, granted: false },
    note: "Draft. No permission is granted and nothing runs until you approve it.",
  };
}

/** The whole audit, end to end. Pure — it takes evidence and returns proposals. */
export function runOpportunityAudit(inputs, { proposals = [] } = {}) {
  const audited = auditInputs(inputs);
  const ranked = prioritize(proposals);
  return {
    inventory: audited,
    opportunities: ranked,
    caveat:
      "Opportunities are proposals, not measurements. Every benefit shown carries its assumptions; " +
      "an opportunity with no assumptions has no benefit number, deliberately. Workflows were " +
      "selected by a person — none were inferred from installed software.",
  };
}
