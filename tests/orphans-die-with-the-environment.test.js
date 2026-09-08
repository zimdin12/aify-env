#!/usr/bin/env node
// THE REQUIREMENT, end to end: if aify-env dies, the processes it manages do not outlive it.
//
// The graceful half is a shutdown handler, and it is the easy half. This tests the one that matters:
// the environment is killed OUTRIGHT, runs no handler, and its agents are left running with nothing
// able to name them. The next instance reads the record and cleans up.
//
// The test kills with SIGKILL deliberately. Anything catchable would prove the handler works and say
// nothing about the case the handler cannot reach.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { killTree } from "../lib/kill-tree.mjs";
import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs");
const LF = String.fromCharCode(10);

function startDaemon(record) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: sealedDaemonEnv({ AIFY_ENV_PROCESS_RECORD: record }),
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon did not start: ${out}`)), 20_000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, base: m[1] }); }
    });
    // DRAINED, AND THAT IS THE WHOLE POINT OF THESE THREE LINES. stderr was piped and never read, so
    // once the daemon had written ~8KB the pipe filled, its next write BLOCKED, and it stopped
    // answering HTTP while still being alive. Measured 2026-09-04 before the fix: THREE of seven
    // isolated runs failed, as `fetch failed` on a request the daemon never got to, or as the file
    // hitting the 60s timeout waiting on one. Both are the same block wearing different hats, and the
    // intermittency is just how much the daemon happened to say that run.
    //
    // KEPT, NOT DISCARDED, because a daemon that dies for a REAL reason says why on this stream, and
    // a test that throws away the explanation makes the next failure twice the work.
    let errOut = "";
    child.stderr.on("data", (c) => { errOut += c; });
    child.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) process.stderr.write(`[daemon exited ${code}${signal ? ` ${signal}` : ""}] ${errOut}`);
    });
    child.on("error", reject);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How many `sleep` processes descend from ONE process, by walking the PID/PPID tree.
 *
 * COUNTING BY NAME ACROSS THE MACHINE WAS THE DEFECT, and it is the one this file's flake is best
 * explained by. `ps -W | grep -c '[s]leep'` counts every sleep on the host — and SEVEN test files in
 * this suite spawn one, while `node --test` runs files in PARALLEL. So `before` could include a
 * sibling's sleep, and the "did the count fall" assertion could be defeated by a sibling STARTING
 * one in the same window. Nothing about that is a timing budget; the observable was shared.
 *
 * This is the hazard aify-comms' own CLAUDE.md names for its Python suite: two files on different
 * workers touching one external resource is what `--dist loadfile` does not cover. A machine-wide
 * process count is exactly that resource.
 *
 * WINPID IS THE BRIDGE. `ps -W` reports an MSYS `PID`, its `PPID`, and the Windows `WINPID`; node
 * hands out Windows pids. So the row is found by WINPID and the tree is walked on PID/PPID.
 */
function sleepingDescendantsOf(windowsPid) {
  const res = spawnSync("bash", ["-c", "ps -W 2>/dev/null || true"], { encoding: "utf8" });
  const rows = String(res.stdout).split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cells) => cells.length >= 8)
    .map((cells) => ({ pid: cells[0], ppid: cells[1], winpid: cells[3], command: cells.slice(7).join(" ") }));
  const root = rows.find((row) => row.winpid === String(windowsPid));
  if (!root) return 0;

  const wanted = new Set([root.pid]);
  // REPEATED TO A FIXED POINT rather than assumed one level deep: a launcher is a shell, the agent is
  // its child, and a real one nests further. Bounded by the row count, so a cycle cannot hang it.
  for (let pass = 0; pass < rows.length; pass += 1) {
    const before = wanted.size;
    for (const row of rows) if (wanted.has(row.ppid)) wanted.add(row.pid);
    if (wanted.size === before) break;
  }
  return rows.filter((row) => wanted.has(row.pid) && row.pid !== root.pid && /sleep/.test(row.command)).length;
}

/**
 * Wait until `check()` is true, or fail saying what it was instead.
 *
 * A FIXED SLEEP IS A BUDGET, AND THIS FILE'S BUDGETS WERE BELOW THEIR OWN COST. `a GRANDCHILD dies
 * too` failed once at 1500ms while the machine was running two other suites, and passed alone and on
 * every clean run after — which is this repo's standing description of a flake: not randomness, a
 * deadline chosen when the machine was idle. Its sibling, `a process outlives a KILLED environment`,
 * had failed the same way at 12.2s under heavy parallel load.
 *
 * POLLING IS NOT A LONGER SLEEP. A bigger number makes the suite slower on every run and still fails
 * on a slower machine; waiting for the CONDITION finishes as soon as it is true and only spends the
 * deadline when something is actually wrong. And the failure message then carries the observation
 * rather than "it was not done yet", which is the difference between a diagnosis and a retry.
 */
async function until(check, { what, deadlineMs = 20_000, everyMs = 100 } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() - started > deadlineMs) {
      throw new Error(`${what} did not become true within ${deadlineMs}ms (last saw ${JSON.stringify(last)})`);
    }
    await settle(everyMs);
  }
}

test("a process outlives a KILLED environment, and the next one reaps it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-orphan-"));
  const record = path.join(dir, "owned.json");
  const launcher = path.join(dir, "long-aify");
  // `exec`, so the recorded pid IS the long-lived process rather than a shell wrapping one.
  //
  // A LIMIT WORTH STATING, found by watching this test leak: if the launcher dies BEFORE its child --
  // which is what happens on Windows when the environment is killed and the pty tears the shell down
  // with it -- the child is orphaned with no parent, and no pid-tree walk can find it from the record.
  // Reaping a tree needs the tree to still exist. Test 3 covers the grandchild case where it does.
  fs.writeFileSync(launcher, ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', "exec sleep 120", ""].join(LF));

  const first = await startDaemon(record);
  const started = await (await fetch(`${first.base}/processes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "aify-comms", launcher }),
  })).json();

  assert.ok(started.pid > 0, "the environment did not report a pid");
  assert.equal(alive(started.pid), true, "the managed process never started");

  // The record is the whole mechanism: if this is empty, nothing downstream can work.
  assert.equal(JSON.parse(fs.readFileSync(record, "utf8")).length, 1, "the process was not recorded");

  // KILLED, not asked to stop. No handler runs.
  first.child.kill("SIGKILL");
  await settle(500);

  // TWO WAYS TO SATISFY THE REQUIREMENT, and asserting only one of them is what made this test flaky.
  // On Windows a pty child is often torn down with the environment that owned its console, so the
  // process is already gone here -- perfectly good, and nothing left to reap. When it survives, the
  // record is what finishes the job. The requirement is "does not outlive the environment", not
  // "survives long enough for the reaper to be interesting".
  const survivedTheKill = alive(started.pid);

  const second = await startDaemon(record);
  await settle(1500);

  try {
    assert.equal(
      alive(started.pid),
      false,
      survivedTheKill
        ? "the orphan outlived its environment and the replacement did not reap it"
        : "the process died with its environment but is somehow alive again",
    );
  } finally {
    second.child.kill("SIGKILL");
    killTree(started.pid);  // the TREE: these tests leaked grandchildren before this existed
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ON WINDOWS THERE IS NO GRACEFUL PATH from another process, and that is not a gap in the code.
// `child.kill("SIGTERM")` there is TerminateProcess: the target dies immediately and no handler runs.
// Node emulates SIGINT only for a real console Ctrl-C, which a test cannot deliver to a child.
//
// So on Windows EVERY external stop is the ungraceful one, and the record-based reap above is not a
// backstop -- it is the entire mechanism. That raises what the first test proves rather than lowering
// it. The handlers still earn their place on POSIX and for Ctrl-C in an operator's own terminal.
test("a graceful stop takes its processes with it", { skip: process.platform === "win32"
  && "SIGTERM from another process is TerminateProcess on Windows; no handler can run" }, async () => {
  // The other half, and the common one: an operator pressing Ctrl-C should not leave agents running
  // until the next start.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-graceful-"));
  const record = path.join(dir, "owned.json");
  const launcher = path.join(dir, "long-aify");
  fs.writeFileSync(launcher, ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', "sleep 120", ""].join(LF));

  const { child, base } = await startDaemon(record);
  const started = await (await fetch(`${base}/processes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "aify-comms", launcher }),
  })).json();
  assert.equal(alive(started.pid), true);

  child.kill("SIGTERM");
  await settle(2000);

  try {
    assert.equal(alive(started.pid), false, "a graceful shutdown left its managed process running");
  } finally {
    killTree(started.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a GRANDCHILD dies too — killing the launcher is not enough", async () => {
  // The gap this file's first version missed. A launcher is a script; the agent is a child of it. My
  // orphan tests left two `sleep` processes running with dead parents, which is the leak wearing a
  // different hat: the wrapper stopped and the thing an operator cared about did not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tree-"));
  const record = path.join(dir, "owned.json");
  const launcher = path.join(dir, "tree-aify");
  // `sleep` runs as a CHILD here rather than replacing the shell, which is what a real launcher does
  // when it starts an agent and stays around to wrap it.
  fs.writeFileSync(launcher, ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', "sleep 90 &", "wait", ""].join(LF));

  const { child, base } = await startDaemon(record);
  const started = await (await fetch(`${base}/processes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "aify-comms", launcher }),
  })).json();
  // SCOPED TO THIS LAUNCHER, so a sibling test file's `sleep` can neither inflate the count nor keep
  // it from falling. Seven files in this suite spawn one and they run in parallel.
  const descendants = () => sleepingDescendantsOf(started.pid);
  // WAIT FOR THE CHILD TO EXIST rather than for a fixed 1200ms. On a loaded machine the launcher's
  // `sleep` may not be forked yet, and the count below would be taken before there was anything to
  // count -- which fails the "this test would prove nothing" guard rather than the thing being tested.
  const before = await until(() => descendants() || 0, { what: "the launcher's own child appearing" });
  assert.ok(before > 0, "the launcher never started its child; this test would prove nothing");

  await fetch(`${base}/processes/${started.id}`, { method: "DELETE" });

  try {
    // AND FOR THE COUNT TO FALL, which is the thing being tested. A stop is asynchronous all the way
    // down -- the daemon signals the launcher, the launcher's shell reaps its child -- so the only
    // honest question is whether it happens, not whether it happens inside a number chosen here.
    await until(() => descendants() < before,
      { what: `the launcher's own child exiting (it had ${before})` });
  } finally {
    child.kill("SIGKILL");
    killTree(started.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("THE COUNT IS SCOPED TO ONE LAUNCHER, so a sibling test file cannot defeat it", async () => {
  // THE BEST EXPLANATION FOR THIS FILE'S FLAKE, and it is not a timing budget. The count used to be
  // `ps -W | grep -c '[s]leep'` -- every sleep on the machine. SEVEN files in this suite spawn one
  // and `node --test` runs files in PARALLEL, so `before` could include a sibling's process, and the
  // "did the count fall" assertion could be defeated by a sibling STARTING one in the same window.
  //
  // aify-comms' own CLAUDE.md names this hazard for its Python suite: two files touching one external
  // resource is what per-file distribution does not cover. A machine-wide process count is exactly
  // that resource, and no amount of waiting fixes a shared observable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-scope-"));
  const record = path.join(dir, "owned.json");
  const launcher = path.join(dir, "scope-aify");
  fs.writeFileSync(launcher, ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', "sleep 90 &", "wait", ""].join(LF));

  const { child, base } = await startDaemon(record);
  // A DECOY: a `sleep` this launcher did not start, standing in for whatever a sibling file is doing.
  const decoy = spawn("bash", ["-c", "sleep 60"], { stdio: "ignore", detached: false });
  try {
    const started = await (await fetch(`${base}/processes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "aify-comms", launcher }),
    })).json();

    const mine = await until(() => sleepingDescendantsOf(started.pid) || 0,
      { what: "this launcher's own child appearing" });
    // POSITIVE CONTROL: it finds the one it should. Without this, a counter that returned 0 for
    // everything would satisfy the scoping assertion below perfectly.
    assert.equal(mine, 1, "the scoped count did not find this launcher's own sleep");

    // AND NOT THE OTHERS. This is the discriminating evidence, measured in the same run: the
    // machine-wide count is strictly higher than the scoped one, so the old `grep -c '[s]leep'`
    // would have been reading somebody else's processes.
    const machineWide = Number(String(spawnSync("bash",
      ["-c", "ps -W 2>/dev/null | grep -c '[s]leep' || true"], { encoding: "utf8" }).stdout).trim() || 0);
    assert.ok(machineWide > mine,
      `the machine shows ${machineWide} sleeps and this launcher owns ${mine}; with no other sleep `
      + "running, this test cannot tell a scoped count from a global one");
    assert.equal(sleepingDescendantsOf(started.pid), 1,
      `the count included a sleep this launcher did not start (machine has ${machineWide})`);

    // A DECOY ASSERTION WAS DELETED HERE, and the reason is worth more than the assertion was.
    // It read `sleepingDescendantsOf(decoy.pid) === 0` and claimed to prove the count follows
    // DESCENT rather than process NAME. It could not fail: measured on this host, `ps -W` reports
    // these sleeps with `ppid 1` — orphaned in its view — so no implementation would have linked the
    // decoy's sleep to the decoy, and the assertion passed for a reason that had nothing to do with
    // the rule it named. The `machineWide > mine` check above is the honest version: other sleeps
    // demonstrably exist, and the scoped count still answers one.
    killTree(started.pid);
  } finally {
    child.kill("SIGKILL");
    try { decoy.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
