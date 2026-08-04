#!/usr/bin/env node
// oc-api-probe.mjs
//
// Reference driver for the OpenCode `serve` v2 REST API (opencode 1.18.7).
// Drives a REAL agent run end-to-end over plain HTTP + SSE -- no `opencode run` CLI
// is invoked anywhere in this script.
//
// What it proves, with hard assertions (not just exit code 0):
//   1. starts a real `opencode serve` server in a scratch workspace
//   2. creates a session pinned to that workspace (via the session-create `location` field)
//   3. subscribes to the session's SSE event stream BEFORE sending any prompt
//   4. selects an explicit model with the CORRECT `/model` payload (see docs/OPENCODE_SERVER_API.md
//      "What returns 400 and why" -- the trap is `model.modelID`, the schema wants `model.id`)
//   5. sends a prompt that requires a file write, and detects real completion by watching for a
//      `session.next.step.ended` event with `data.finish === "stop"` (POST /wait was found to be
//      unusable for this session type -- see docs; we still call it, non-blocking, purely to record
//      its behaviour on every run)
//   6. reads the file back off disk and asserts its exact expected content -- fails loudly, non-zero
//      exit, if the file is missing or wrong
//   7. reports REAL token accounting pulled from GET /api/session/{id}/message (GET /api/session/{id}
//      itself was observed to stay pinned at all-zero tokens for this session; see docs)
//   8. shuts the server down cleanly on both the success and the failure path
//
// Zero dependencies. Node >= 18 (built-in fetch / ReadableStream). Plain ESM.
//
// Usage:
//   node tools/oc-api-probe.mjs
//
// Env overrides:
//   OPENCODE_BIN            path to the opencode binary (default: ~/.opencode/bin/opencode)
//   OC_PROBE_PROVIDER_ID    provider id to select          (default: brainoutput-local)
//   OC_PROBE_MODEL_ID       model id to select             (default: coder)
//   OC_PROBE_KEEP_SCRATCH   if "1", do not delete the scratch dir on exit (debugging aid)

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENCODE_BIN = process.env.OPENCODE_BIN || path.join(homedir(), '.opencode/bin/opencode');
const HOST = '127.0.0.1';
const PORT = 20000 + crypto.randomInt(0, 40000); // random high port, avoid hardcoding
const SCRATCH = path.join(tmpdir(), `oc-api-probe-${crypto.randomBytes(6).toString('hex')}`);
const BASE = `http://${HOST}:${PORT}`;

// Established fact (do not re-derive): the "kimi-for-coding" provider is authenticated
// (opencode auth login) and IS visible via `opencode models` / the legacy /provider endpoint,
// but it is ABSENT from the v2 /api/provider and /api/model catalogs, and a run against it
// gets durably admitted (session.next.prompted fires) and then simply never progresses --
// no error event, no tool call, ever (verified by waiting 5+ minutes). See docs, section
// "What returns 400 and why" / "kimi-for-coding is invisible to v2". We therefore default the
// probe to a provider that IS present in /api/model and that we have proven actually executes:
// the locally-routed "brainoutput-local/coder" model. Override via env if your machine differs.
const MODEL = {
  providerID: process.env.OC_PROBE_PROVIDER_ID || 'brainoutput-local',
  id: process.env.OC_PROBE_MODEL_ID || 'coder',
};

const HEALTH_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;
const OUTPUT_FILENAME = 'probe-output.txt';
const MARKER = `oc-api-probe-${crypto.randomBytes(8).toString('hex')}`;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const t0 = Date.now();
function log(...args) {
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...args);
}
function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// IMPORTANT (discovered the hard way during this spike): Node's built-in fetch (undici) has
// NO default timeout. A single request that hangs -- e.g. the very first health-check attempt
// racing the server's listen socket before it is actually servicing requests -- blocks forever
// with no error, no rejection, nothing. That silently wedges any naive retry loop. Every
// non-streaming request below therefore carries an explicit AbortSignal.timeout().
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

