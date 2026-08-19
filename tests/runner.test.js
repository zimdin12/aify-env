#!/usr/bin/env node
// Owning a process: starting it, streaming it, knowing when it is gone.
//
// Two execution paths, and the difference matters to a consumer rather than being an implementation
// detail. A PTY gives a real terminal, which is what a web console needs to render a TUI at all; piped
// stdio gives the output and none of the terminal. The runner prefers a PTY and falls back, and it
// says which it got rather than leaving a caller to infer it from output that looks slightly wrong.
//
// EVERY TEST HERE NAMES THE PATH IT WANTS. `openTerminal: null` means pipes, an injected fake means the
// terminal branch. Leaving it to whether node-pty happens to be installed would make this suite a
// report about the machine it runs on — and it did: these tests were green before node-pty existed
// here, and adding it made the file hang.
//
// The REAL terminal is verified in pty-real.test.js, out of process. It has to be out of process
// because a node-pty child on Windows leaves a PipeWrap behind after it exits, so anything that spawns
// one never exits by itself. That is a real leak, not a test artifact; see README.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner, terminalSupport } from "../lib/runner.mjs";
import { ProcessRegistry } from "../lib/process-registry.mjs";

const ALLOWED = 'HARNESS_WRAPPER_VERSION="0.6.0"';

/**
 * A stand-in for what node-pty returns. It proves the runner takes the terminal BRANCH and wires the
 * right callbacks, and it exits cleanly, which a real one does not. node-pty itself is verified in
 * pty-real.test.js.
 */
function fakeTerminal() {
  const onData = [];
  const onExit = [];
  const term = {
    pid: 4242,
    onData: (cb) => onData.push(cb),
    onExit: (cb) => onExit.push(cb),
    write: () => {},
    kill: () => onExit.forEach((cb) => cb({ exitCode: 0 })),
  };
  // After the runner has wired its callbacks, which it does synchronously once this returns.
  setTimeout(() => {
    onData.forEach((cb) => cb("fake-terminal-output"));
    onExit.forEach((cb) => cb({ exitCode: 0 }));
  }, 5);
  return term;
}

/** A spec whose file content passes the allowlist, running a real, harmless command. */
const echoSpec = (text) => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
});

test("terminalSupport gives a DEFINITE answer, never a shrug", () => {
  // "We could not tell" is the answer that lets a caller assume the good case. Either it is available
  // or there is a reason it is not.
  const support = terminalSupport();
  assert.equal(typeof support.available, "boolean");
  if (!support.available) assert.ok(support.reason.length > 0, "unavailable must carry a reason");
});

test("a started process appears in the registry with a pid, and leaves when it exits", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(echoSpec("hello"));
  assert.ok(handle.pid > 0, "no pid");
  assert.deepEqual(runner.list().map((p) => p.id), [handle.id]);

  await handle.exited;
  assert.deepEqual(runner.list(), [], "an exited process is still owned");
});

test("output is streamed to a consumer", async () => {
  const runner = new Runner({ openTerminal: null });
  const chunks = [];
  const handle = await runner.start(echoSpec("streamed-output"));
  handle.onOutput((chunk) => chunks.push(chunk));
  await handle.exited;
  assert.match(chunks.join(""), /streamed-output/);
});

test("a file the allowlist refuses NEVER reaches spawn", async () => {
  // The allowlist is only a guard if nothing can start without passing it. A test that merely checks
  // the predicate leaves the guard unwired, which is the same as not having it.
  let spawned = false;
  const runner = new Runner({ spawnProcess: () => { spawned = true; } });
  await assert.rejects(
    () => runner.start({ service: "s", fileText: "#!/bin/bash\nrm -rf /\n", command: "x", args: [] }),
    /marker/i,
  );
  assert.equal(spawned, false, "a refused file was spawned anyway");
  assert.deepEqual(runner.list(), []);
});

test("the terminal path is taken when a terminal factory is available", async () => {
  // Injected rather than real: this proves the BRANCH and the callback wiring, deterministically and
  // without leaving a handle behind. node-pty itself is verified out of process.
  let usedTerminal = false;
  const runner = new Runner({
    openTerminal: () => {
      usedTerminal = true;
      return fakeTerminal();
    },
  });
  const handle = await runner.start(echoSpec("via-pty"));
  assert.equal(usedTerminal, true, "a terminal was available and was not used");
  assert.equal(handle.terminal, true, "the handle must say which path it got");
  await handle.exited;
});

test("without a terminal the runner still starts, and SAYS it fell back", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(echoSpec("via-pipe"));
  assert.equal(handle.terminal, false, "the handle must not claim a terminal it did not get");
  await handle.exited;
});

test("stop() is idempotent and leaves the registry empty", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start({
    service: "test-service",
    fileText: ALLOWED,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  await runner.stop(handle.id);
  await runner.stop(handle.id);
  await runner.stop("never-existed");
  assert.deepEqual(runner.list(), []);
});

test("two services' processes are both owned, and each knows whose it is", async () => {
  const runner = new Runner({ openTerminal: null });
  const a = await runner.start({ ...echoSpec("a"), service: "aify-comms" });
  const b = await runner.start({ ...echoSpec("b"), service: "aify-graph" });
  const owners = runner.list().map((p) => p.service).sort();
  assert.deepEqual(owners, ["aify-comms", "aify-graph"]);
  await Promise.all([a.exited, b.exited]);
});

// ── the registry itself ──────────────────────────────────────────────────────────

test("the registry hands out distinct ids", () => {
  const registry = new ProcessRegistry();
  const ids = new Set();
  for (let i = 0; i < 100; i += 1) ids.add(registry.add({ service: "s", pid: i }).id);
  assert.equal(ids.size, 100);
});

test("removing an unknown id is a no-op, not an error", () => {
  const registry = new ProcessRegistry();
  registry.remove("nope");
  assert.deepEqual(registry.list(), []);
});

test("list() returns a COPY, so a caller cannot mutate the registry through it", () => {
  const registry = new ProcessRegistry();
  registry.add({ service: "s", pid: 1 });
  registry.list().length = 0;
  assert.equal(registry.list().length, 1);
});
