#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// brainoutput discover · inventory · diagnose · opportunities · twin
//
// The CLI is deliberately thin. It confirms scope, calls deterministic collectors, runs
// deterministic checks, and only then — optionally — asks a model to explain what was already
// found. Every command it runs is printed before it runs. Nothing changes anything.
import { createApproval, checkAllowed, describeApproval, INTENSITY, SYNC_MODES } from "./scope.mjs";
import { createAudit } from "./privileged.mjs";
import { collectHost } from "./collectors.mjs";
import { sweep } from "./netscan.mjs";
import { runAllChecks, remediationPlan } from "./diagnostics.mjs";
import { createTwin, ingest, inventory, topology, freshness, saveTwin, loadTwin } from "./twin.mjs";
import { explanationPayload, acceptExplanation } from "./firewall.mjs";
import { packMatrix } from "./packs.mjs";
import { runOpportunityAudit, toMission } from "./opportunities.mjs";

const H = (s) => `\n${s}\n${"─".repeat(s.length)}`;

/** Parse `--k v` and `--flag`. Nothing here reads a credential; secrets never come from argv. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}

/**
 * Build an approval from flags. Interactive confirmation happens in the shell wrapper; this
 * refuses to invent a scope — no flags means no approval, not "scan everything nearby".
 */
export function approvalFromArgs(args, { approvedBy = process.env.USER || "local-user", now = Date.now() } = {}) {
  const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  if (!args.cidr && !args.host)
    throw new Error("no scope given. Nothing is scanned by default — pass --cidr 192.168.1.0/28 and/or --host <name>");
  return createApproval({
    cidrs: list(args.cidr), hosts: list(args.host), accounts: list(args.account), collectors: list(args.collector),
    intensity: args.intensity || "gentle",
    mode: args.mode || "observe",
    sync: args.sync || "local-only",
    allowActive: !!args.active,
    approvedBy, at: now,
  });
}

/** `brainoutput discover` — confirm scope, collect host + network, store the twin. */
export async function cmdDiscover(args, deps) {
  const { store, exec, connect, now = Date.now(), out = console.log } = deps;
  const approval = approvalFromArgs(args, { now });
  const audit = createAudit();

  out(H("Scope you are approving"));
  out(describeApproval(approval));
  if (!args.yes) { out("\nRe-run with --yes to proceed. Nothing has been touched."); return { confirmed: false, approval }; }

  audit.record({ at: now, kind: "run", command: `discover ${JSON.stringify({ cidrs: approval.cidrs, hosts: approval.hosts, mode: approval.mode })}` });

  out(H("Host collectors (deterministic)"));
  const host = await collectHost({ exec, approval, now, audit: audit.record, privileged: false });
  for (const s of host.skipped || []) out(`  ○ ${s.name}: ${s.reason}`);
  out(`  ${host.observations.length} observations, ${(host.skipped || []).length} partial/skipped`);

  let net = { observations: [], refused: [] };
  if (approval.cidrs.length && approval.allowActive) {
    out(H("Network sweep (active — approved ranges only)"));
    net = await sweep({ approval, cidrs: approval.cidrs, connect, now });
    out(`  ${net.observations.length} observations · ${net.refused.length} probes refused as out-of-scope`);
  } else if (approval.cidrs.length) {
    out(H("Network sweep")); out("  skipped: active probing was not approved (add --active)");
  }

  const twin = ingest(loadTwin(store) || createTwin({ site: args.site || "local", at: now }),
                      [...host.observations, ...net.observations], { now });
  saveTwin(store, twin);
  out(`\nInfrastructure Twin saved: ${twin.assets.length} assets, ${twin.observations.length} observations.`);
  return { confirmed: true, approval, twin, audit: audit.all() };
}

/** `brainoutput inventory` — what we know, and how fresh it is. */
export function cmdInventory(args, { store, now = Date.now(), out = console.log }) {
  const twin = loadTwin(store);
  if (!twin) { out("No twin yet. Run `brainoutput discover --cidr <range> --yes` first."); return null; }
  const f = freshness(twin, { now });
  out(H(`Inventory — ${twin.assets.length} assets`));
  // inventory() returns a formatted table; print it, do not iterate it (a string iterates by
  // character, which is how this first rendered one letter per line).
  for (const line of String(inventory(twin)).split("\n")) out("  " + line);
  out(`\nEvidence: ${f.fresh} fresh, ${f.stale} STALE (stale evidence is shown as stale, never as current).`);
  return twin;
}

