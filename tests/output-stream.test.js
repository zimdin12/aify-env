#!/usr/bin/env node
// Watching a process's output after it has already started.
//
// This is what unblocks a service delegating its spawns. Start, stop and list are request/response and
// a console is not: it needs output continuously, and it needs whatever was printed BEFORE anyone was
// watching. An agent that prints its prompt during startup and gets a viewer a second later must not
// show an empty pane — that reads as a hung agent, and somebody restarts a perfectly healthy one.
//
// So a subscriber gets a replay and then a live feed. The replay is bounded, because a process that
// runs for a week must not be holding a week of scrollback in the environment's memory.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner } from "../lib/runner.mjs";

// A launcher, not just a marker: aify-env requires a shebang too, because a file that merely QUOTES
// the contract is documentation. These fixtures said "marker" when they meant "launcher".
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));

const spec = (script) => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", script],
});

/** Pipes, explicitly: this file is about buffering and delivery, not about terminals. */
const runner = () => new Runner({ openTerminal: null });

test("a subscriber attached AFTER output was produced still sees it", async () => {
  // The case that matters. Attaching late is the normal case for a console, not the exceptional one.
  const r = runner();
  const handle = await r.start(spec("process.stdout.write('EARLY-OUTPUT')"));
  await handle.exited;

  const seen = [];
  const stop = r.subscribe(handle.id, (chunk) => seen.push(chunk));
  assert.notEqual(stop, null, "a process that has just exited must still be replayable");
  assert.match(seen.join(""), /EARLY-OUTPUT/);
});

test("a subscriber receives output produced after it attached", async () => {
  const r = runner();
  const handle = await r.start(spec("setTimeout(() => process.stdout.write('LATE-OUTPUT'), 60)"));
  const seen = [];
  r.subscribe(handle.id, (chunk) => seen.push(chunk));
  await handle.exited;
  assert.match(seen.join(""), /LATE-OUTPUT/);
});

test("unsubscribing stops delivery, and does not disturb other subscribers", async () => {
  const r = runner();
  const handle = await r.start(spec("setTimeout(() => process.stdout.write('AFTER'), 60)"));
  const leaving = [];
  const staying = [];
  const stop = r.subscribe(handle.id, (chunk) => leaving.push(chunk));
  r.subscribe(handle.id, (chunk) => staying.push(chunk));
  stop();
  await handle.exited;

  assert.doesNotMatch(leaving.join(""), /AFTER/, "an unsubscribed listener kept receiving");
  assert.match(staying.join(""), /AFTER/, "unsubscribing one listener silenced another");
});

test("subscribing to an unknown id returns null rather than pretending", async () => {
  // A caller has to be able to tell "no such process" from "a process that has produced nothing yet",
  // because one is a 404 and the other is an open stream.
  assert.equal(runner().subscribe("never-existed", () => {}), null);
});

test("the replay buffer is BOUNDED", async () => {
  // A process that runs for a week must not have a week of scrollback held in the environment. This is
  // a memory bound on a long-running host, not a nicety.
  const r = new Runner({ openTerminal: null, replayBytes: 256 });
  const handle = await r.start(spec("process.stdout.write('x'.repeat(4000))"));
  await handle.exited;

  const seen = [];
  r.subscribe(handle.id, (chunk) => seen.push(chunk));
  const replayed = seen.join("");
  assert.ok(replayed.length <= 256, `replay was ${replayed.length} bytes, above the 256 cap`);
  assert.ok(replayed.length > 0, "a bounded buffer must still hold something");
});

test("the buffer keeps the MOST RECENT output, not the oldest", async () => {
  // Truncating from the wrong end gives a console the start of a session and none of what is happening
  // now, which is the half nobody needs.
  const r = new Runner({ openTerminal: null, replayBytes: 64 });
  const handle = await r.start(spec("process.stdout.write('A'.repeat(500) + 'THE-END')"));
  await handle.exited;

  const seen = [];
  r.subscribe(handle.id, (chunk) => seen.push(chunk));
  assert.match(seen.join(""), /THE-END/, "the buffer dropped the newest output instead of the oldest");
});

test("a subscriber that THROWS does not stop the process or the other subscribers", async () => {
  // Delivery is best-effort. A broken console must not be able to take down an agent, and this project
  // has a rule about a consumer's failure becoming a producer's failure.
  const r = runner();
  const handle = await r.start(spec("setTimeout(() => process.stdout.write('STILL-DELIVERED'), 60)"));
  const seen = [];
  r.subscribe(handle.id, () => { throw new Error("a broken console"); });
  r.subscribe(handle.id, (chunk) => seen.push(chunk));
  const code = await handle.exited;

  assert.equal(code, 0, "a throwing subscriber affected the process");
  assert.match(seen.join(""), /STILL-DELIVERED/);
});

test("buffers do not outlive the processes they belong to", async () => {
  // Otherwise a long-running environment accumulates one buffer per process it has ever started, which
  // is a leak with a slow fuse.
  const r = runner();
  const handle = await r.start(spec("process.stdout.write('gone')"));
  await handle.exited;
  await r.stop(handle.id);
  assert.equal(r.subscribe(handle.id, () => {}), null, "a stopped process still holds a buffer");
});
