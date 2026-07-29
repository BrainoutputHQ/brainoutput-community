#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Collector tests. exec is FAKED with realistic per-platform fixtures — no machine is touched,
// which is exactly why exec is injected. The cross-platform tests exist because the most
// dangerous collector bug is parsing one OS's output with another OS's parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  observation, PLATFORM, METHODS, hostCollectors, collectHost,
  parseDfLinux, parseDfDarwin,
} from "./collectors.mjs";
import { createApproval } from "./scope.mjs";

// ── fixtures: real-shaped output per platform ────────────────────────────────────────────────────

const LINUX_DF = `Filesystem                         1B-blocks        Used    Available Capacity Mounted on
/dev/mapper/ubuntu--vg-ubuntu--lv 52701990912 18253611008 31724484608      37% /
tmpfs                               3291967488     1228800  3290738688       1% /run
/dev/sda2                           2046627840   260870144  1653272576      14% /boot
`;

const DARWIN_DF = `Filesystem   1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1    244810108  15234560 214559232     7%  500000 4294967295    0%   /
devfs                 191       191         0   100%     660          0  100%   /dev
`;

const LINUX_IP_ROUTE = `default via 192.168.1.1 dev enp0s3 proto dhcp metric 100
192.168.1.0/24 dev enp0s3 proto kernel scope link src 192.168.1.50 metric 100
`;

const DARWIN_NETSTAT = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.1.1        UGScg                 en0
127                127.0.0.1          UCS                   lo0
192.168.1          link#7             UCS                   en0      !
`;

const LINUX_RESOLV = `nameserver 192.168.1.1
nameserver 1.1.1.1
search lan example.lan
options edns0
`;

const DARWIN_SCUTIL = `DNS configuration

resolver #1
  search domain[0] : lan
  nameserver[0] : 192.168.1.1
  nameserver[1] : 1.1.1.1
  if_index : 4 (en0)
  flags    : Request A records
  reach    : 0x00020002 (Reachable,Directly Reachable Address)
