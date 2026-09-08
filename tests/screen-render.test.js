#!/usr/bin/env node
// Shaping an emulated screen into the lines a pane prints.
//
// NO EMULATOR HERE, deliberately. These are literals, so this file runs and means the same thing on a
// machine where `@xterm/headless` was never installed -- which is the case the optional dependency
// exists for. The buffer arithmetic that DOES need the real thing lives in `screen-emulator.mjs` and
// is tested there.

import assert from "node:assert/strict";
import test from "node:test";

import { screenIsBlank, screenLines } from "../lib/screen-render.mjs";

const ESC = String.fromCharCode(27);
//: Visible text only. Built from a code point rather than typed, because a raw ESC in a source
//: string makes the file grep as binary -- including the comment explaining why.
//: The `[` is escaped for the REGEX, which a template literal quietly undoes -- `\[` there is just
//: `[`, so the pattern became a character class containing `[` and matched by luck. A normal string
//: keeps the backslash, so the bracket stays literal.
const stripEscapes = (text) => String(text).replace(new RegExp(ESC + "\\[[0-9;]*[a-zA-Z]", "g"), "");

test("POSITIVE CONTROL: a painted screen comes back as its rows, in order", () => {
  // Without this every assertion below could be satisfied by a function that returns nothing.
  const rows = ["FIRST", "second", "    indented third"];
  assert.deepEqual(screenLines(rows, { width: 40, height: 10 }), rows);
});

test("TRAILING blanks go: fifteen empty rows tell the reader nothing", () => {
  // A 20-row screen with five rows of content is the ordinary case for an agent that has just
  // started, and printing the emptiness fills the pane with it.
  const rows = ["one", "two", "", "   ", "", ""];
  assert.deepEqual(screenLines(rows, { width: 20, height: 10 }), ["one", "two"]);
});

test("LEADING blanks STAY, and that asymmetry is the whole rule", () => {
  // Vertical position is meaning on a painted screen -- an agent's status line sits where it sits.
  // Trimming the top would move the picture, which is the one thing a renderer must not do.
  const rows = ["", "", "status: working"];
  assert.deepEqual(screenLines(rows, { width: 40, height: 10 }), ["", "", "status: working"]);
});

test("a gap in the MIDDLE survives", () => {
  // Only a trailing run is droppable. A blank row between two painted ones is part of the picture.
  const rows = ["header", "", "body", ""];
  assert.deepEqual(screenLines(rows, { width: 40, height: 10 }), ["header", "", "body"]);
});

test("NEGATIVE CONTROL: an all-blank screen yields no lines", () => {
  // And the predicate below is what lets the caller say something true about that, rather than
  // printing an empty pane that reads as broken.
  assert.deepEqual(screenLines(["", "  ", ""], { width: 40, height: 10 }), []);
  assert.equal(screenIsBlank(["", "  ", ""]), true);
});

test("screenIsBlank answers from the ROWS, not from what fits", () => {
  // A screen whose only content sits below the pane's height is blank TO THE READER and not blank to
  // the emulator. Answering this from `screenLines` would report "empty" for a picture that exists,
  // and the caller would then say so.
  const rows = ["", "", "", "", "here"];
  assert.equal(screenIsBlank(rows), false, "this screen has content and must not read as empty");
  assert.deepEqual(screenLines(rows, { width: 40, height: 3 }), [],
    "the visible part is genuinely empty, which is a different fact");
});

test("the screen is CROPPED from the top when it is taller than the pane", () => {
  // The emulator runs at the PRODUCER's geometry, so this is the ordinary case rather than a
  // wrong-size one: a 26-row agent screen in a 20-row pane. Which part to crop belongs to the caller;
  // this function takes what it is handed and does not guess.
  const rows = ["r1", "r2", "r3", "r4", "r5"];
  assert.deepEqual(screenLines(rows, { width: 40, height: 3 }), ["r1", "r2", "r3"]);
});

test("rows are clipped by VISIBLE COLUMNS, not by character count", () => {
  // Measuring with `.length` counts an SGR run as visible columns, so a coloured row loses as many
  // characters as its escapes cost -- the pane then renders short, and a wide character renders LONG
  // and shifts every line below it.
  //
  // THE FIRST VERSION OF THIS TEST WAS VACUOUS and a mutant survived it. It asserted that the result
  // still contained "green" and no longer contained "runs past" -- both true of `.slice(0, 10)`,
  // because `ESC[32m` is exactly five characters and the slice happened to keep five more. Asserting
  // on CONTENT could not tell the two apart. Visible width can.
  const visibleWidth = (text) => stripEscapes(text).length;
  const coloured = `${ESC}[32mgreen text that runs past the edge${ESC}[0m`;
  const [line] = screenLines([coloured], { width: 10, height: 5 });
  assert.equal(visibleWidth(line), 10,
    `clipped to ${visibleWidth(line)} visible columns rather than 10 -- the escapes were counted`);
  assert.ok(line.length > 10, "the escapes were stripped rather than preserved");
});

test("a missing or non-string row is an empty one, not a crash", () => {
  // `getLine` returns undefined past the end of the buffer, and the emulator hands rows straight
  // through. A renderer that throws on that takes the whole view down.
  assert.deepEqual(screenLines(["a", null, undefined, "b"], { width: 10, height: 10 }),
    ["a", "", "", "b"]);
  assert.equal(screenIsBlank([null, undefined]), true);
});

test("a zero-sized pane asks for nothing", () => {
  // `composeConsole` can hand out a zero body height on a very short terminal, and a renderer that
  // returned a row anyway would be written onto a line the layout did not budget for.
  assert.deepEqual(screenLines(["x"], { width: 0, height: 10 }), []);
  assert.deepEqual(screenLines(["x"], { width: 10, height: 0 }), []);
  assert.deepEqual(screenLines(["x"], {}), ["x"], "defaults must still render");
});

test("nothing at all is no lines, and blank", () => {
  assert.deepEqual(screenLines(undefined, { width: 10, height: 5 }), []);
  assert.deepEqual(screenLines([], { width: 10, height: 5 }), []);
  assert.equal(screenIsBlank([]), true);
  assert.equal(screenIsBlank(undefined), true);
});

console.log("screen-render.test.js: all assertions passed");
