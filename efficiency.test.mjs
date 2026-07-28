// SPDX-License-Identifier: Apache-2.0
// Item 8 — efficiency report shows MEASURED values only (no fabricated savings). Minimal by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { efficiencyReport } from "./efficiency.mjs";

test("report derives measured fields; skips absent optional stages; shows no savings figure", () => {
  const rep = efficiencyReport({
    shape: "single",
    plan: [{ node: "worker" }],
    results: [{ node: "worker", model: "qwen2.5:7b", provider: "ollama", costSource: "local-compute", tokens: 120 }],
  });
  assert.equal(rep.graph, "single");
  assert.deepEqual(rep.stagesSkipped.sort(), ["human-approval", "planner", "reviewer"]); // none present → all skipped
  assert.equal(rep.tokensTotal, 120);
  assert.deepEqual(rep.byCostSource, { "local-compute": 120 });
  assert.equal(rep.managementCalls, 0);
  assert.equal(rep.directToWorker, true);
  // measured-only: no estimated monetary/energy savings on the report
  assert.equal("savings" in rep, false);
  assert.equal("energy" in rep, false);
});

test("deterministic + gate stages are reflected without inventing tokens", () => {
  const rep = efficiencyReport({
    shape: "agent-approval-action",
    plan: [{ node: "tool" }, { node: "human-approval", gate: true }],
    results: [{ node: "tool", deterministic: true, artifact: "tool:reconcile" }, { node: "human-approval", gate: true }],
  });
  assert.deepEqual(rep.deterministicStages, ["tool"]);
  assert.equal(rep.tokensTotal, 0);
  assert.ok(rep.artifacts.includes("tool:reconcile"));
  assert.ok(!rep.stagesSkipped.includes("human-approval")); // it WAS used
});
