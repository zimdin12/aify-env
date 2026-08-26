#!/usr/bin/env node
// A process something KILLED must not be reported as one that exited cleanly.
//
// WHAT WAS WRONG, and it was wrong in two places at once. `#wireChild` discarded the second argument
// of Node's `close` event -- that event is `(code, signal)` -- and `finish` then wrote
// `stream.exitCode = code ?? 0`. Node gives a null code EXACTLY when a signal killed the process, so
// the coercion manufactured a clean exit for every killed child and the signal that would have
// contradicted it had already been thrown away one line earlier. The PTY branch dropped node-pty's
// signal the same way.
//
// WHAT IT COST, upstream. aify-comms delegates every managed agent's terminal to this environment, so
// EVERY managed death came back as `exitCode: 0`. On 2026-08-26 the operator asked why their agents
// kept dropping; the whole chain on the aify-comms side was already correct -- separate code and
// signal fields, a NULL-defaulted column, a route that tests `is not None` rather than truthiness --
// and none of it could help, because the 0 it was handed had been invented here. "Exited cleanly" is
// worse than "we do not know": a 0 reads as evidence.
//
// THE FLAG IS PART OF THE FIX, not tidying. `subscribe` decided whether a process had already ended by
// testing `exitCode !== null`, which was only ever correct because the code was coerced. Keeping the
// null without adding `exited` would leave every signalled process looking LIVE to a late subscriber,
// on a stream that never ends -- the same failure, one function away. The fourth test below is the one
// that fails if someone removes the flag as redundant.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner } from "../lib/runner.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

/** A spec that runs a real, harmless command through the piped branch. */
const spec = (script) => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", script],
});

/** node-pty's shape, exiting the way the caller asks. */
function fakeTerminal({ exitCode, signal }) {
  const onData = [];
  const onExit = [];
  setTimeout(() => onExit.forEach((cb) => cb({ exitCode, signal })), 5);
  return {
    pid: 4242,
    onData: (cb) => onData.push(cb),
    onExit: (cb) => onExit.push(cb),
    write: () => {},
    kill: () => {},
    destroy: () => {},
  };
}

/** Everything the runner remembers about how a process ended, read through the public subscribe. */
function exitOf(runner, id) {
  return new Promise((resolve) => {
    runner.subscribe(id, () => {}, (code, signal) => resolve({ code, signal }));
  });
}

test("a process killed from outside is distinguishable from one that exited cleanly", async () => {
  // THE OPERATOR'S CASE, and the one the coercion erased. Before this fix a killed worker and a
  // worker that finished its job both arrived downstream as `exitCode: 0`.
  //
  // MEASURED ON THIS HOST, because the answer is platform-specific and the difference matters to
  // whoever reads the recorded value:
  //   * `child.kill("SIGKILL")` -- the runner killing its own child -- gives Node `(null, "SIGKILL")`
  //     on Windows as well as POSIX, because Node remembers the signal IT was asked to send.
  //   * an EXTERNAL kill, which is what the fleet is actually suffering, gives `(1, null)` on Windows.
  //     Windows has no POSIX signals to report, so there is no signal to carry and the exit code is
  //     the whole evidence.
  // SO THIS TEST PASSES BEFORE AND AFTER THE FIX ON WINDOWS, and it is kept anyway and labelled as
  // what it is: a CHARACTERISATION of the platform, not evidence of the repair. `1 ?? 0` is 1, so the
  // old coercion never bit the external-kill case here. It bit every NULL code -- a signalled death on
  // POSIX, and on Windows a kill the runner issues itself -- and those are tests 5 and 7, which do go
  // red without the fix. Writing that down beats letting a green test be read as proof it is not.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("setTimeout(() => {}, 30000)"));
  const exit = exitOf(runner, handle.id);
  process.kill(handle.pid, "SIGKILL");
  const { code, signal } = await exit;

  assert.ok(
    !(code === 0 && !signal),
    `a killed process reported a CLEAN EXIT (code=${JSON.stringify(code)} signal=${JSON.stringify(signal)}). `
      + "That is the defect this test exists for: 0 with no signal is what a job that finished looks like.",
  );
  // And it carries SOMETHING to say so, either way round.
  assert.ok(code !== null || signal, "a killed process reported neither a code nor a signal");
});

