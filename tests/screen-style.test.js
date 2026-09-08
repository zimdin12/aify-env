#!/usr/bin/env node
// Turning a cell's appearance back into the escape that produced it.
//
// A SCREEN WITHOUT COLOUR IS READABLE AND WRONG. Coding agents use colour to say what the text does
// not -- red for a failure, dim for what has scrolled past, inverse for a selection -- and a pane
// that flattens it shows the operator a picture with its emphasis removed.
//
// LITERALS, NOT AN EMULATOR. Everything below `styleFrom` works on a plain object, so these rules
// hold on a machine where the optional dependency was never installed. `styleFrom` itself is checked
// against the REAL cell API in `screen-emulator.test.js`, where the installed arm runs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT, PALETTE, PLAIN, RESET, RGB, sameStyle, sgrBetween, styleFrom,
} from "../lib/screen-style.mjs";

const ESC = String.fromCharCode(27);
const style = (over = {}) => ({ ...PLAIN, ...over });
const fg = (kind, value) => style({ fg: { kind, value } });

test("POSITIVE CONTROL: a change produces an escape, so the tests below are not measuring silence", () => {
  assert.notEqual(sgrBetween(PLAIN, fg(PALETTE, 2)), "");
  assert.match(sgrBetween(PLAIN, fg(PALETTE, 2)), /^\[/);
});

test("NOTHING CHANGED MEANS NOTHING EMITTED, which is the whole cost argument", () => {
  // A 132-column row with an SGR before every character is kilobytes of escapes for 132 glyphs,
  // redrawn every refresh, per pane. Emitting on change is what the process itself does.
  assert.equal(sgrBetween(PLAIN, PLAIN), "");
  assert.equal(sgrBetween(fg(PALETTE, 2), fg(PALETTE, 2)), "");
  assert.equal(sgrBetween(style({ bold: true }), style({ bold: true })), "");
});

test("RETURNING TO PLAIN IS A RESET, not a restatement of every default", () => {
  assert.equal(sgrBetween(fg(PALETTE, 1), PLAIN), RESET);
  assert.equal(sgrBetween(style({ bold: true, italic: true }), PLAIN), RESET);
});

test("THE LOW SIXTEEN USE THEIR SHORT FORMS, and the rest use the long one", () => {
  // Correctness would allow `38;5;n` for all of them. The short form is what the process sent and
  // keeps the common case small, which matters when this is re-emitted on every refresh.
  assert.equal(sgrBetween(PLAIN, fg(PALETTE, 2)), `${ESC}[0;32;49m`, "green is not 32");
  assert.equal(sgrBetween(PLAIN, fg(PALETTE, 9)), `${ESC}[0;91;49m`, "bright red is not 91");
  assert.equal(sgrBetween(PLAIN, fg(PALETTE, 208)), `${ESC}[0;38;5;208;49m`, "256-colour is not 38;5;n");
});

test("A 24-BIT COLOUR IS UNPACKED, because the cell API hands it over packed", () => {
  // 660510 is 0x0A141E, which is rgb(10, 20, 30). Carrying it as one number and unpacking here is
  // the shape the emulator actually provides; a test that used three fields would be describing an
  // API nothing has.
  assert.equal(sgrBetween(PLAIN, fg(RGB, 660510)), `${ESC}[0;38;2;10;20;30;49m`);
});

test("A BACKGROUND IS ITS OWN RANGE, and default is 39/49 rather than absent", () => {
  // Omitting the default would leave a previous colour standing, which is precisely the bug that
  // makes one agent's red bleed onto the next row.
  assert.equal(sgrBetween(PLAIN, style({ bg: { kind: PALETTE, value: 4 } })), `${ESC}[0;39;44m`);
  assert.equal(sgrBetween(PLAIN, style({ bg: { kind: RGB, value: 0x102030 } })),
    `${ESC}[0;39;48;2;16;32;48m`);
});

test("ATTRIBUTES ARE RESTATED IN FULL, which is why turning one OFF needs no rule of its own", () => {
  // Bold off is `22`, not `1` -- a different code from the one that turned it on -- and a rule per
  // attribute per direction is a table nobody can check. Emitting `0` and then the whole style makes
  // `sameStyle` the only thing that has to be right.
  const boldItalic = style({ bold: true, italic: true });
  assert.equal(sgrBetween(PLAIN, boldItalic), `${ESC}[0;1;3;39;49m`);
  assert.equal(sgrBetween(boldItalic, style({ italic: true })), `${ESC}[0;3;39;49m`,
    "dropping bold restated the style incorrectly");
});

test("sameStyle compares APPEARANCE, not identity", () => {
  assert.equal(sameStyle(fg(PALETTE, 2), fg(PALETTE, 2)), true);
  assert.equal(sameStyle(fg(PALETTE, 2), fg(PALETTE, 3)), false);
  assert.equal(sameStyle(fg(PALETTE, 2), fg(RGB, 2)), false, "a palette 2 is not an RGB 2");
  assert.equal(sameStyle(PLAIN, style({ underline: true })), false);
  assert.equal(sameStyle(null, PLAIN), false);
});

test("BIT FLAGS ARE TRUTHY, NOT TRUE, and reading them strictly would silently render nothing", () => {
  // MEASURED on the real package: `isBold()` returned 134217728. A `=== true` test would find no
  // styling anywhere, and the failure would look exactly like a screen that happens to be unstyled.
  const flagged = styleFrom({
    isBold: () => 134217728,
    isFgDefault: () => false,
    isFgRGB: () => false,
    getFgColor: () => 1,
    isBgDefault: () => true,
  });
  assert.equal(flagged.bold, true, "a bit-flag attribute was read as false");
  assert.equal(flagged.fg.kind, PALETTE);
  assert.equal(flagged.fg.value, 1);
});

test("A CELL MISSING A PREDICATE LOSES AN ATTRIBUTE, not the whole view", () => {
  // A cell object comes from a third-party package. A version that dropped one of these would take
  // the operator's view down rather than render one thing less, which is not a trade worth making.
  const sparse = styleFrom({ isFgDefault: () => true, isBgDefault: () => true });
  assert.equal(sameStyle(sparse, PLAIN), true);
  assert.equal(styleFrom(null), PLAIN);
  assert.equal(styleFrom(undefined), PLAIN);
});

test("a default colour reports as DEFAULT rather than as index 0, which is black", () => {
  // Collapsing them would paint every unstyled cell black on a terminal whose background is not.
  const plain = styleFrom({ isFgDefault: () => true, isBgDefault: () => true });
  assert.equal(plain.fg.kind, DEFAULT);
  assert.equal(plain.bg.kind, DEFAULT);
});

console.log("screen-style.test.js: all assertions passed");