async function api(method, urlPath, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProc = null;
let cleanedUp = false;

function startServer() {
  log(`spawning: ${OPENCODE_BIN} serve --port ${PORT} --hostname ${HOST}`);
  log(`scratch workspace: ${SCRATCH}`);

  mkdirSync(SCRATCH, { recursive: true });

  // Trap #1 (established fact): a headless run auto-rejects any permission that would
  // resolve to "ask" and exits having done nothing. This file is required.
  writeFileSync(
    path.join(SCRATCH, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        permission: {
          edit: 'allow',
          write: 'allow',
          bash: 'allow',
          webfetch: 'deny',
          external_directory: 'allow',
        },
      },
      null,
      2,
    ),
  );

  // Trap #2 (established fact): spawn(cmd, {cwd}) does NOT update inherited PWD, and opencode
  // resolves the project root from $PWD. Set it explicitly. We ALSO pin the session's working
  // directory explicitly via the session-create `location.directory` field (discovered during
  // this spike, see docs) -- belt and suspenders, so the workspace is correct even if some code
  // path inside opencode falls back to PWD instead of the session location.
  const child = spawn(OPENCODE_BIN, ['serve', '--port', String(PORT), '--hostname', HOST], {
    cwd: SCRATCH,
    env: { ...process.env, PWD: SCRATCH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  child.on('error', (err) => {
    log('server process error:', err.message);
  });

  serverProc = child;
  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (serverProc && serverProc.exitCode !== null) {
      fail(`server process exited early (code ${serverProc.exitCode}) before becoming healthy`);
    }
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.healthy === true) {
          log('server healthy:', j);
          return;
        }
      }
    } catch {
      // not up yet, or this single attempt timed out/hung -- retry
    }
    if (Date.now() > deadline) {
      fail(`server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
    }
    await sleep(150);
  }
}

async function shutdownServer() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (serverProc && serverProc.exitCode === null) {
    log('shutting down server (SIGTERM)...');
    serverProc.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((r) => serverProc.once('exit', () => r(true))),
      sleep(4000).then(() => false),
    ]);
    if (!exited) {
      log('server did not exit after SIGTERM, sending SIGKILL');
      serverProc.kill('SIGKILL');
      await new Promise((r) => serverProc.once('exit', () => r()));
    }
    log('server stopped.');
  }
  if (process.env.OC_PROBE_KEEP_SCRATCH === '1') {
    log(`OC_PROBE_KEEP_SCRATCH=1, leaving scratch dir at ${SCRATCH}`);
  } else if (existsSync(SCRATCH)) {
    rmSync(SCRATCH, { recursive: true, force: true });
    log('scratch dir removed.');
  }
}

// ---------------------------------------------------------------------------
// SSE event subscription
// ---------------------------------------------------------------------------

// Subscribes to GET /api/session/{sessionID}/event and invokes onEvent(evt) for every
// parsed `data: {...}` frame. Frames on this stream carry the full durable event object
// directly in the `data:` line (id / type / durable / location / data) -- there is no
// separate SSE `event:` field on the wire in this build, despite the OpenAPI schema
// describing one. Lines starting with ":" are SSE comments (heartbeats) and are ignored.
function subscribeEvents(sessionID, onEvent) {
  const controller = new AbortController();
  let firstByteResolve;
  const firstByte = new Promise((r) => {
    firstByteResolve = r;
  });

  const streamPromise = (async () => {
    const res = await fetch(`${BASE}/api/session/${sessionID}/event`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      throw new Error(`event subscription failed: HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteResolve) {
          firstByteResolve();
          firstByteResolve = null;
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line || line.startsWith(':')) continue; // blank / heartbeat comment
            if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                onEvent(JSON.parse(payload));
              } catch (e) {
                log('warn: failed to parse SSE data frame:', e.message);
              }
            }
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // expected on shutdown
      throw err;
    }
  })();

  return {
    ready: firstByte,
    stop: () => controller.abort(),
    done: streamPromise,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  startServer();
  await waitForHealth();

  // --- create session, pinned explicitly to the scratch workspace -------------------------
  log('POST /api/session ...');
  const created = await api('POST', '/api/session', { location: { directory: SCRATCH } });
  if (!created.ok || !created.json?.data?.id) {
    fail(`session creation failed: HTTP ${created.status} ${created.text}`);
  }
  const sessionID = created.json.data.id;
  log('session created:', sessionID, 'location:', created.json.data.location);
  if (created.json.data.location?.directory !== SCRATCH) {
    fail(
      `session location mismatch: expected ${SCRATCH}, got ${created.json.data.location?.directory}`,
    );
  }

  // --- verify the model we intend to select is actually present in the v2 catalog ---------
  // Observed during this spike: on a completely fresh scratch workspace, GET /api/model can
  // return an EMPTY data array for the first moment or two after /api/health already reports
  // healthy -- the provider/model catalog warms up asynchronously. Poll briefly rather than
  // failing on the very first (possibly still-cold) response.
  const MODEL_CATALOG_TIMEOUT_MS = 10_000;
  const catalogDeadline = Date.now() + MODEL_CATALOG_TIMEOUT_MS;
  let modelList;
  let found;
  for (;;) {
    modelList = await api('GET', '/api/model');
    found = modelList.json?.data?.find(
      (m) => m.providerID === MODEL.providerID && m.id === MODEL.id,
    );
    if (found || Date.now() > catalogDeadline) break;
    await sleep(300);
  }
  if (!found) {
    fail(
      `model ${MODEL.providerID}/${MODEL.id} is not present in GET /api/model after ` +
        `${MODEL_CATALOG_TIMEOUT_MS}ms. ` +
        `Available: ${modelList.json?.data?.map((m) => `${m.providerID}/${m.id}`).join(', ')}`,
    );
  }
  log(`confirmed ${MODEL.providerID}/${MODEL.id} is present in /api/model`);

  // --- subscribe to the event stream BEFORE prompting --------------------------------------
  const observedEventTypes = [];
  let terminalStepSeen = false;
  const sub = subscribeEvents(sessionID, (evt) => {
    observedEventTypes.push(evt.type);
    log('event:', evt.type);
    if (evt.type === 'session.next.step.ended' && evt.data?.finish === 'stop') {
      terminalStepSeen = true;
    }
  });
  await Promise.race([sub.ready, sleep(1500)]);
  log('event subscription established (or 1500ms elapsed without a byte -- proceeding anyway)');

  // --- select model: THE PAYLOAD TRAP -------------------------------------------------------
  // Wrong (what a naive reading of "providerID"/"modelID" suggests -- both return HTTP 400):
  //   {"providerID":"...","modelID":"..."}                    -> 400 Missing key at ["model"]
  //   {"model":{"providerID":"...","modelID":"..."}}          -> 400 (modelID is not a schema
  //                                                                 property; "id" is required
  //                                                                 and additionalProperties:false)
  // Correct, per GET /doc -> #/components/schemas/ModelRef (required: id, providerID):
  //   {"model":{"id":"<modelID>","providerID":"<providerID>"}}
  log('POST /api/session/{id}/model with the CORRECT payload ...');
  const modelSwitch = await api('POST', `/api/session/${sessionID}/model`, {
    model: { id: MODEL.id, providerID: MODEL.providerID },
  });
  if (modelSwitch.status !== 204) {
    fail(`model switch failed: HTTP ${modelSwitch.status} ${modelSwitch.text}`);
  }
  log(`model switched to ${MODEL.providerID}/${MODEL.id} (204 No Content)`);

  // --- send the prompt -----------------------------------------------------------------------
  const promptText =
    `Create a file named ${OUTPUT_FILENAME} in the current directory containing exactly ` +
    `this single line and nothing else:\n${MARKER}\n` +
    `Use the write tool directly. Do not ask for confirmation, do not explain, just create the file.`;
  log('POST /api/session/{id}/prompt ...');
  const prompted = await api('POST', `/api/session/${sessionID}/prompt`, {
    prompt: { text: promptText },
    delivery: 'queue',
  });
  if (!prompted.ok) {
    fail(`prompt failed: HTTP ${prompted.status} ${prompted.text}`);
  }
  log('prompt admitted:', prompted.json.data.id, 'admittedSeq:', prompted.json.data.admittedSeq);

  // --- POST /wait: call it and RECORD what it does, but do not depend on it ------------------
  // Established + reconfirmed during this spike: this endpoint reliably returns
  // 503 {"_tag":"ServiceUnavailableError","message":"Session wait is not available yet",...}
  // for sessions created and driven purely through this v2 flow -- including well AFTER the
  // run has actually finished (file on disk, session.next.step.ended{finish:"stop"} already
  // observed on the event stream). We never saw it return 204. Treat it as informational only.
  const waitAttempt1 = await api('POST', `/api/session/${sessionID}/wait`);
  log(`POST /wait (immediately after prompting) -> HTTP ${waitAttempt1.status} ${waitAttempt1.text}`);

  // --- real completion detection: watch the event stream for the terminal step -------------
  log('waiting for session.next.step.ended{finish:"stop"} on the event stream ...');
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!terminalStepSeen) {
    if (Date.now() > deadline) {
      fail(
        `timed out after ${RUN_TIMEOUT_MS}ms waiting for run completion. ` +
          `Events observed so far: ${observedEventTypes.join(', ') || '(none)'}`,
      );
    }
    await sleep(200);
  }
  log('terminal step observed (finish=stop). run is complete.');

  const waitAttempt2 = await api('POST', `/api/session/${sessionID}/wait`);
  log(
    `POST /wait (after completion confirmed via events) -> HTTP ${waitAttempt2.status} ${waitAttempt2.text}`,
  );

  sub.stop();

  // --- assert the file is REALLY on disk with the REAL expected content --------------------
  const outPath = path.join(SCRATCH, OUTPUT_FILENAME);
  if (!existsSync(outPath)) {
    fail(`expected output file does not exist: ${outPath}`);
  }
  const actual = readFileSync(outPath, 'utf8').trim();
  if (actual !== MARKER) {
    fail(`file content mismatch. expected "${MARKER}", got "${actual}"`);
  }
  log(`ASSERTED: ${outPath} exists and contains the exact expected marker.`);

  // --- real token accounting -----------------------------------------------------------------
  // GET /api/session/{id} was observed to stay pinned at {input:0,output:0,...} for the whole
  // run in this build -- it is NOT a reliable source of token accounting here. The authoritative
  // numbers come from GET /api/session/{id}/message: every assistant message/step carries its
  // own real `tokens` object. We sum them for the full turn.
  const sessionAfter = await api('GET', `/api/session/${sessionID}`);
  const messages = await api('GET', `/api/session/${sessionID}/message`);
  const assistantMessages = (messages.json?.data || []).filter((m) => m.type === 'assistant');
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of assistantMessages) {
    totals.input += m.tokens?.input || 0;
    totals.output += m.tokens?.output || 0;
    totals.reasoning += m.tokens?.reasoning || 0;
    totals.cacheRead += m.tokens?.cache?.read || 0;
    totals.cacheWrite += m.tokens?.cache?.write || 0;
  }

  console.log('\n=== REAL token accounting ===');
  console.log(
    `GET /api/session/{id}.tokens          : ${JSON.stringify(sessionAfter.json?.data?.tokens)} ` +
      `(known-stale in this build, shown for comparison)`,
  );
  console.log(
    `Summed over ${assistantMessages.length} assistant message(s) from GET /api/session/{id}/message:`,
  );
  console.log(`  input tokens        : ${totals.input}`);
  console.log(`  output tokens       : ${totals.output}`);
  console.log(`  reasoning tokens    : ${totals.reasoning}`);
  console.log(`  cache read tokens   : ${totals.cacheRead}`);
  console.log(`  cache write tokens  : ${totals.cacheWrite}`);

  console.log('\n=== Observed event types, in arrival order ===');
  observedEventTypes.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  console.log('\nALL ASSERTIONS PASSED.');
}

// ---------------------------------------------------------------------------
// Entry point: guarantee clean shutdown on both success and failure
// ---------------------------------------------------------------------------

process.on('SIGINT', async () => {
  log('SIGINT received, cleaning up...');
  await shutdownServer();
  process.exit(1);
});

try {
  await main();
} catch (err) {
  console.error('\nPROBE FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = process.exitCode || 1;
} finally {
  await shutdownServer();
}

process.exit(process.exitCode || 0);