test("a clean exit still reports 0, and claims no signal", async () => {
  // The control, and the most common case in the fleet. Zero must survive: a fix that made every
  // death report null would be the same defect mirrored.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("process.exit(0)"));
  const { code, signal } = await exitOf(runner, handle.id);

  assert.equal(code, 0, "a clean exit stopped reporting its zero");
  assert.equal(signal, "", "a process nothing killed claimed a signal");
});

test("a non-zero exit reports its own code", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("process.exit(23)"));
  const { code, signal } = await exitOf(runner, handle.id);
  assert.equal(code, 23);
  assert.equal(signal, "");
});

test("a subscriber arriving AFTER a signalled death is told, not left on a silent stream", async () => {
  // THE REGRESSION THE FIX COULD HAVE INTRODUCED. `subscribe` used `exitCode !== null` as "has it
  // ended", which stops being true the moment a null code becomes meaningful. Without the `exited`
  // flag this hangs: the process is gone and the late subscriber waits forever, which is precisely
  // the "a dead agent looks like a thinking one" failure the exit event exists to prevent.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("setTimeout(() => {}, 30000)"));
  await new Promise((resolve) => {
    runner.subscribe(handle.id, () => {}, () => resolve());
    process.kill(handle.pid, "SIGKILL");
  });

  // The process has now ended. A subscriber attaching here must be told immediately.
  const late = await Promise.race([
    exitOf(runner, handle.id),
    new Promise((resolve) => setTimeout(() => resolve("NEVER TOLD"), 2000)),
  ]);
  assert.notEqual(late, "NEVER TOLD", "a late subscriber to a KILLED process was never told it ended");
  // Whatever this platform reports, it must be the SAME answer the first subscriber got -- a late
  // reader being told a different story than an early one is its own bug.
  assert.ok(!(late.code === 0 && !late.signal), "a late subscriber was told a killed process exited cleanly");
});

test("the terminal branch carries node-pty's signal too", async () => {
  // The PTY path dropped it independently, at `finish(event?.exitCode)`. A managed agent's console IS
  // a PTY when this host has one, so leaving this half unfixed would have left the common case blind.
  const runner = new Runner({ openTerminal: () => fakeTerminal({ exitCode: null, signal: "SIGTERM" }) });
  const handle = await runner.start(spec("setTimeout(() => {}, 30000)"));
  assert.equal(handle.terminal, true, "this test did not take the terminal branch, so it proves nothing");
  const { code, signal } = await exitOf(runner, handle.id);
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
});

test("a terminal that exits cleanly is unchanged", async () => {
  const runner = new Runner({ openTerminal: () => fakeTerminal({ exitCode: 0, signal: undefined }) });
  const handle = await runner.start(spec("setTimeout(() => {}, 30000)"));
  const { code, signal } = await exitOf(runner, handle.id);
  assert.equal(code, 0);
  assert.equal(signal, "");
});

test("a late subscriber to a NULL-CODE death is told, which is what the `exited` flag is for", async () => {
  // THE TEST THAT FAILS IF SOMEONE REMOVES THE FLAG. The pipe test above cannot prove this on
  // Windows: an external kill there reports code 1, and `exitCode !== null` is still true of 1, so
  // the old gate keeps working by accident. A null code is what the gate cannot survive, and the PTY
  // branch is where this host produces one -- node-pty reports `{exitCode: null, signal}` for a
  // signalled console, which is exactly the shape a managed agent's console dies in.
  //
  // Without `stream.exited`, this hangs: the process is gone, `exitCode` is null, `subscribe` decides
  // it must still be running, and the late reader waits on a stream that will never say anything.
  const runner = new Runner({ openTerminal: () => fakeTerminal({ exitCode: null, signal: "SIGKILL" }) });
  const handle = await runner.start(spec("setTimeout(() => {}, 30000)"));
  await exitOf(runner, handle.id);   // the early subscriber, so the exit has definitely happened

  const late = await Promise.race([
    exitOf(runner, handle.id),
    new Promise((resolve) => setTimeout(() => resolve("NEVER TOLD"), 2000)),
  ]);
  assert.notEqual(
    late, "NEVER TOLD",
    "a subscriber attaching after a NULL-code death was never told it ended -- it is watching a dead "
      + "process on an open stream, which is indistinguishable from watching a thinking one",
  );
  assert.equal(late.code, null);
  assert.equal(late.signal, "SIGKILL");
});
