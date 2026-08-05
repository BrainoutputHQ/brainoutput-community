#!/usr/bin/env node
// oc-ping.mjs — drive one OpenCode session end to end over the `serve` REST API:
// spawn serve on a free loopback port -> health -> create session -> select model ->
// prompt -> wait for completion via SSE -> report token usage -> shut down cleanly.
// Zero deps, Node >= 18 (built-in fetch), plain ESM. Usage: node tools/oc-ping.mjs
// Env: OPENCODE_BIN, OC_PING_PROVIDER_ID, OC_PING_MODEL_ID, OC_PING_PROMPT.
// Established facts reused from tools/oc-api-probe.mjs (docs/OPENCODE_SERVER_API.md):
//  - model-select payload must be {model:{id,providerID}} ("modelID" returns 400)
//  - POST /wait is unusable here; completion = SSE `session.next.step.ended` finish "stop"
//  - session.tokens stays zero; real accounting is summed from the message list
//  - Node fetch has no default timeout; every request needs AbortSignal.timeout
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const OPENCODE_BIN = process.env.OPENCODE_BIN || path.join(homedir(), '.opencode/bin/opencode');
const HOST = '127.0.0.1';
const PORT = 20000 + crypto.randomInt(0, 40000); // random high port, no hardcoding
const BASE = `http://${HOST}:${PORT}`;
const SCRATCH = path.join(tmpdir(), `oc-ping-${crypto.randomBytes(6).toString('hex')}`);
const PROVIDER_ID = process.env.OC_PING_PROVIDER_ID || 'brainoutput-local';
const MODEL_ID = process.env.OC_PING_MODEL_ID || 'coder';
const ENDPOINT = (process.env.OC_PING_ENDPOINT || 'http://192.168.1.14:9000/v1')
  .replace(/\/chat\/completions\/?$/, '');
const PROMPT = process.env.OC_PING_PROMPT || 'Reply with exactly: pong';
const HEALTH_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch {}
  return { status: res.status, ok: res.ok, json, text };
}
let serverProc = null;
function startServer() {
  mkdirSync(SCRATCH, { recursive: true });
  // Headless runs auto-reject any "ask" permission; this config file is required.
  // It ALSO defines the model provider — without this block the model is absent from
  // GET /api/model, POST .../model still returns 204, and the prompt wedges forever.
  const cfg = JSON.stringify({
    permission: { edit: 'allow', write: 'allow', bash: 'allow' },
    provider: {
      [PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Local model',
        options: { baseURL: ENDPOINT, apiKey: 'oc-ping-local' },
        models: { [MODEL_ID]: { name: MODEL_ID, limit: { context: 32768, output: 4096 } } },
      },
    },
  });
  writeFileSync(path.join(SCRATCH, 'opencode.json'), cfg);
  // spawn(cwd) does not update inherited PWD, which opencode uses for the project root.
  serverProc = spawn(OPENCODE_BIN, ['serve', '--port', String(PORT), '--hostname', HOST], {
    cwd: SCRATCH,
    env: { ...process.env, PWD: SCRATCH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(d));
  console.log(`serve pid ${serverProc.pid} on ${BASE}, workspace ${SCRATCH}`);
}
async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (serverProc.exitCode !== null) fail(`server exited early (code ${serverProc.exitCode})`);
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.json())?.healthy === true) return console.log('server healthy');
    } catch {} // not up yet — retry
    if (Date.now() > deadline) fail('server did not become healthy in time');
    await sleep(150);
  }
}
async function shutdown() {
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((r) => serverProc.once('exit', () => r(true))),
      sleep(4000).then(() => false),
    ]);
    if (!exited) serverProc.kill('SIGKILL'); // SIGTERM grace period exhausted
    console.log('server stopped');
  }
  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
}
async function main() {
  startServer();
  await waitForHealth();
  const created = await api('POST', '/api/session', { location: { directory: SCRATCH } });
  if (!created.ok || !created.json?.data?.id) fail(`session create: HTTP ${created.status} ${created.text}`);
  const sessionID = created.json.data.id;
  console.log('session:', sessionID);
  // SSE: ":" lines are heartbeats; each data: line carries the full event object
  // directly (no separate `event:` field on the wire in this build).
  let done = false;
  const sse = new AbortController();
  const streamDone = (async () => {
    const res = await fetch(`${BASE}/api/session/${sessionID}/event`, {
      signal: sse.signal, headers: { accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(`event stream: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let i;
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      while ((i = buf.indexOf('\n\n')) !== -1) {
        for (const line of buf.slice(0, i).split('\n')) {
          if (!line.startsWith('data:')) continue;
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.type === 'session.next.step.ended' && evt.data?.finish === 'stop') done = true;
        }
        buf = buf.slice(i + 2);
      }
    }
  })().catch((e) => {
    if (!sse.signal.aborted) fail(`event stream error: ${e.message}`);
  });

  // Fail-closed model gate: POST .../model returns 204 even for a model ABSENT from
  // GET /api/model, and prompting it then never progresses (no event, no error). Poll
  // the catalog (it warms up async for 1-3s after health) and refuse anything not in it.
  const catDeadline = Date.now() + 10_000;
  for (;;) {
    const catalog = (await api('GET', '/api/model')).json?.data || [];
    if (catalog.some((m) => m.providerID === PROVIDER_ID && m.id === MODEL_ID)) break;
    if (Date.now() > catDeadline) fail(`model ${PROVIDER_ID}/${MODEL_ID} not in GET /api/model`);
    await sleep(300);
  }
  const switched = await api('POST', `/api/session/${sessionID}/model`, {
    model: { id: MODEL_ID, providerID: PROVIDER_ID },
  });
  if (switched.status !== 204) fail(`model select: HTTP ${switched.status} ${switched.text}`);
  console.log(`model: ${PROVIDER_ID}/${MODEL_ID}`);

  const prompted = await api('POST', `/api/session/${sessionID}/prompt`, {
    prompt: { text: PROMPT },
    delivery: 'queue',
  });
  if (!prompted.ok) fail(`prompt: HTTP ${prompted.status} ${prompted.text}`);
  console.log('prompt admitted:', prompted.json.data.id);

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!done) {
    if (Date.now() > deadline) fail(`run did not complete within ${RUN_TIMEOUT_MS}ms`);
    await sleep(200);
  }
  sse.abort();
  await streamDone;
  console.log('run complete (finish=stop)');

  // session.tokens is pinned at zero in this build; sum per-message tokens instead.
  const messages = await api('GET', `/api/session/${sessionID}/message`);
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of (messages.json?.data || []).filter((m) => m.type === 'assistant')) {
    const t = m.tokens || {};
    totals.input += t.input || 0;
    totals.output += t.output || 0;
    totals.reasoning += t.reasoning || 0;
    totals.cacheRead += t.cache?.read || 0;
    totals.cacheWrite += t.cache?.write || 0;
  }
  console.log('token usage:', JSON.stringify(totals));
  console.log('PING OK');
}

process.on('SIGINT', () => shutdown().then(() => process.exit(1)));
try {
  await main();
} catch (err) {
  if (process.exitCode === 0) {
    process.exitCode = 1;
    console.error(err && err.stack ? err.stack : err);
  }
} finally {
  await shutdown();
}
