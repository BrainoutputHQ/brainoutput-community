#!/usr/bin/env node --test
// SPDX-License-Identifier: Apache-2.0
// task-pm-18: the OpenCode coding runtime is BUNDLED in the Docker image — pinned to an exact
// version, executed at build time so the build fails loudly if the binary cannot run on the base
// image, wired into the adapter's detection order (BO_OPENCODE_BIN first), with hardening intact
// (non-root bo, /data ownership, no test files). /api/state carries an honest per-process status
// (absent when missing OR unrunnable) and the settings/models card renders both states, esc()'d,
// in en/fr/de.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { SHELL_PAGE } from "./shell.mjs";
import { CATALOG, LOCALES, missingKeys } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = readFileSync(join(HERE, "Dockerfile"), "utf8");
const ADAPTER_SRC = readFileSync(join(HERE, "opencode-adapter.mjs"), "utf8");   // READ ONLY — source pins only

// Ports not used by any other test file (the full suite runs files concurrently).
const PORT_ABSENT = 4471, PORT_PRESENT = 4472, PORT_BROKEN = 4473;

let stubDir, stubOk, stubBroken;
const servers = [];

async function startServer(port, extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), "bo-runtimeimg-"));
  const srv = spawn(process.execPath, [join(HERE, "web-server.mjs")],
    { env: { ...process.env, BO_CE_DATA: dir, BO_CE_WEB_PORT: String(port), ...extraEnv }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/api/state`); servers.push({ srv, dir }); return base; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`server on :${port} did not start`);
}

let BASE_ABSENT, BASE_PRESENT, BASE_BROKEN;
before(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "bo-ocstub-"));
  stubOk = join(stubDir, "opencode-ok");
  writeFileSync(stubOk, "#!/bin/sh\necho 9.9.9\n");
  chmodSync(stubOk, 0o755);
  stubBroken = join(stubDir, "opencode-broken");
  writeFileSync(stubBroken, "#!/bin/sh\nexit 1\n");   // exists, but CANNOT run → must report absent
  chmodSync(stubBroken, 0o755);
  // Sequential boots: three concurrent node startups would spike CPU and starve the timing-
  // sensitive perf tests the full suite runs in parallel.
  BASE_ABSENT = await startServer(PORT_ABSENT, { BO_OPENCODE_BIN: "/nonexistent-opencode" });
  BASE_PRESENT = await startServer(PORT_PRESENT, { BO_OPENCODE_BIN: stubOk });
  BASE_BROKEN = await startServer(PORT_BROKEN, { BO_OPENCODE_BIN: stubBroken });
});
after(() => {
  for (const s of servers) { s.srv?.kill(); rmSync(s.dir, { recursive: true, force: true }); }
  rmSync(stubDir, { recursive: true, force: true });
});

const state = (base) => fetch(`${base}/api/state`).then((r) => r.json());

// ── 1 · the Dockerfile: pinned, build-verified, hardened ─────────────────────
test("Dockerfile: the OpenCode runtime is PINNED to an exact version — never latest-drift", () => {
  const pin = DOCKERFILE.match(/ARG OPENCODE_VERSION=(\d+\.\d+\.\d+)/);
  assert.ok(pin, "an ARG pins an exact semver");
  assert.ok(DOCKERFILE.includes('opencode-ai@${OPENCODE_VERSION}'), "the install consumes the pinned ARG");
  assert.ok(!/opencode-ai@latest/.test(DOCKERFILE), "no latest tag anywhere");
  assert.ok(!/npm install(-g| --global)? +opencode-ai[\s\n]/.test(DOCKERFILE), "no unpinned install");
  assert.match(DOCKERFILE, /npm install -g "opencode-ai@/, "installed via pinned npm global package");
});

test("Dockerfile: the build EXECUTES the binary — as root AND as bo — so a bad base fails loudly", () => {
  assert.match(DOCKERFILE, /opencode --version/, "a build-time execution check exists");
  assert.match(DOCKERFILE, /su .* bo .*opencode --version/, "the bo user (the runtime USER) is checked too");
  const iRun = DOCKERFILE.indexOf("opencode --version");
  const iUser = DOCKERFILE.search(/^USER bo$/m);
  assert.ok(iRun > 0 && iUser > iRun, "the check runs at BUILD time, before the final USER directive lands");
});

test("Dockerfile: BO_OPENCODE_BIN matches the adapter's search order; hardening is preserved", () => {
  // The adapter resolves BO_OPENCODE_BIN FIRST, then ~/.opencode/bin/opencode (source pin — the
  // parallel session owns this file; we only READ it).
  assert.ok(ADAPTER_SRC.includes("process.env.BO_OPENCODE_BIN ||"), "adapter: env override is the first search path");
  assert.ok(ADAPTER_SRC.includes('".opencode", "bin", "opencode"'), "adapter: the default path is ~/.opencode/bin/opencode");
  const env = DOCKERFILE.match(/^ENV BO_OPENCODE_BIN=(\S+)$/m);
  assert.ok(env, "the image declares BO_OPENCODE_BIN (npm-global bin → deterministic path)");
  assert.equal(env[1], "/usr/local/bin/opencode", "the official node image's npm-global prefix");
  // Hardening, unchanged:
  assert.match(DOCKERFILE, /adduser .* bo/, "the non-root user is still created");
  assert.match(DOCKERFILE, /^USER bo$/m, "the container still runs as non-root bo");
  assert.match(DOCKERFILE, /chown bo:bo \/data/, "/data is still owned by bo (volume seeding)");
  assert.match(DOCKERFILE, /VOLUME \["\/data"\]/, "the data volume survives");
  assert.match(DOCKERFILE, /rm -rf [^\n]*\*\.test\.mjs/, "test files are still never shipped");
  assert.ok(!/EXPOSE \d+ /.test(DOCKERFILE) && (DOCKERFILE.match(/EXPOSE /g) || []).length === 1, "still exactly one exposed port — no extra daemons");
  assert.match(DOCKERFILE, /ENV BO_CE_DATA=\/data BO_CE_WEB_PORT=4177 BO_CE_WEB_HOST=0\.0\.0\.0/, "BO_CE_* env unchanged");
});

// ── 2 · detection: the override the image relies on ──────────────────────────
test("detection: BO_OPENCODE_BIN is honored (fresh process, like the container boot)", () => {
  const code = `import { opencodeAvailable } from ${JSON.stringify(pathToFileURL(join(HERE, "opencode-adapter.mjs")).href)}; process.stdout.write(String(opencodeAvailable()));`;
  const yes = execFileSync(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...process.env, BO_OPENCODE_BIN: stubOk }, encoding: "utf8" });
  assert.equal(yes, "true", "an existing override binary is detected");
  const no = execFileSync(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...process.env, BO_OPENCODE_BIN: "/nonexistent-opencode" }, encoding: "utf8" });
  assert.equal(no, "false", "a missing binary reports absent — fallback behavior unchanged");
});

// ── 3 · /api/state carries the runtime status — honest in both directions ────
test("/api/state: binary absent → codingRuntime reports ABSENT (honest, never fabricated)", async () => {
  const s = await state(BASE_ABSENT);
  assert.deepEqual(s.codingRuntime, { available: false, version: null });
});

test("/api/state: binary present → codingRuntime carries the real probed version", async () => {
  const s = await state(BASE_PRESENT);
  assert.deepEqual(s.codingRuntime, { available: true, version: "9.9.9" });
});

test("/api/state: a binary that CANNOT RUN (--version fails) reports absent honestly", async () => {
  const s = await state(BASE_BROKEN);
  assert.deepEqual(s.codingRuntime, { available: false, version: null });
});

// ── 4 · the settings/models card line: both states, escaped, i18n parity ─────
const RL_START = SHELL_PAGE.indexOf("// ── coding runtime status (task-pm-18)");
const RL_END = SHELL_PAGE.indexOf("// ── settings:", RL_START);
assert.ok(RL_START > 0 && RL_END > RL_START, "the runtime-status block lives in the shell");
const RL_BLOCK = SHELL_PAGE.slice(RL_START, RL_END);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function renderLine(rt, locale = "en") {
  const sandbox = { t: (k) => CATALOG[locale][k] || CATALOG.en[k] || k, esc };
  vm.createContext(sandbox);
  vm.runInContext(RL_BLOCK + "\n;globalThis.__line=runtimeStatusLine;", sandbox);
  return sandbox.__line(rt);
}

test("settings line: present renders name + version; absent renders the honest note + install hint", () => {
  const ok = renderLine({ available: true, version: "1.18.11" });
  assert.ok(ok.includes("OpenCode runtime · v1.18.11"), "present: 'OpenCode runtime · vX.Y.Z'");
  assert.ok(ok.includes("✓"), "present: a positive mark");
  const absent = renderLine({ available: false, version: null });
  assert.ok(absent.includes(CATALOG.en["models.runtime.absent"]), "absent: the honest note");
  assert.ok(absent.includes(CATALOG.en["models.runtime.installHint"]), "absent: how to get one");
  // A missing/garbage field degrades to the absent branch — never a crash, never a fabrication.
  assert.ok(renderLine(undefined).includes(CATALOG.en["models.runtime.absent"]));
  assert.ok(renderLine({}).includes(CATALOG.en["models.runtime.absent"]));
  // settingsView actually wires the line to /api/state's codingRuntime (source pin).
  assert.ok(SHELL_PAGE.includes("runtimeStatusLine(s.codingRuntime)"), "the models card renders the state field");
});

test("settings line: a hostile version string can never inject markup (esc()'d)", () => {
  const EVIL = '</span><img src=x onerror=alert(1)>';
  const out = renderLine({ available: true, version: EVIL });
  assert.ok(!out.includes(EVIL), "no raw payload");
  assert.ok(out.includes(esc(EVIL)), "the payload shows as escaped text");
});

test("settings line: fr/de render for real; catalogs stay at parity; the page parses", () => {
  const KEYS = ["models.runtime.present", "models.runtime.absent", "models.runtime.installHint"];
  for (const loc of LOCALES) for (const k of KEYS) {
    assert.ok(CATALOG[loc][k] && CATALOG[loc][k] !== k, `${loc}:${k} has a real translation`);
  }
  for (const loc of LOCALES) assert.deepEqual(missingKeys(loc), [], `${loc} is missing keys`);
  for (const loc of ["fr", "de"]) {
    assert.ok(renderLine({ available: true, version: "1.18.11" }, loc)
      .includes(CATALOG[loc]["models.runtime.present"].replace("{version}", "1.18.11")), `${loc}: present localizes`);
    assert.ok(renderLine({ available: false }, loc).includes(CATALOG[loc]["models.runtime.absent"]), `${loc}: absent localizes`);
    assert.ok(renderLine({ available: false }, loc).includes(CATALOG[loc]["models.runtime.installHint"]), `${loc}: hint localizes`);
  }
  // Parse guard — a template-literal slip can never blank the page.
  const page = SHELL_PAGE.replace("__BO_I18N__", "{}").replaceAll("__BO_LOCALE__", "en").replace("__BO_CSRF__", "x");
  const js = page.split("<script>")[1].split("</scr" + "ipt>")[0];
  new vm.Script(js);
});