`;

const LINUX_SYSTEMCTL = `ssh.service                     loaded active running OpenBSD Secure Shell server
cron.service                    loaded active running Regular background program processing daemon
bluetooth.service               loaded active running Bluetooth service
`;

const DARWIN_LAUNCHCTL = `PID\tStatus\tLabel
123\t0\tcom.apple.cfprefsd.xpc.daemon
-\t0\tcom.apple.Dock.agent
`;

const LINUX_LEASES = `lease {
  interface "enp0s3";
  fixed-address 192.168.1.50;
  option subnet-mask 255.255.255.0;
  option routers 192.168.1.1;
  option dhcp-lease-time 86400;
  option domain-name-servers 192.168.1.1, 1.1.1.1;
}
`;

const DARWIN_GETPACKET = `op = BOOTREPLY
htype = 1
yiaddr = 192.168.1.50
server_identifier (ip): 192.168.1.1
lease_time (uint32): 0x15180
domain_name_server (ip_mult): {192.168.1.1, 1.1.1.1}
router (ip_mult): {192.168.1.1}
subnet_mask (ip): 255.255.255.0
`;

const LINUX_CERTS = `/etc/ssl/certs/ca-certificates.pem
/etc/ssl/certs/ISRG_Root_X1.pem
/etc/ssl/certs/DigiCert_Global_Root_G2.pem
`;

const DARWIN_CERTS = `-----BEGIN CERTIFICATE-----
MIIFakeBlockForFixtureOnly
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFakeSecondBlock
-----END CERTIFICATE-----
`;

const logLines = (n) => Array.from({ length: n }, (_, i) => `Jul 29 10:00:${String(i % 60).padStart(2, "0")} host app[1]: message ${i}`);

/** A fake exec: handlers map cmd -> stdout string or fn(args) -> {stdout,stderr,code}. */
function fakeExec(handlers) {
  const calls = [];
  const exec = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(" "));
    const h = handlers[cmd];
    if (!h) return { stdout: "", stderr: `${cmd}: command not found`, code: 127 };
    return typeof h === "function" ? h(args) : { stdout: h, stderr: "", code: 0 };
  };
  return { exec, calls };
}

const linuxHandlers = (overrides = {}) => ({
  df: (args) => args.includes("-B1") ? { stdout: LINUX_DF, stderr: "", code: 0 } : { stdout: "", stderr: "bad flags", code: 1 },
  ip: LINUX_IP_ROUTE,
  cat: (args) => args[0] === "/etc/resolv.conf"
    ? { stdout: LINUX_RESOLV, stderr: "", code: 0 }
    : { stdout: LINUX_LEASES, stderr: "", code: 0 },
  systemctl: LINUX_SYSTEMCTL,
  find: LINUX_CERTS,
  journalctl: "Jul 29 09:59:00 host sshd[9]: Accepted publickey for ops\nJul 29 09:59:01 host cron[1]: job done\n",
  ...overrides,
});

const darwinHandlers = (overrides = {}) => ({
  df: (args) => args.includes("-k") ? { stdout: DARWIN_DF, stderr: "", code: 0 } : { stdout: "", stderr: "bad flags", code: 1 },
  netstat: DARWIN_NETSTAT,
  scutil: DARWIN_SCUTIL,
  launchctl: DARWIN_LAUNCHCTL,
  ipconfig: DARWIN_GETPACKET,
  security: DARWIN_CERTS,
  tail: "Jul 29 09:59:00 mac loginwindow[88]: user logged in\n",
  ...overrides,
});

const byKind = (obs, kind) => obs.filter((o) => o.kind === kind);

// ── observation() ────────────────────────────────────────────────────────────────────────────────

test("observation hashes raw and never stores it", () => {
  const o = observation({ kind: "x", subject: "y", value: 1, collector: "c", method: "passive", raw: "secret-bytes" });
  assert.equal(o.raw.sha256, createHash("sha256").update("secret-bytes").digest("hex"));
  assert.equal(o.raw.byteLength, 12);
  assert.ok(!JSON.stringify(o).includes("secret-bytes"), "raw text must not survive anywhere in the observation");
});

test("observation rejects an undeclared method", () => {
  assert.throws(() => observation({ kind: "x", subject: "y", value: 1, collector: "c", method: "magic" }));
});

test("PLATFORM is one of the normalized values", () => {
  assert.ok(["linux", "darwin", "win32", "unsupported"].includes(PLATFORM));
});

// ── collector contract ───────────────────────────────────────────────────────────────────────────

test("hostCollectors covers the required set, each with a declared method", () => {
  const names = hostCollectors().map((c) => c.name).sort();
  assert.deepEqual(names, ["certificates", "cpu", "dhcp-lease", "disks", "dns-config", "interfaces", "logs", "memory", "routes", "services"]);
  for (const c of hostCollectors()) {
    assert.ok(METHODS.includes(c.method), `${c.name} declares a valid method`);
    assert.equal(typeof c.run, "function");
    assert.ok(Array.isArray(c.platform));
  }
});

// ── linux happy path ─────────────────────────────────────────────────────────────────────────────

test("collectHost on linux parses every collector's native format", async () => {
  const { exec } = fakeExec(linuxHandlers());
  const r = await collectHost({ exec, platform: "linux", now: 1000, privileged: true });
  assert.deepEqual(r.errors, []);

  const vol = byKind(r.observations, "volume").find((v) => v.subject === "/boot");
  assert.equal(vol.value.sizeBytes, 2046627840);            // -B1: already bytes
  assert.equal(vol.value.usePct, 14);

  const def = byKind(r.observations, "route").find((x) => x.subject === "default");
  assert.equal(def.value.gateway, "192.168.1.1");
  assert.equal(def.value.iface, "enp0s3");

  const dns = byKind(r.observations, "dns-config")[0];
  assert.deepEqual(dns.value.nameservers, ["192.168.1.1", "1.1.1.1"]);
  assert.deepEqual(dns.value.search, ["lan", "example.lan"]);

  const svc = byKind(r.observations, "services")[0];
  assert.equal(svc.value.length, 3);
  assert.equal(svc.value[0].unit, "ssh.service");

  const lease = byKind(r.observations, "dhcp-lease")[0];
  assert.equal(lease.value.address, "192.168.1.50");
  assert.equal(lease.value.leaseSeconds, 86400);

  const certs = byKind(r.observations, "cert-store")[0];
  assert.equal(certs.value.count, 3);

  assert.ok(byKind(r.observations, "cpu").length === 1);
  assert.ok(byKind(r.observations, "memory").length === 1);
  assert.ok(byKind(r.observations, "interface").length >= 1);
  assert.ok(byKind(r.observations, "log-tail").length === 1);
  assert.ok(r.observations.every((o) => o.method === "passive" && o.at === 1000 && o.platform === "linux"));
});

// ── platform isolation ───────────────────────────────────────────────────────────────────────────

test("darwin df output is parsed as 1024-byte blocks, NEVER as linux bytes", async () => {
  const { exec } = fakeExec(darwinHandlers());
  const r = await collectHost({ exec, platform: "darwin", now: 1, privileged: true });
  const root = byKind(r.observations, "volume").find((v) => v.subject === "/");
  assert.equal(root.value.usedBytes, 15234560 * 1024);      // linux parser would leave it as 15234560
  assert.equal(root.value.usePct, 7);

  const dns = byKind(r.observations, "dns-config")[0];
  assert.deepEqual(dns.value.nameservers, ["192.168.1.1", "1.1.1.1"]);

  const def = byKind(r.observations, "route").find((x) => x.subject === "default");
  assert.equal(def.value.gateway, "192.168.1.1");
  assert.equal(def.value.iface, "en0");

  const lease = byKind(r.observations, "dhcp-lease")[0];
  assert.equal(lease.value.address, "192.168.1.50");
  assert.equal(lease.value.leaseSeconds, 0x15180);
});

test("the linux df parser refuses darwin-shaped output rather than guessing", () => {
  assert.equal(parseDfLinux(DARWIN_DF), null);
  assert.equal(parseDfDarwin(LINUX_DF), null);
});

test("linux df flags are not reused on darwin (collector asks for -k)", async () => {
  const { exec, calls } = fakeExec(darwinHandlers());
  await collectHost({ exec, platform: "darwin", now: 1, privileged: true });
  assert.ok(calls.includes("df -k"));
  assert.ok(!calls.some((c) => c.includes("-B1")));
  assert.ok(calls.includes("netstat -rn"));
  assert.ok(!calls.some((c) => c.startsWith("ip route")));
});

test("unsupported platform returns supported:false, never a guess", async () => {
  const disks = hostCollectors().find((c) => c.name === "disks");
  const r = await disks.run({ exec: async () => { throw new Error("exec must not be called"); }, platform: "win32", now: 1 });
  assert.equal(r.supported, false);
  assert.ok(r.reason.includes("win32"));
});

test("collectHost on win32: os-based collectors run, command-based ones are skipped with reasons", async () => {
  const { exec, calls } = fakeExec({});
  const r = await collectHost({ exec, platform: "win32", now: 1, privileged: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(calls, []);                                 // no command is even attempted
  const kinds = new Set(r.observations.map((o) => o.kind));
  assert.deepEqual([...kinds].sort(), ["cpu", "interface", "memory"]);
  const skippedNames = r.skipped.map((s) => s.name).sort();
  assert.deepEqual(skippedNames, ["certificates", "dhcp-lease", "disks", "dns-config", "logs", "routes", "services"]);
  assert.ok(r.skipped.every((s) => s.reason));
});

// ── privilege boundary ───────────────────────────────────────────────────────────────────────────

test("a privileged collector degrades to partial evidence with a stated reason when privilege is absent", async () => {
  const dhcp = hostCollectors().find((c) => c.name === "dhcp-lease");
  assert.equal(dhcp.needsPrivilege, true);
  const { exec, calls } = fakeExec(linuxHandlers());
  const r = await dhcp.run({ exec, platform: "linux", now: 1, privileged: false });
  assert.equal(r.supported, true);
  assert.equal(r.partial, true);
  assert.ok(r.reason);
  assert.equal(r.observations[0].value.state, "partial-evidence");
  assert.ok(!calls.some((c) => c.includes("dhclient.leases")), "no privileged read was attempted");
});

test("with privilege the same collector produces the full lease", async () => {
  const { exec } = fakeExec(linuxHandlers());
  const r = await collectHost({ exec, platform: "linux", now: 1, privileged: true });
  const lease = byKind(r.observations, "dhcp-lease")[0];
  assert.equal(lease.value.address, "192.168.1.50");
  assert.ok(lease.raw.sha256, "raw lease file is hashed, not stored");
});

// ── logs: bounded and redacted ───────────────────────────────────────────────────────────────────

test("logs are capped at 200 lines and redacted before returning", async () => {
  const lines = logLines(500);
  lines[150] = "Jul 29 10:00:30 host app[1]: user login password=hunter2 ok";
  const { exec } = fakeExec(linuxHandlers({ journalctl: lines.join("\n") }));
  const r = await collectHost({ exec, platform: "linux", now: 1, privileged: true });
  const log = byKind(r.observations, "log-tail")[0];
  assert.equal(log.value.lines.length, 200);
  assert.equal(log.value.truncated, true);
  assert.ok(!log.value.lines.some((l) => l.includes("hunter2")), "credential must be redacted");
  assert.ok(log.value.redacted.includes("credential"));
  assert.ok(!JSON.stringify(log).includes("hunter2"));
});

test("darwin logs come from its own reader, not journalctl", async () => {
  const { exec, calls } = fakeExec(darwinHandlers());
  const r = await collectHost({ exec, platform: "darwin", now: 1, privileged: true });
  const log = byKind(r.observations, "log-tail")[0];
  assert.equal(log.subject, "/var/log/system.log");
  assert.ok(!calls.some((c) => c.startsWith("journalctl")));
});

// ── approval gate ────────────────────────────────────────────────────────────────────────────────

test("collectors outside an approval's list are skipped with the gate's reason", async () => {
  const { exec, calls } = fakeExec(linuxHandlers());
  const approval = createApproval({ approvedBy: "test", collectors: ["cpu", "memory"] });
  const r = await collectHost({ exec, platform: "linux", approval, now: 1, privileged: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(new Set(r.observations.map((o) => o.collector)), new Set(["cpu", "memory"]));
  assert.ok(r.skipped.every((s) => s.reason.includes("was not approved")));
});

test("a failing command lands in errors, never aborts the other collectors", async () => {
  const { exec } = fakeExec(linuxHandlers({
    df: () => { throw new Error("df exploded"); },
  }));
  const r = await collectHost({ exec, platform: "linux", now: 1, privileged: true });
  assert.deepEqual(r.errors, [{ name: "disks", error: "df exploded" }]);
  assert.ok(byKind(r.observations, "dns-config").length === 1);
});
