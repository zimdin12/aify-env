// No test may start a daemon that resolves the operator's own home.
//
// THE LEAK THIS CLOSES, 2026-10-14. A daemon finds `~/.aify` through `os.homedir()`, which on Windows reads
// USERPROFILE. `the-daemon-really-advertises.test.js` spawned daemons with `{ ...process.env, ... }`: sealed against the
// registry, not against the home. Under tests/run-in-a-temp-root.mjs the inherited home is private; run directly with
// `node --test`, it was the operator's, and the test daemons rewrote the real `~/.aify/env/default.json` and
// `default.generation` and took the real home's residents role.
//
// TWO INSTRUMENTS, because each misses what the other sees:
//   - the scan: every daemon spawn's env passes through `sealedDaemonEnv` or `sealedHomeEnv`, judged over the same
//     population as the registry gate (tests/_daemon-spawns.mjs), so a new spawn cannot opt out by omission;
//   - the seal itself, run: with THIS process's HOME and USERPROFILE set to the operator's home, the env the seal
//     returns makes a real Node child resolve a private home. No daemon is started to find out.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { daemonSpawns, sealedThrough, testFiles } from "./_daemon-spawns.mjs";
import { REAL_HOME, isPrivateHome, sealedDaemonEnv, sealedHomeEnv } from "./_sealed-daemon-env.mjs";

/** The home seal: the shared helpers, and nothing a file could spell another way. */
const sealsHome = (text) => /\bsealed(?:Daemon|Home)Env\s*\(/.test(text);
// NO FILE-LEVEL FALLBACK: one sealed spawn must not vouch for another in the same file.
const homeSealed = (call, fileText) => sealedThrough(call, fileText, sealsHome, { fileFallback: false });

test("THE SCAN FINDS DAEMON SPAWNS", () => {
  // POSITIVE CONTROL: "no offender" is what a scan that reaches nothing also says.
  const total = testFiles().reduce((n, f) => n + daemonSpawns(f.text).length, 0);
  assert.ok(total >= 20, `only ${total} daemon spawns found; the scan is not reaching them`);
});

test("EVERY TEST-SPAWNED DAEMON HAS A SEALED HOME", () => {
  const offenders = [];
  for (const { name, text } of testFiles()) {
    for (const call of daemonSpawns(text)) {
      if (!homeSealed(call, text)) offenders.push(`${name}: ${call.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], "a test spawns the daemon with an env that can resolve the operator's home. Build it "
    + "with `sealedDaemonEnv(...)` or wrap it in `sealedHomeEnv(...)` from tests/_sealed-daemon-env.mjs.");
});

test("NEGATIVE CONTROL: a registry seal alone is not a home seal, and neither is no env", () => {
  // The exact shape that leaked: sealed against the registry, home inherited.
  const leaked = 'spawn(process.execPath, [DAEMON, "--port", "0"], { env: { ...process.env, AIFY_SERVICE_REGISTRY: "/x.json" } });';
  const [call] = daemonSpawns(leaked);
  assert.ok(call, "the scan did not find the spawn, so this proves nothing");
  assert.equal(homeSealed(call, leaked), false);
  const bare = 'spawn(process.execPath, [ENTRY, "--port", "0"]);';
  assert.equal(homeSealed(daemonSpawns(bare)[0], bare), false);
  const wrapped = 'spawn(process.execPath, [ENTRY], { env: sealedHomeEnv({ ...process.env }) });';
  assert.equal(homeSealed(daemonSpawns(wrapped)[0], wrapped), true, "control: the seal is recognised");
  // One sealed spawn in a file does not vouch for an unsealed one beside it.
  const mixed = `${wrapped}\n${leaked}`;
  assert.deepEqual(daemonSpawns(mixed).map((c) => homeSealed(c, mixed)), [true, false]);
});

test("a temp directory that contains the operator's home does not make that home private", (t) => {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value); });
  for (const key of Object.keys(saved)) process.env[key] = path.dirname(REAL_HOME);
  assert.equal(path.resolve(os.tmpdir()), path.dirname(REAL_HOME), "control: the temp directory moved");
  assert.equal(isPrivateHome(REAL_HOME), false);
});

test("a private home is under the temp directory and is never the operator's", () => {
  assert.equal(isPrivateHome(REAL_HOME), false);
  assert.equal(isPrivateHome(path.join(REAL_HOME, ".")), false);
  assert.equal(isPrivateHome(os.tmpdir()), false, "the temp directory itself is not a private home");
  assert.equal(isPrivateHome(path.join(os.tmpdir(), "aify-home-x")), true);
  assert.equal(isPrivateHome(""), false);
  assert.equal(isPrivateHome(undefined), false);
  if (process.platform === "win32") assert.equal(isPrivateHome(REAL_HOME.toUpperCase()), false, "case is not a disguise");
});

test("RUN: from a process whose own home IS the operator's, the sealed env resolves a private home in a real child", (t) => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value); });
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_HOME;
  const resolved = (env) => {
    const run = spawnSync(process.execPath, ["-e", "process.stdout.write(require('os').homedir())"], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  // CONTROL: the unsealed env does resolve the operator's home, so a private answer below is the seal's doing.
  assert.equal(path.resolve(resolved({ ...process.env })).toLowerCase(), REAL_HOME.toLowerCase());
  for (const env of [sealedDaemonEnv(), sealedDaemonEnv({ AIFY_ADVERTISE: "1" }), sealedHomeEnv({ ...process.env })]) {
    const home = resolved(env);
    assert.equal(isPrivateHome(home), true, `a sealed daemon env resolved ${home}`);
    assert.equal(env.HOME, env.USERPROFILE, "HOME and USERPROFILE name one home");
  }
  const own = path.join(os.tmpdir(), "aify-own-private-home");
  assert.equal(sealedHomeEnv({ HOME: own, USERPROFILE: own }).USERPROFILE, own, "a test's own private home is kept");
});