/** `brainoutput twin` — assets, dependencies, freshness. */
export function cmdTwin(args, { store, now = Date.now(), out = console.log }) {
  const twin = loadTwin(store);
  if (!twin) { out("No twin yet."); return null; }
  const t = topology(twin);
  out(H("Topology"));
  for (const n of t.nodes) out(`  ${n.id}  ${n.kind}${n.uncertain ? "  ⚠ " + n.uncertain : ""}`);
  out(H("Dependencies"));
  for (const e of t.edges) out(`  ${e.from} → ${e.to}  (${e.kind})`);
  return t;
}

/**
 * `brainoutput diagnose` — deterministic checks first, then OPTIONALLY a model that explains what
 * the checks already found. The model cannot add a finding; acceptExplanation() drops it if it tries.
 */
export async function cmdDiagnose(args, { store, explain = null, destination = "local", now = Date.now(), out = console.log }) {
  const twin = loadTwin(store);
  if (!twin) { out("No twin yet. Run `brainoutput discover` first."); return null; }

  const findings = runAllChecks(twin.observations);
  out(H(`Findings — ${findings.length}`));
  for (const f of findings) {
    out(`  [${f.severity}] ${f.title}   confidence ${f.confidence}`);
    out(`     evidence: ${f.evidence.join(", ")}`);
    out(`     could also be: ${f.alternativeCauses.join(" · ")}`);
    out(`     verify next: ${f.nextVerification}`);
  }
  if (args.packs) { out(H("Diagnostic packs")); for (const p of packMatrix()) out(`  ${p.pack.padEnd(24)} ${p.implemented ? "implemented" : "interface only"} — needs: ${p.needs[0]}`); }

  const plan = remediationPlan(findings);
  out(H("Remediation plan (nothing is executed)"));
  for (const s of plan) out(`  ${s.order}. ${s.action}   [approval required: ${s.requiresApproval}]`);

  let explanation = null;
  if (explain && findings.length) {
    const payload = explanationPayload({ findings, observations: twin.observations, destination });
    if (!payload.allowed) out(`\nModel explanation blocked: ${payload.reason}`);
    else {
      const raw = await explain(`${payload.instruction}\n\n${payload.text}`);
      explanation = acceptExplanation({ findings, explanation: raw });
      out(H("Model explanation (advisory — the checks above are authoritative)"));
      out("  " + explanation.text.split("\n").join("\n  "));
      if (!explanation.trustworthy) out(`\n  ⚠ ${explanation.note}`);
    }
  }
  return { findings, plan, explanation };
}

/** `brainoutput opportunities` — proposals with visible assumptions, and one editable mission. */
export function cmdOpportunities(args, { store, inputs = {}, proposals = [], now = Date.now(), out = console.log }) {
  const audit = runOpportunityAudit(inputs, { proposals });
  out(H(`AI opportunities — ${audit.opportunities.length}`));
  for (const o of audit.opportunities) {
    out(`  #${o.rank} ${o.title}   (confidence ${o.confidence}, testability ${o.testability})`);
    out(`     agent: ${o.proposedAgent} · tools: ${o.tools.join(", ") || "none"} · permissions: ${o.permissions.join(", ") || "none"}`);
    out(`     pilot: ${o.pilot}`);
    out(`     risks: ${o.risks.join(" · ")}`);
    if (o.benefit) for (const line of (`${o.benefit.metric}: ~${o.benefit.value} ${o.benefit.unit}\nbasis: ${o.benefit.basis}\n` + o.benefit.assumptions.map((a) => `assumes: ${a}`).join("\n")).split("\n")) out(`     ${line}`);
    else out(`     benefit: not estimated — no assumptions were available to base one on`);
  }
  out(`\n${audit.caveat}`);
  const mission = audit.opportunities.length ? toMission(audit.opportunities[0], { at: now }) : null;
  if (mission) {
    store.runtime.missions = [...(store.runtime.missions || []), mission];
    store.saveRuntime();
    out(`\nDraft mission created: ${mission.id} — editable, nothing granted, nothing scheduled.`);
  }
  return { audit, mission };
}

export const COMMANDS = { discover: cmdDiscover, inventory: cmdInventory, diagnose: cmdDiagnose, opportunities: cmdOpportunities, twin: cmdTwin };
