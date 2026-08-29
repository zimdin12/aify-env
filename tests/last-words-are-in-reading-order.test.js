#!/usr/bin/env node
// A dying process's "last words" are text it wrote, in the order it wrote it, or nothing.
//
// WHAT THE OPERATOR SAW, 2026-08-29, in the RECENT EXITS panel:
//
//     last words 31s | voice o f | 1 se sion 2 1 3 2 4 3 5 4 6 5 7 6 8 7 9 8 40 9 1 20 2 1 3 ...
//
// One screen repaint with its geometry removed. "voice of" written in two pieces the cursor moved
// between, and a line-number gutter counting up beside it. Every character real, the ORDER invented.
//
// THE COMMENT ALREADY KNEW. `cleanTail`'s own docstring said "a TUI's last frame is mostly cursor
// moves" and then stripped the moves while keeping every character between them, which is the one
// thing that cannot work: the moves ARE the layout. A field that shows noise under a heading claiming
// it is a message is worse than an empty field, because an operator reads it and tries to make sense
// of it.
//
// THE RULE: text after the LAST cursor reposition, because that is the only part still in reading
// order. A program that ends by repainting leaves no last words -- it leaves a picture -- and says so
// by leaving the field empty. A plain non-TUI process contains no addressing and is untouched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProcessRegistry } from "../lib/process-registry.mjs";

const ESC = String.fromCharCode(27);
const NL = String.fromCharCode(10);

/** Put `output` through the exit path and read back what the panel would show. */
function lastWords(output) {
  const registry = new ProcessRegistry();
  const entry = registry.add({ service: "aify-comms", pid: 1 });
  registry.remove(entry.id, { lastOutput: output, reason: "stopped on request" });
  return registry.history.recentExits.at(-1).lastOutput;
}

test("A REPAINT LEAVES NO LAST WORDS, and says so by leaving the field empty", () => {
  // Reconstructed from what the operator's panel printed: two fragments with a cursor move between
  // them, and a gutter. Under the old rule this produced "voice o f 1 se sion 2 3".
  const repaint = `${ESC}[2J${ESC}[1;1Hvoice o${ESC}[3;5Hf${ESC}[4;1H 1 se${ESC}[5;1Hsion 2${ESC}[6;1H 3`;
  assert.equal(lastWords(repaint), "", "a screen repaint was rendered as a sentence");
});

test("but an error printed AFTER the teardown survives, which is the case this field exists for", () => {
  // The useful signal from a TUI process: it clears the screen, restores the cursor, and then prints
  // why it is dying. That text comes after the last reposition and is in order.
  const teardownThenError = `${ESC}[2J${ESC}[1;1H${ESC}[?25hFATAL: provider returned 429`;
  assert.equal(lastWords(teardownThenError), "FATAL: provider returned 429");
});

test("a plain process is untouched, including across newlines", () => {
  // No cursor addressing at all, so the whole tail is in order and the whole tail is kept. An exit
  // code cannot tell a crash from a kill -- on Windows a terminated process and a program that
  // returned 1 are the same number -- and this is the evidence that can.
  assert.equal(
    lastWords(`Traceback (most recent call last):${NL}ValueError: boom`),
    "Traceback (most recent call last): ValueError: boom",
  );
});

test("COLOUR IS NOT A CURSOR MOVE", () => {
  // The distinction the fix turns on. SGR, mode set/reset and device queries leave text in the order
  // it was written, so they are chrome to strip -- not evidence that the order is lost. Treating them
  // as repositions would empty the field for every program that prints a red error line.
  assert.equal(lastWords(`${ESC}[31mfatal: could not reach the gateway${ESC}[0m`),
    "fatal: could not reach the gateway");
  assert.equal(lastWords(`${ESC}[?25lworking${ESC}[?25h`), "working");
});

test("a one-character remnant is dropped rather than shown as a message", () => {
  // A repaint that happens to end mid-glyph leaves a character or two in order. That answers "crash
  // or kill" no better than nothing does, and printing it under "last words" claims otherwise.
  assert.equal(lastWords(`${ESC}[2J${ESC}[10;40H7`), "");
});

test("a long tail is still clipped to its END", () => {
  // The tail, not the head: what a process said last is what says how it died. Unchanged behaviour,
  // asserted here because the slice now happens after a different starting point and an off-by-one
  // would silently start clipping from the wrong place.
  const long = `${"x".repeat(500)}THE-LAST-THING`;
  const words = lastWords(long);
  assert.ok(words.endsWith("THE-LAST-THING"), words.slice(-40));
  assert.ok(words.length <= 200);
});

test("nothing at all is still nothing, not a crash", () => {
  assert.equal(lastWords(""), "");
  assert.equal(lastWords(undefined), "");
  assert.equal(lastWords(`${ESC}[2J${ESC}[1;1H`), "");
});
