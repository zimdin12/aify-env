#!/usr/bin/env node
// The environment remembers HOW its last processes ended, not only WHEN.
//
// WHY THIS EXISTS, and it is an incident rather than a nice-to-have. On 2026-08-26 the operator's
// managed workers died in clusters -- five within three seconds, twice -- and nothing anywhere could
// say how. aify-comms records an exit code and signal now, but on that host the service and the bridge
// are both several days behind and drop the fields before anything stores them. This environment is
// the one tier running the new code AND observing the exit first-hand, from node's own `close` event.
//
// `lastExitAtMs` answered WHEN, which was never the question.
//
// THE THREE ANSWERS MUST STAY APART, all the way down:
//   a SIGNAL     -> something killed it
//   a CODE       -> it stopped on its own, and the number is the evidence (0 included)
//   NEITHER      -> nobody observed the exit; a reaper found a corpse, or a caller asked for a stop
//
// The third is why `#release` records no code at all. Writing a zero there would turn "we found it
// gone" into "it exited cleanly", which is the exact collapse the two fields exist to prevent.

import assert from "node:assert/strict";
import { test } from "node:test";

// `ProcessRegistry.history` is a GETTER and `Runner.history()` is a method that returns it. Both
// spellings appear below on purpose, and getting them the wrong way round is how the first run of this
// file failed -- a reminder that the two are different objects with the same word on them.
import { ProcessRegistry } from "../lib/process-registry.mjs";
import { Runner } from "../lib/runner.mjs";

const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
const spec = (script, label = "") => ({
  service: "aify-comms",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", script],
  label,
});

const lastExit = (runner) => runner.history().recentExits.at(-1);

test("a clean exit is remembered as code 0, with the agent that owned it", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("process.exit(0)", "sc-coder"));
  await handle.exited;
  await new Promise((r) => setTimeout(r, 30));

  const exit = lastExit(runner);
  assert.equal(exit.exitCode, 0, "a clean exit was not recorded as zero");
  assert.equal(exit.exitSignal, "");
  assert.equal(exit.label, "sc-coder", "the exit cannot be attributed to an agent");
  assert.equal(exit.id, handle.id);
  assert.equal(exit.pid, handle.pid);
});

test("a non-zero exit keeps its number", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("process.exit(23)"));
  await handle.exited;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lastExit(runner).exitCode, 23);
});

test("a process killed from outside is not recorded as a clean exit", async () => {
  // THE CASE THE WHOLE THING IS FOR. Whatever this platform reports -- a signal on POSIX, an exit
  // code of 1 on Windows -- it must not look like a job that finished.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("setTimeout(() => {}, 30000)"));
  process.kill(handle.pid, "SIGKILL");
  await handle.exited;
  await new Promise((r) => setTimeout(r, 30));

  const exit = lastExit(runner);
  assert.ok(
    !(exit.exitCode === 0 && !exit.exitSignal),
    `a killed process was recorded as a clean exit: ${JSON.stringify(exit)}`,
  );
  assert.ok(exit.exitCode !== null || exit.exitSignal, "the death was recorded with no detail at all");
});

test("a STOP records no code, because nobody watched it end", () => {
  // `release` and `stop` do not observe an exit. Recording a zero for them would make a reaper's
  // tidy-up indistinguishable from a process that finished its work.
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "aify-comms", pid: 4242, label: "sc-tester" });
  registry.remove(entry.id, { atMs: 1000 });

  const exit = registry.history.recentExits.at(-1);
  assert.equal(exit.exitCode, null, "a stop invented an exit code");
  assert.equal(exit.exitSignal, "");
  assert.equal(exit.label, "sc-tester");
  assert.equal(exit.atMs, 1000);
});

