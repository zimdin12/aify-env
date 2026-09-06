#!/usr/bin/env node
// What a keypress in the DAEMON'S OWN terminal is allowed to do.
//
// THE EXPENSIVE ONE IS Ctrl+C. Raw mode stops it becoming SIGINT -- it arrives as a byte -- so the
// moment this view took a keyboard, the daemon's only stop key went through the key router. Getting
// it wrong has two shapes and both are bad: swallow it, and an operator cannot stop the environment
// from the terminal they started it in; or map it to the same action as `q`, and one stray keystroke
// reaps every managed agent on the host.
//
// That is exactly why this screen had NO keyboard until 2026-09-06 -- and why the fix was to split
// the action rather than to pick one of the two wrongs.
//
// THIS IS TESTABLE AT ALL because the wiring moved out of `bin/aify-env.mjs`, which cannot be
// imported: importing it STARTS a daemon, which supersedes the operator's and reaps its workers.
// That has cost this project a live fleet twice, so every rule here used to be a comment nothing
// could execute, pinned only by a regex over the source.

import assert from "node:assert/strict";
import { test } from "node:test";

import { startDaemonView } from "../lib/daemon-view.mjs";

const tty = (extra = {}) => ({ isTTY: true, columns: 120, rows: 40, ...extra });
const pipe = () => ({ isTTY: false });

/** Captures what `startDashboard` was handed, without starting anything. */
function spy(result = { stop: () => {} }) {
  const calls = [];
  return {
    calls,
    start: async (options) => { calls.push(options); return result; },
  };
}

test("POSITIVE CONTROL: with a screen and a keyboard, a view is actually started", async () => {
  // Every assertion below reads options out of `calls[0]`. A function that started nothing would
  // make each of them fail loudly rather than pass vacuously -- but the DECLINING tests further down
  // are satisfied by exactly that, so this pins the difference.
  const s = spy();
  const view = await startDaemonView({
    endpoint: "http://127.0.0.1:8802", registryPath: "reg.json",
    stdout: tty(), stdin: tty(), start: s.start,
  });
  assert.equal(s.calls.length, 1);
  assert.equal(view.ownsScreen, true);
});

test("Ctrl+C runs the DAEMON'S shutdown, not a view's exit", async () => {
  // Routed through the same `shutdown` the signal handlers call. A second teardown path is the
  // defect this repo already removed once: node runs every listener, so the winner was whichever
  // reached process.exit first -- and that was the one stopping nothing.
  const s = spy();
  const stopped = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(),
    shutdown: (why) => { stopped.push(why); }, start: s.start,
  });
  assert.equal(typeof s.calls[0].onInterrupt, "function", "Ctrl+C reaches nothing");
  s.calls[0].onInterrupt();
  assert.deepEqual(stopped, ["keyboard"], "Ctrl+C did not stop the environment");
});

test("`q` IS NOT WIRED, and that is what stops a stray keystroke reaping the fleet", async () => {
  // There is no view to leave here: this screen belongs to the running daemon, so "quit" could only
  // mean stopping it -- and that is Ctrl+C's job, held to one key nobody presses by accident.
  //
  // `dashboard.mjs` falls back to `onQuit` when no `onInterrupt` is given, so passing an `onQuit`
  // here would ALSO be the thing that makes `q` stop the environment. Its absence is load-bearing
  // twice over.
  const s = spy();
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(),
    shutdown: () => { throw new Error("q must not be able to reach the shutdown"); },
    start: s.start,
  });
  assert.equal(s.calls[0].onQuit, undefined, "the daemon offered a quit key");
});

test("keystrokes go straight to the runner, not over our own loopback port", async () => {
  // This process owns the PTY. Posting to ourselves would add a round-trip, a failure mode, and a
  // second place a keystroke could be refused.
  const s = spy();
  const written = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(),
    runner: { write: (id, data) => written.push([id, data]) }, start: s.start,
  });
  s.calls[0].onInput({ id: "p1" }, "hello");
  assert.deepEqual(written, [["p1", "hello"]]);
});

test("a keystroke with nothing selected writes nowhere", async () => {
  const s = spy();
  const written = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(),
    runner: { write: (id, data) => written.push([id, data]) }, start: s.start,
  });
  s.calls[0].onInput(null, "x");
  s.calls[0].onInput({}, "x");
  assert.deepEqual(written, [], "a keystroke was written to a process that was not selected");
});

test("NO KEYBOARD when stdin is a pipe, even though stdout is a screen", async () => {
  // A process whose stdin is a pipe has nothing to put into raw mode, and asking would throw on the
  // first keypress. The view still draws.
  const s = spy();
  const view = await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: pipe(), start: s.start,
  });
  assert.equal(view.ownsScreen, true, "the view should still draw without a keyboard");
  assert.equal(s.calls[0].input, undefined, "raw mode was requested on a pipe");
  assert.equal(s.calls[0].onInterrupt, undefined);
});

test("NO VIEW AT ALL when stdout is redirected", async () => {
  // A service manager, a log file, a test capturing startup: escapes there are noise, and the plain
  // banner is what those readers parse.
  const s = spy();
  const view = await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: pipe(), stdin: tty(), start: s.start,
  });
  assert.equal(s.calls.length, 0);
  assert.equal(view.ownsScreen, false);
});

test("AIFY_NO_DASHBOARD opts a terminal out", async () => {
  const s = spy();
  const view = await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(), enabled: false, start: s.start,
  });
  assert.equal(s.calls.length, 0);
  assert.equal(view.ownsScreen, false);
});

test("a view that CANNOT DRAW does not stop the environment serving", async () => {
  // It is the decoration; the daemon is the product. And `ownsScreen` must go back to false, or the
  // daemon's own log messages would be routed into a notices ring nobody is rendering.
  const said = [];
  const view = await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(),
    start: async () => { throw new Error("no tty here"); },
    write: (line) => said.push(line),
  });
  assert.equal(view.ownsScreen, false, "a failed view still claimed the screen");
  assert.equal(typeof view.stop, "function", "the caller must always get a stop it can call");
  assert.match(said.join(""), /dashboard unavailable/);
});

test("the notices ring and the terminal size are handed to the view", async () => {
  // The ring is where the daemon's own messages go once this owns the screen; without it they land
  // between rendered rows and take the layout apart, which the operator reported on 2026-09-04.
  const s = spy();
  const ring = { recent: () => [] };
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty({ rows: 51, columns: 133 }), stdin: tty(),
    notices: ring, start: s.start,
  });
  assert.equal(s.calls[0].notices, ring, "the view was never given the ring");
  assert.equal(s.calls[0].rows, 51);
  assert.equal(s.calls[0].columns, 133);
});
