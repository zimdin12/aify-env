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

// A launcher, not just a marker: aify-env requires a shebang too, because a file that merely QUOTES
// the contract is documentation. These fixtures said "marker" when they meant "launcher".
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

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

// ── and the size a process is BORN at, which is a different question ─────────────────────────────
//
// Resizing was covered above and start was not, so a requested start size was carried all the way
// from the service and dropped one frame short of the pty. Nothing failed: the terminal was simply
// never the size anyone asked for, and every consumer downstream reasoned from a width that was
// never true. It is the "computed, transmitted, and read by nobody" shape, on a field with a caller.

test("THE SIZE A PROCESS IS STARTED AT REACHES THE PTY", async () => {
  // `#spawnChild` passed `{ cwd, env }` only. A caller asking for 157 columns got the opener's
  // default instead, silently and on every spawn.
  let opened = null;
  const runner = new Runner({
    openTerminal: (command, args, options) => {
      opened = options;
      return { pid: 7, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {}, resize: () => {} };
    },
  });
  await runner.start({ ...echoSpec(), cols: 157, rows: 40 });
  assert.equal(opened.cols, 157, "the requested width never reached the terminal");
  assert.equal(opened.rows, 40, "the requested height never reached the terminal");
});

test("an UNKNOWN size is omitted, so the opener's own default still applies", async () => {
  // THE SUBTLETY THAT MAKES THE OBVIOUS FIX WRONG. Callers send `0` for "I do not know"
  // (`Number(control.cols) || Number(launch.cols) || 0`), and the opener defaults with
  // `options?.cols ?? 120` -- `??` substitutes for null and undefined but NOT for zero. Forwarding
  // the zero would replace a sane default with a ZERO-WIDTH pty, which is worse than the bug. The
  // key must be absent, not present and falsy.
  let opened = null;
  const runner = new Runner({
    openTerminal: (command, args, options) => {
      opened = options;
      return { pid: 8, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {}, resize: () => {} };
    },
  });
  await runner.start({ ...echoSpec(), cols: 0, rows: 0 });
  assert.ok(!("cols" in opened), "a zero width was forwarded, so the opener cannot default");
  assert.ok(!("rows" in opened), "a zero height was forwarded, so the opener cannot default");
});

test("the opener still receives cwd and env, which this change must not have displaced", async () => {
  // The spread that adds the size sits beside them, and a mistake there would be invisible to both
  // assertions above while breaking every spawn's environment.
  let opened = null;
  const runner = new Runner({
    openTerminal: (command, args, options) => {
      opened = options;
      return { pid: 9, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {}, resize: () => {} };
    },
  });
  await runner.start({ ...echoSpec(), cwd: "C:/work", env: { MARKER: "kept" }, cols: 100 });
  assert.equal(opened.cwd, "C:/work");
  assert.equal(opened.env.MARKER, "kept");
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