test("the ring is bounded and keeps the NEWEST", () => {
  // A cluster is what this must survive; the observed ones were five and seven. It is a ring for
  // "what just happened", not a log, and it must never become a memory story of its own.
  const registry = new ProcessRegistry();
  for (let i = 0; i < 40; i += 1) {
    const entry = registry.add({ service: "s", pid: i + 1, label: `agent-${i}` });
    registry.remove(entry.id, { atMs: i, exitCode: i });
  }
  const exits = registry.history.recentExits;
  assert.ok(exits.length <= 20, `the ring grew to ${exits.length}`);
  assert.equal(exits.at(-1).exitCode, 39, "the newest exit was dropped");
  assert.equal(exits.at(-1).label, "agent-39");
  assert.ok(exits.every((e) => e.exitCode > 39 - exits.length), "an older exit survived a newer one");
});

test("removing an id it never had records nothing", () => {
  // A reaper must be safe to run twice, and a second pass must not invent a death.
  const registry = new ProcessRegistry();
  registry.remove("p-never", { atMs: 5, exitCode: 0 });
  assert.deepEqual(registry.history.recentExits, []);
});

test("the exits are COPIES, like the process list", () => {
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "s", pid: 1, label: "a" });
  registry.remove(entry.id, { atMs: 1, exitCode: 7 });
  registry.history.recentExits[0].exitCode = 999;
  assert.equal(registry.history.recentExits[0].exitCode, 7, "a reader mutated the registry");
});

// ---------------------------------------------------------------------------------------------
// WHICH PATH REMOVED IT, added after the first real reading of this ring.
//
// The panel showed two deaths as "no exit reported". That was already an answer -- a process that ends
// on its own always arrives through the close event carrying a code or a signal, so those two were
// REMOVED rather than observed exiting. What it could not say was by whom, and "somebody asked for a
// stop" and "the sweep found a corpse" are different incidents with different culprits.
// ---------------------------------------------------------------------------------------------

test("an observed exit is recorded as `exited`, with its code", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec("process.exit(0)"));
  await handle.exited;
  await new Promise((r) => setTimeout(r, 30));
  const exit = lastExit(runner);
  assert.equal(exit.reason, "exited");
  assert.equal(exit.exitCode, 0);
});

test("a STOP is recorded as `stopped`, and a reap as `reaped`", async () => {
  const runner = new Runner({ openTerminal: null });
  const stopped = await runner.start(spec("setTimeout(() => {}, 30000)"));
  await runner.stop(stopped.id);
  assert.equal(lastExit(runner).reason, "stopped", "a requested stop is indistinguishable from a reap");

  const reaped = await runner.start(spec("setTimeout(() => {}, 30000)"));
  runner.release(reaped.id);
  assert.equal(lastExit(runner).reason, "reaped");
  // Neither invented a code: nobody watched either of them end.
  assert.equal(lastExit(runner).exitCode, null);
  process.kill(reaped.pid, "SIGKILL");
});

test("the panel says WHO removed it, not just that nothing was reported", async () => {
  const { renderDashboard } = await import("../lib/tui.mjs");
  const render = (reason) => renderDashboard({
    endpoint: "", version: "0.6.0", services: [], processes: [], unknown: [],
    traffic: { requests: 0, bytesOut: 0 }, nowMs: 1000,
    history: { startedTotal: 1, lastExitAtMs: 900, recentExits: [
      { id: "p1", label: "sc-coder", atMs: 900, exitCode: null, exitSignal: "", reason },
    ] },
  }, { columns: 120, color: false }).join("\n");

  assert.match(render("stopped"), /stopped on request/);
  assert.match(render("reaped"), /found already gone/);
  // And an OLD record, written before the reason existed, still renders rather than disappearing.
  assert.match(render(""), /no exit reported/);
});

// ---------------------------------------------------------------------------------------------
// WHAT IT WAS SAYING WHEN IT WENT.
//
// An exit code cannot tell a crash from a kill. Measured earlier today: on Windows a process
// terminated from outside reports `(1, null)` and so does a program that simply returned 1. Eight of
// the operator's agents died reporting exactly that, and the number alone could not separate the two
// readings. The final bytes usually can -- a stack trace, a provider error, or nothing at all, which
// is itself the signature of an abrupt end.
// ---------------------------------------------------------------------------------------------

