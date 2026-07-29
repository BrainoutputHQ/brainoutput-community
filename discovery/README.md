# BrainOutput Discovery & Diagnostics

Read-only discovery and diagnosis of the machine you run it on and a network **you explicitly
approve**. No dependencies, no account, no data leaves the machine unless you say so.

## Requirements

Node ≥ 18. That is all — this package has zero runtime dependencies.

## Install

```bash
git clone https://github.com/BrainoutputHQ/brainoutput-community.git
cd brainoutput-community
node discovery/run.mjs            # prints the five commands
```

## The five commands

```bash
# 1. See what WOULD happen. Nothing is touched without --yes.
node discovery/run.mjs discover --cidr 192.168.1.0/28

# 2. Do it. --active permits port probing; without it, passive collectors only.
node discovery/run.mjs discover --cidr 192.168.1.0/28 --active --yes

# 3. What was found, and how fresh the evidence is
node discovery/run.mjs inventory

# 4. Assets and dependencies
node discovery/run.mjs twin

# 5. Deterministic checks -> findings -> a remediation plan that is NEVER executed
node discovery/run.mjs diagnose --packs

# 6. AI opportunities, with the assumptions behind every number
node discovery/run.mjs opportunities
```

### Flags

| flag | meaning | default |
|---|---|---|
| `--cidr a,b` | networks you approve. **No default — nothing is scanned unless you name it.** | none |
| `--host h,i` | individual hosts you approve | none |
| `--active` | permit port probing | off (passive only) |
| `--intensity` | `gentle` or `standard` | `gentle` |
| `--mode` | `observe` or `act` | `observe` (read-only) |
| `--sync` | `local-only` · `status-and-findings` · `selected-evidence` · `full-authorized` | `local-only` |
| `--yes` | actually run; without it you only see the scope | off |
| `--packs` | show the diagnostic-pack support matrix | off |

Data lives in `~/.local/share/bo-community`. Override with `BO_CE_DATA=/path`.

## What it will not do

Refusals are enforced in code and covered by tests, not promised in a README:

- it will not touch anything outside an approved range — probes to unapproved targets are
  **refused and recorded**, never silently skipped;
- it will not probe a port that is not on the approved list;
- it will not exploit, brute-force, collect password hashes, modify a device, restart a service,
  or change DHCP/DNS/VLAN/AD/printer/PBX configuration — in **any** mode, including `act`;
- it will not run the runtime as root. Privileged collection is an allow-list of named read-only
  commands; without privilege you get **partial evidence with a reason**, never a silent gap;
- it will not put a credential in argv, a log, a model prompt or an export.

Every command it runs is printed before it runs and appended to a hash-chained audit record.

## Where the AI fits, and where it does not

Deterministic collectors gather evidence. Deterministic rules produce findings. **Only then** may a
model be asked to explain and correlate what was already found — and it is handed nothing but those
findings and the evidence they cite. If it references a finding that does not exist, that is
detected and its explanation is marked as carrying no authority. A model cannot create a finding,
cannot request more evidence, and cannot widen its own access.

Sensitive content never reaches a model. Internal topology is blocked from *external* inference
unless you approve it explicitly.

## Honest limits

- No live SNMP, CUPS or Windows print-queue transport yet — the checks and shapes exist, the real
  collectors do not. No live printer has been diagnosed.
- Windows collectors are written but unexercised on real Windows.
- Diagnostic packs (switches/VLAN/PoE, AD/Entra, IPBX/SIP, Wi-Fi, servers/backups, business apps,
  remote sites) are **interfaces only**. Each returns `unsupported`, `credentials-required` or
  `partial-evidence` — never a blank "ok", because a clean bill of health nobody checked is the
  most dangerous output a diagnostic can produce.
- Remote sites are deliberately not implemented: this CLI can only see networks it can reach, and
  claiming otherwise would be a fabricated result.
