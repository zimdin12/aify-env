#!/usr/bin/env node
// Writing to a process, and resizing its terminal.
//
// The last two things a console needs that aify-env could not do. Without them a delegated agent can
// be watched but not typed at, which is a viewer rather than a console — and the caller that wants to
// delegate has to keep a local pty around for the writing, which defeats the point of delegating.
//
// RESIZE IS THE ONE WITH A TRAP IN IT. A piped process has no terminal to resize. Accepting the
// request and doing nothing would let a console believe it had set a width, and the agent would keep
// wrapping at whatever the default was, with nothing anywhere saying why. So the answer says whether
// it applied.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner } from "../lib/runner.mjs";

const ALLOWED = 'HARNESS_WRAPPER_VERSION="0.6.0"';

/** Reads a line from stdin and echoes it back, so a write can be OBSERVED rather than assumed. */
const echoSpec = () => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: [
    "-e",
    "process.stdin.setEncoding('utf8');"
    + "process.stdin.on('data', (d) => { process.stdout.write('ECHO:' + d.trim()); process.exit(0); });",
  ],
});

test("input written to a process ARRIVES, observed by what it echoes back", async () => {
  // Asserting the call did not throw would prove nothing: the bytes have to reach the process.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(echoSpec());
  const seen = [];
  runner.subscribe(handle.id, (chunk) => seen.push(chunk));

  const result = runner.write(handle.id, "hello-there\n");
  assert.equal(result.ok, true);
  await handle.exited;
  assert.match(seen.join(""), /ECHO:hello-there/);
});

test("writing to an unknown id is refused, not silently dropped", async () => {
  // A console typing into a process that has gone must be told, or the operator types into a void and
  // concludes the agent is ignoring them.
  const result = new Runner({ openTerminal: null }).write("never-existed", "x");
  assert.equal(result.ok, false);
  assert.match(result.error, /no such process/i);
});

test("writing to a process that has EXITED is refused", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start({
    service: "s",
    fileText: ALLOWED,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
  });
  await handle.exited;
  await runner.stop(handle.id);
  assert.equal(runner.write(handle.id, "x").ok, false);
});

test("resize on a PIPED process reports that it did not apply", async () => {
  // The trap. Accepting it silently lets a console believe it set a width while the agent keeps
  // wrapping at the default, with nothing anywhere saying why.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start({
    service: "s",
    fileText: ALLOWED,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 400)"],
  });
  const result = runner.resize(handle.id, 120, 40);
  assert.equal(result.ok, false);
  assert.match(result.error, /no terminal|not a terminal/i);
  await runner.stop(handle.id);
});

test("resize on a TERMINAL-backed process applies, with the numbers it was given", async () => {
  let resized = null;
  const runner = new Runner({
    openTerminal: () => ({
      pid: 4242,
      onData: () => {},
      onExit: () => {},
      write: () => {},
      kill: () => {},
      resize: (cols, rows) => { resized = { cols, rows }; },
    }),
  });
  const handle = await runner.start(echoSpec());
  const result = runner.resize(handle.id, 120, 40);
  assert.equal(result.ok, true);
  assert.deepEqual(resized, { cols: 120, rows: 40 });
});

test("nonsense dimensions are refused rather than passed through", async () => {
  // A zero or negative winsize has thrown from node-pty's ioctl before, and a console sending one
  // should be told rather than taking the environment down with it.
  let resized = null;
  const runner = new Runner({
    openTerminal: () => ({
      pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {},
      resize: (cols, rows) => { resized = { cols, rows }; },
    }),
  });
  const handle = await runner.start(echoSpec());
  for (const [cols, rows] of [[0, 40], [120, 0], [-1, 10], ["wide", 10], [Infinity, 10]]) {
    assert.equal(runner.resize(handle.id, cols, rows).ok, false, `${cols}x${rows} was accepted`);
  }
  assert.equal(resized, null, "a nonsense size reached the terminal");
});

test("a terminal whose resize THROWS is reported, not propagated", async () => {
  const runner = new Runner({
    openTerminal: () => ({
      pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {},
      resize: () => { throw new Error("TIOCSWINSZ failed"); },
    }),
  });
  const handle = await runner.start(echoSpec());
  const result = runner.resize(handle.id, 100, 30);
  assert.equal(result.ok, false);
  assert.match(result.error, /TIOCSWINSZ/);
});