test("a process that printed before dying has its last words kept", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec(
    "process.stdout.write('Error: provider refused the request'); process.exit(1)",
  ));
  await handle.exited;
  await new Promise((r) => setTimeout(r, 40));

  const exit = lastExit(runner);
  assert.equal(exit.exitCode, 1);
  assert.match(exit.lastOutput, /provider refused the request/,
    "the exit code says 1 and nothing says why; that is the reading this field exists to improve");
});

test("terminal chrome is stripped so a human can read it", () => {
  const ESC = String.fromCharCode(27);
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "s", pid: 1, label: "a" });
  registry.remove(entry.id, {
    atMs: 1,
    exitCode: 1,
    reason: "exited",
    // A real TUI's last frame: a clear, a colour, the message, a reset, and cursor moves.
    lastOutput: `${ESC}[2J${ESC}[31mfatal: gateway did not become ready${ESC}[0m\r\n   at boot\n`,
  });
  assert.equal(registry.history.recentExits.at(-1).lastOutput,
    "fatal: gateway did not become ready at boot");
});

test("a silent death records an empty string, which is itself the finding", () => {
  // Nothing printed before the end is what an abrupt external kill looks like, and it must be
  // distinguishable from a crash that explained itself.
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "s", pid: 1, label: "a" });
  registry.remove(entry.id, { atMs: 1, exitCode: 1, reason: "exited", lastOutput: "" });
  assert.equal(registry.history.recentExits.at(-1).lastOutput, "");
});

test("the tail is CLIPPED, and keeps the END", () => {
  // A ring must not become a log, and the interesting part of a dying process's output is the last
  // of it -- clipping from the front would keep the boot banner and drop the error.
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "s", pid: 1, label: "a" });
  registry.remove(entry.id, {
    atMs: 1, reason: "exited", exitCode: 1,
    lastOutput: `${"x".repeat(5000)} THE ACTUAL ERROR`,
  });
  const kept = registry.history.recentExits.at(-1).lastOutput;
  assert.ok(kept.length <= 200, `kept ${kept.length} characters`);
  assert.match(kept, /THE ACTUAL ERROR$/, "the clip kept the beginning instead of the end");
});

test("this file's own source carries no raw control bytes", async () => {
  // THREE ATTEMPTS AT THE STRIPPING REGEX put literal escape and control characters into
  // process-registry.mjs -- once inside the comment that was explaining the problem. A source file
  // that greps as binary is a source file nobody can review, so the rule is checked rather than
  // remembered.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../lib/process-registry.mjs", import.meta.url)),
  );
  const control = [...source].filter((b) => b < 9 || (b > 10 && b < 32 && b !== 13));
  assert.deepEqual(control, [], "the registry source contains raw control bytes");
});

test("a REAPED death keeps its last words, even though it has no exit code", async () => {
  // THE ASYMMETRY IS THE POINT. The reaper genuinely does not know the exit code -- nobody watched
  // the process end -- but the OUTPUT is not unknown: it is sitting in the replay buffer that
  // `#release` is about to delete. Dropping it threw away the only evidence a reaped death leaves.
  //
  // Found the hard way on 2026-08-26: two workers died as `found already gone` twelve seconds after a
  // sibling died as `exited 1`, and the panel could show the sibling's final frame and nothing at all
  // for the two that mattered, while their bytes were in memory the whole time.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec(
    "process.stdout.write('the last thing it said'); setTimeout(() => {}, 30000)",
  ));
  await new Promise((r) => setTimeout(r, 120));

  runner.release(handle.id);

  const exit = lastExit(runner);
  assert.equal(exit.reason, "reaped");
  assert.equal(exit.exitCode, null, "a reaped death invented an exit code");
  assert.match(exit.lastOutput, /the last thing it said/,
    "a reaped death lost the only evidence it had");
  process.kill(handle.pid, "SIGKILL");
});

test("a STOP keeps them too, and still claims no code", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(spec(
    "process.stdout.write('mid-frame when stopped'); setTimeout(() => {}, 30000)",
  ));
  await new Promise((r) => setTimeout(r, 120));
  await runner.stop(handle.id);

  const exit = lastExit(runner);
  assert.equal(exit.reason, "stopped");
  assert.equal(exit.exitCode, null);
  assert.match(exit.lastOutput, /mid-frame when stopped/);
});
