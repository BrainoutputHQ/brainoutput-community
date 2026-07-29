#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Real-world entry point: the only place node:child_process and node:net are actually touched.
// Everything below this line is injected, which is what keeps the rest of the slice testable.
import { spawn } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { Store } from "../store.mjs";
import { COMMANDS, parseArgs } from "./cli.mjs";

const exec = (cmd, args = []) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout.on("data", (c) => (stdout += c));
  p.stderr.on("data", (c) => (stderr += c));
  p.on("close", (code) => resolve({ stdout, stderr, code }));
  p.on("error", (e) => resolve({ stdout: "", stderr: e.message, code: 127 }));
});

const connect = ({ host, port, timeoutMs = 1500 }) => new Promise((resolve) => {
  const s = tcpConnect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(timeoutMs);
  s.on("connect", () => done(true));
  s.on("timeout", () => done(false));
  s.on("error", () => done(false));
});

const [cmd, ...rest] = process.argv.slice(2);
const fn = COMMANDS[cmd];
if (!fn) { console.error(`usage: ${Object.keys(COMMANDS).join(" | ")}`); process.exit(2); }
// A refusal is a normal outcome here, not a crash — print it plainly rather than as a stack trace.
try {
  await fn(parseArgs(rest), { store: new Store(), exec, connect, now: Date.now() });
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
