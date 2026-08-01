// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — per-execution efficiency report (item 8, 2026-07-28).
// Shows ONLY what the execution actually produced — graph chosen, stages invoked/skipped, model &
// cost source per stage, tokens where available, deterministic verification, artifacts, duration.
// It does NOT display estimated monetary or energy "savings": those are not measured, so they are not
// shown (founder). Pure — never mutates the results.

const OPTIONAL_STAGES = ["planner", "reviewer", "human-approval"];
const stem = (n) => String(n).replace(/\d+$/, "");

export function efficiencyReport({ plan = [], results = [], shape = null, durationMs = null } = {}) {
  const present = new Set([...plan.map((n) => stem(n.node)), ...results.map((r) => stem(r.node))]);
  const stagesSkipped = OPTIONAL_STAGES.filter((s) => ![...present].some((p) => p.startsWith(s)));

  const perStage = results.map((r) => ({
    node: r.node,
    model: r.model || null,
    provider: r.provider || null,
    costSource: r.costSource || (r.gate ? "human-approval" : r.deterministic ? "deterministic-tool" : null),
    tokens: r.tokens || 0,
    tokenScope: r.tokenScope || (r.tokens ? "total" : "unknown"),   // what the provider actually measured
    deterministic: !!r.deterministic,
    artifact: r.artifact || (Array.isArray(r.changedFiles) && r.changedFiles.length ? r.changedFiles.join(", ") : null),
  }));

  const byCostSource = {};
  for (const p of perStage) if (p.costSource) byCostSource[p.costSource] = (byCostSource[p.costSource] || 0) + p.tokens;

  const managementCalls = results.filter((r) => /ceo|manager|management|relay/i.test(String(r.node))).length;
  const artifacts = perStage.map((p) => p.artifact).filter(Boolean);
  // "total" only when every token-bearing stage reported full usage; a stage with output-only
  // accounting makes the sum partial — displaying it as a grand total would undercount silently.
  const measured = perStage.filter((p) => p.tokens > 0);
  const tokensScope = !measured.length ? "unknown"
    : measured.some((p) => p.tokenScope === "output-only") ? "partial" : "total";

  return {
    graph: shape,
    stagesInvoked: results.map((r) => r.node),
    stagesSkipped,                                    // measured: which optional stages the graph did NOT use
    perStage,
    tokensTotal: perStage.reduce((s, p) => s + p.tokens, 0),
    tokensScope,                                      // "total" | "partial" (output-only stages) | "unknown"
    byCostSource,
    managementCalls,                                  // factual: 0 in a direct-to-worker graph
    directToWorker: managementCalls === 0,
    deterministicStages: perStage.filter((p) => p.deterministic).map((p) => p.node), // ran as code, no tokens
    artifacts,
    durationMs,                                       // null when not timed
    // No monetary/energy savings figure — not measured, so not shown.
  };
}

/** One-line, values-only summary for a CLI/dashboard row (measured fields only). */
export function efficiencyLine(rep) {
  const skipped = rep.stagesSkipped.length ? `not used: ${rep.stagesSkipped.join(", ")}` : "all optional stages used";
  const tokens = rep.tokensScope === "partial" ? `~${rep.tokensTotal} (output-only)` : `${rep.tokensTotal}`;
  return `graph=${rep.graph} · ${skipped} · tokens=${tokens} · cost=${JSON.stringify(rep.byCostSource)} · management-calls=${rep.managementCalls}` +
    (rep.durationMs != null ? ` · ${rep.durationMs}ms` : "");
}
