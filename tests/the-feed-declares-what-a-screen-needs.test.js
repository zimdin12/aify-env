#!/usr/bin/env node
// A console cannot draw a screen from bytes alone, and until now bytes were all this feed sent.
//
// REVIEW TRACED THE GAP AND IT IS REAL: the runner keeps a capped suffix of output and replays it,
// then subscribes; the SSE route emitted text and exit with no geometry and no truncation flag. Two
// facts a SCREEN needs cannot be inferred from those bytes:
//
//   GEOMETRY. Identical cursor-addressing bytes produce different screens at different widths, and
//   not merely narrower ones -- a row-1 overflow WRAPS onto row 2 and collides with what belongs
//   there. A consumer that guesses the width renders a different and wrong picture, so the width has
//   to come from the side that owns the PTY.
//
//   TRUNCATION. The replay buffer drops its head, which is fine for a LOG and wrong for a SCREEN: the
//   positioned text and SGR state that fell off the front cannot be recovered, so a reconstruction
//   may be confidently wrong. A consumer told this can say "incomplete" rather than draw something
//   authoritative-looking.
//
// REAL PROCESSES, following this suite's own idiom, so the buffer is filled by something that
// actually printed. The geometry case injects `openTerminal`, which is the seam the constructor
// already documents -- a piped process has no terminal and therefore no size, and that is the other
// half of the answer rather than a gap in it.
//
// IT TESTS THE RUNNER'S ANSWER, NOT THE HTTP FRAME. The route serialises `streamMeta` in one line,
// and driving the daemon to check it would mean STARTING one -- which supersedes the operator's
// environment and reaps its workers. What needs proving here is that the facts are right.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Runner } from "../lib/runner.mjs";

const LF = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(LF);

/** Prints `text`, then STAYS ALIVE, so meta is read off a live stream rather than a remembered one. */
const speaksAndStays = (text) => ({
  service: "test-service",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", `process.stdout.write(${JSON.stringify(text)}); setTimeout(() => {}, 3000)`],
});

/** A fake pty, so geometry can be asserted without opening a real terminal in a test. */
function fakeTerminal({ cols = 132, rows = 40 } = {}) {
  const handlers = [];
  return {
    pid: 4242,
    cols,
    rows,
    onData: (fn) => handlers.push(fn),
    onExit: () => {},
    write: () => {},
    kill: () => {},
    resize(nextCols, nextRows) { this.cols = nextCols; this.rows = nextRows; },
  };
}

test("POSITIVE CONTROL: an unknown id has no meta, which is how 404 stays distinguishable", () => {
  // `subscribe` returns null for an unknown id so a route can tell "no such process" from "a process
  // that has produced nothing yet". `streamMeta` has to agree, or the two disagree about existence
  // and a console shows empty for a reason nobody can see.
  const runner = new Runner({ openTerminal: null });
  assert.equal(runner.streamMeta("nothing-here"), null);
});

