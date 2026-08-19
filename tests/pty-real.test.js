#!/usr/bin/env node
// The REAL terminal, verified out of process.
//
// Everything else about the runner is tested in-process with an injected fake. This is the one that
// uses node-pty, and it has to be a child because a node-pty child on Windows leaves a PipeWrap alive
// after it exits — so any process that spawns one never exits by itself.
//
// That is not a testing inconvenience, it is the leak written down. A long-running environment that
// spawns thousands of processes and never releases those handles will accumulate them, which is why
// the runner calls destroy() and why the README says what destroy() does and does not fix.
//
// UNANSWERED IS NOT A PASS, here too: if the host has no terminal support this test FAILS rather than
// skipping. A skip reports green, and "the terminal path works" is exactly the claim that must not be
// green because nobody could check it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { terminalSupport } from "../lib/runner.mjs";

const SMOKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pty-smoke.mjs");

test("a process started on a REAL terminal runs, streams, and is released", () => {
  const support = terminalSupport();
  assert.equal(
    support.available,
    true,
    `this host cannot open a terminal (${support.reason}). That is a real capability gap, not a reason `
    + "to report green: install node-pty here.",
  );

  const res = spawnSync(process.execPath, [SMOKE], { encoding: "utf8", timeout: 60_000 });
  assert.equal(res.status, 0, `smoke run failed:\n${res.stdout}\n${res.stderr}`);

  const report = JSON.parse(res.stdout.trim().split("\n").pop());
  assert.equal(report.ran, true);
  assert.equal(report.terminal, true, "a real terminal was available and the runner did not use it");
  assert.ok(report.pid > 0, "no pid from the terminal path");
  assert.match(report.output, /REAL-PTY-OUTPUT/, "output did not stream from the terminal");
  assert.equal(report.ownedAfterExit, 0, "an exited terminal process is still owned");
});

test("the smoke script exits by itself, which is what makes this test possible", () => {
  // If it ever stopped exiting, this file would hang instead of failing, and a hang is the failure
  // mode that reads as "still running" rather than "broken".
  const started = Date.now();
  const res = spawnSync(process.execPath, [SMOKE], { encoding: "utf8", timeout: 30_000 });
  assert.notEqual(res.signal, "SIGTERM", "the smoke script had to be killed");
  assert.ok(Date.now() - started < 30_000);
});
