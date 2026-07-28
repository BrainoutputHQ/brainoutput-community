#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — approved WRITE-action demo (item 7, 2026-07-28).
// Shows the full loop for a consequential action: refused without a grant → granted but held for a
// human → blocked without approval → executed only AFTER approval. A write never fires silently.
import { newConnector, grantScope } from "./connectors.mjs";
import { connectorAction, executeApprovedAction } from "./connector-adapters.mjs";

const line = (s = "") => console.log(s);
const agent = { id: "engineering-lead", department: "technical" };
const write = { action: "close-issue", resource: "repo:acme/site#42", payload: { comment: "Fixed in #57." }, agent };

(async () => {
  line("Approved write-action demo — Gitea (open source), READ-ONLY by default\n" + "=".repeat(60));

  // 1) No grant → the write is refused outright.
  let gitea = newConnector("gitea");
  const refused = await connectorAction(gitea, write);
  line(`1) write with no grant        → executed=${refused.executed} · ${refused.reason}`);

  // 2) Grant WRITE to this agent (separately granted). The action is now permitted but HELD for a human.
  gitea = grantScope(gitea, { scope: "write", principal: { level: "agent", id: agent.id }, resource: "repo:acme/site#42", action: "close-issue" });
  const planned = await connectorAction(gitea, write);
  line(`2) write with a grant         → executed=${planned.executed} · status=${planned.status} · needsApproval=${planned.requiresApproval}`);
  line(`     planned: ${JSON.stringify(planned.plannedAction)}`);

  // 3) Try to execute WITHOUT approval → blocked.
  const blocked = await executeApprovedAction(gitea, write, { status: "pending" });
  line(`3) execute without approval   → executed=${blocked.executed} · ${blocked.reason}`);

  // 4) A human approves → the write executes (and only now).
  const approval = { id: "appr-1", status: "approved", approvedBy: "founder" };
  const done = await executeApprovedAction(gitea, write, approval);
  line(`4) execute AFTER approval     → executed=${done.executed} · approvedBy=${done.approvedBy}`);
  line(`     result: ${JSON.stringify(done.result)}`);

  const ok = !refused.executed && !planned.executed && !blocked.executed && done.executed;
  line(`\n${ok ? "✓" : "✗"} A write required a separate grant AND a human approval — it never fired silently.`);
  process.exit(ok ? 0 : 1);
})();