test("A PIPED PROCESS REPORTS ZERO SIZE, which is a fact rather than a missing value", async () => {
  // The other half of the geometry answer. A console must not record a width for something that has
  // no terminal, and 0 says exactly that -- where a default like 80 would be a number nobody measured.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(speaksAndStays("hello"));
  try {
    const meta = runner.streamMeta(handle.id);
    assert.ok(meta, "a started process reports no meta at all");
    assert.equal(meta.cols, 0);
    assert.equal(meta.rows, 0);
    assert.equal(meta.truncated, false, "a short history was reported as truncated");
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

test("THE PRODUCER'S GEOMETRY IS ON THE WIRE, asked of the pty rather than assumed", async () => {
  const terminal = fakeTerminal({ cols: 132, rows: 40 });
  const runner = new Runner({ openTerminal: () => terminal });
  const handle = await runner.start(speaksAndStays("hello"));
  try {
    const meta = runner.streamMeta(handle.id);
    assert.equal(meta.cols, 132, "a consumer would guess a width and paint a different screen");
    assert.equal(meta.rows, 40);

    // FOLLOWS A RESIZE, because a copy taken at start is stale from the first one. The start path
    // already makes this argument for reading `child.cols` rather than echoing what was requested: a
    // second copy of a number drifts the moment either side changes, and a console told 132 columns
    // while the pty is at 80 reconstructs every wrapped row in the wrong place.
    terminal.resize(80, 24);
    assert.equal(runner.streamMeta(handle.id).cols, 80,
      "the geometry was a stale copy rather than the pty's own size");
    assert.equal(runner.streamMeta(handle.id).rows, 24);
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

test("A TRUNCATED REPLAY SAYS SO, and keeps saying so afterwards", async () => {
  // The cap is tiny here so the loss is reachable without megabytes of output.
  const runner = new Runner({ openTerminal: null, replayBytes: 16 });
  const handle = await runner.start(speaksAndStays("x".repeat(200)));
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(runner.streamMeta(handle.id).truncated, true,
      "the head of the history was dropped and the consumer was never told");

    // STICKY, because the loss is permanent. A later small write does not restore what fell off the
    // front, and a flag that cleared itself would tell a console its baseline was sound.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runner.streamMeta(handle.id).truncated, true, "the truncation flag cleared itself");
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

test("NEGATIVE CONTROL: a replay that FITS is not reported as truncated", async () => {
  // Without this, a flag hardcoded to true would satisfy the test above and make every console
  // permanently report an incomplete screen -- the same lie in the other direction.
  const runner = new Runner({ openTerminal: null, replayBytes: 4096 });
  const handle = await runner.start(speaksAndStays("short"));
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(runner.streamMeta(handle.id).truncated, false);
    assert.equal(runner.streamMeta(handle.id).replayBytes, 4096,
      "the cap is not reported, so a consumer cannot say how much history it has");
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

test("THE FLAG IS SET WHERE THE LOSS HAPPENS, not inferred from a full-looking buffer", async () => {
  // A MUTANT SURVIVED WITHOUT THIS. Replacing the flag with `buffer.length >= replayBytes` passed
  // every other test in this file, because none of them wrote EXACTLY the cap -- and that is the one
  // input where the two answers differ. A history that fits exactly is complete, and a length test
  // calls it truncated: a console would then report an incomplete screen forever, on the run where
  // its baseline happened to be perfect.
  //
  // This is the off-by-one the comment in `runner.mjs` claims to be guarding, and until this test it
  // was a claim rather than a guard.
  const runner = new Runner({ openTerminal: null, replayBytes: 10 });
  const handle = await runner.start(speaksAndStays("0123456789"));
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(runner.streamMeta(handle.id).truncated, false,
      "a history that fit EXACTLY was reported as truncated");
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

test("A RESIZE IS ANNOUNCED, because geometry is a stream and not a fact read once", async () => {
  // REVIEW'S FINDING: `streamMeta` reported the CURRENT size, but nothing told a subscriber when it
  // changed -- so a console that learned the geometry before the replay rendered every row after a
  // resize at the wrong width. Identical bytes wrap differently at a different width, so the
  // reconstruction and the real screen diverge silently from that moment.
  const terminal = fakeTerminal({ cols: 132, rows: 40 });
  const runner = new Runner({ openTerminal: () => terminal });
  const handle = await runner.start(speaksAndStays("hello"));
  try {
    const announced = [];
    const stop = runner.subscribe(handle.id, () => {}, null, (size) => announced.push(size));
    assert.ok(stop, "the subscription was refused");

    assert.deepEqual(runner.resize(handle.id, 80, 24), { ok: true });
    assert.deepEqual(announced, [{ cols: 80, rows: 24 }], "the resize reached no subscriber");

    // AFTER THE PTY TOOK IT, never before. A REFUSED resize must not tell a console the geometry
    // changed, or it reflows a screen the process is still painting at the old width.
    //
    // TWO KINDS OF REFUSAL, and only one of them was tested first. A rejected ARGUMENT never reaches
    // the pty at all, so an announce placed on the throw path survived that test -- the mutation
    // could not fail. The pty REFUSING a resize it was actually given is the case that matters, and
    // it is the one a real terminal produces.
    const refused = runner.resize(handle.id, -1, 24);
    assert.equal(refused.ok, false);
    assert.equal(announced.length, 1, "a rejected argument was announced anyway");

    terminal.resize = () => { throw new Error("the pty refused"); };
    const threw = runner.resize(handle.id, 90, 28);
    assert.equal(threw.ok, false);
    assert.match(threw.error, /the pty refused/);
    assert.equal(announced.length, 1,
      "a resize the PTY refused was announced, so a console reflowed to a size nothing has");
    terminal.resize = function (cols, rows) { this.cols = cols; this.rows = rows; };

    // AND IT UNSUBSCRIBES WITH THE REST. A console that closed and still received geometry would be
    // holding a reference to a pane that is gone.
    stop();
    runner.resize(handle.id, 100, 30);
    assert.equal(announced.length, 1, "a resize reached an unsubscribed console");
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

test("NEGATIVE CONTROL: a subscriber that wants no geometry still gets its output", async () => {
  // `onResize` is optional like `onExit`, so every consumer written before this is untouched -- one
  // that does not model a screen has no use for a size.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(speaksAndStays("hello"));
  try {
    const seen = [];
    const stop = runner.subscribe(handle.id, (text) => seen.push(text));
    assert.ok(stop, "a two-argument subscribe was refused");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(seen.join("").includes("hello"), "output stopped arriving for an old-style subscriber");
    stop();
  } finally {
    await runner.stop(handle.id).catch(() => {});
  }
});

console.log("the-feed-declares-what-a-screen-needs.test.js: all assertions passed");
