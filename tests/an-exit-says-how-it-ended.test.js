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
