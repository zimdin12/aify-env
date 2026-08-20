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

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs");
const LF = String.fromCharCode(10);

function startDaemon(record) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AIFY_ENV_PROCESS_RECORD: record },
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon did not start: ${out}`)), 20_000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, base: m[1] }); }
    });
    child.on("error", reject);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await settle(1200);

  const descendants = () => {
    const res = spawnSync("bash", ["-c", "ps -W 2>/dev/null | grep -c '[s]leep' || true"], { encoding: "utf8" });
    return Number(String(res.stdout).trim() || 0);
  };
  const before = descendants();
  assert.ok(before > 0, "the launcher never started its child; this test would prove nothing");

  await fetch(`${base}/processes/${started.id}`, { method: "DELETE" });
  await settle(1500);

  try {
    assert.ok(descendants() < before, "the launcher was stopped but its child kept running");
  } finally {
    child.kill("SIGKILL");
    killTree(started.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
