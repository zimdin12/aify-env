// What the OS says about a set of pids, in one question (lib/process-probe.mjs; 0.9 plan P0 C4).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { probeProcesses } from "../lib/process-probe.mjs";
import { verifyLifetime } from "../lib/resident-lifetimes.mjs";

const answered = (rows) => ({ status: 0, stdout: JSON.stringify(rows) });

test("ONE QUESTION FOR EVERY PID, never one per pid", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.at(-1)); return answered([]); };
  probeProcesses([11, 22, 33, 22, -1, 1.5], { platform: "win32", run });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ProcessId=11 OR ProcessId=22 OR ProcessId=33"/, "each valid pid once, in one filter");
  assert.equal(probeProcesses([], { platform: "win32", run }).size, 0);
  assert.equal(calls.length, 1, "no pids, no PowerShell");
});

test("A PID THE OS LISTS is alive with its creation in microseconds; one it does not list is gone", () => {
  const run = () => answered([{ pid: 11, created: "2026-10-02T15:00:00.1234567Z", cmd: "bash /c/x/claude-aify" }]);
  const answers = probeProcesses([11, 22], { platform: "win32", run });
  assert.deepEqual(answers.get(11), { alive: true, createdAtUs: Date.parse("2026-10-02T15:00:00Z") * 1000 + 123456, commandLine: "bash /c/x/claude-aify" });
  assert.deepEqual(answers.get(22), { alive: false, createdAtUs: null, commandLine: null });
  const hidden = probeProcesses([11], { platform: "win32", run: () => answered([{ pid: 11, created: null, cmd: null }]) }).get(11);
  assert.deepEqual(hidden, { alive: true, createdAtUs: null, commandLine: null }, "an elevated process hides its details, not its life");
});

test("A PROBE THAT FAILS SAYS NOTHING: every pid is unanswered, never gone", () => {
  const unanswered = { alive: null, createdAtUs: null, commandLine: null };
  for (const [name, run] of [["non-zero exit", () => ({ status: 1, stdout: "" })], ["timeout", () => ({ error: new Error("ETIMEDOUT"), status: null })],
    ["an empty list beside an error", () => ({ status: 0, stdout: "[]", stderr: "Get-CimInstance : Access denied" })],
    ["not JSON", () => ({ status: 0, stdout: "Get-CimInstance : Access denied" })], ["not a list", () => answered({ pid: 11 })],
    ["throws", () => { throw new Error("spawn EPERM"); }]]) {
    const answers = probeProcesses([11, 22], { platform: "win32", run });
    assert.deepEqual([answers.get(11), answers.get(22)], [unanswered, unanswered], name);
  }
  const linux = probeProcesses([11], { platform: "linux", run: () => { throw new Error("must not run"); } });
  assert.deepEqual(linux.get(11), unanswered, "no probe on this platform is no answer, without running anything");
});

test("THE REAL PROBE on Windows: this process, as verifyLifetime reads it, and a child that has exited", { skip: process.platform !== "win32" && "the probe is Windows only" }, () => {
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const gonePid = Number(exited.stdout);
  const answers = probeProcesses([process.pid, gonePid]);
  const self = answers.get(process.pid);
  assert.equal(self.alive, true);
  assert.ok(Number.isSafeInteger(self.createdAtUs) && self.createdAtUs < Date.now() * 1000, "a creation time in microseconds, in the past");
  assert.match(self.commandLine, /node/i);
  assert.equal(answers.get(gonePid).alive, false, "an exited child is gone");
  const record = { writtenAtUs: Date.now() * 1000, launcher: process.execPath };
  assert.equal(verifyLifetime(record, self).verified, "yes", "this process adopts as a launcher written after it started");
});
