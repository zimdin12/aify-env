#!/usr/bin/env node
// Whether a byte stream has told the terminal to hide text.
//
// THE MEASUREMENT THAT PRODUCED THIS FILE, 2026-09-08, against the real @xterm/headless 5.5.0:
//
//   input   ESC[8m  CR  SYNTHETIC_HIDDEN
//   oracle  ["", "", "", ""]          -- a real terminal shows four blank rows
//   pane    ["SYNTHETIC_HIDDEN"]      -- the line buffer printed the token
//
// The history was COMPLETE. Nothing was truncated, there were no cursor commands, and the daemon's
// `truncated: false` was honest -- so every gate written for the two earlier conceal disclosures
// passed it. What none of them measures is whether a line model can render these bytes.
//
// WHY THE BUFFER CANNOT ANSWER IT FOR ITSELF: `splitChunk` gives an escape a column, so the carriage
// return overwrites `ESC[8m` with the first five letters. The retained line contains no conceal at
// all. The question has to be asked of the stream on the way in.
//
// THE FALSE POSITIVE IS THE OTHER HALF. `ESC[38:5:8m` is palette colour 8, an ordinary grey, and a
// scan that found "8" in it would refuse every pane using that colour -- gutting the log path to
// close a disclosure. Both directions are controlled here in the same run.

import assert from "node:assert/strict";
import test from "node:test";

import { scanForConceal } from "../lib/conceal-scan.mjs";

const ESC = String.fromCharCode(27);

test("POSITIVE CONTROL: the sequence that disclosed is detected", () => {
  assert.equal(scanForConceal(`${ESC}[8m${String.fromCharCode(13)}SYNTHETIC_HIDDEN`).conceals, true);
});

test("CONCEAL IS FOUND WHEREVER IT SITS IN A COMPOUND SGR", () => {
  // `ESC[1;8;31m` is bold, conceal, red -- one sequence, three attributes. A scan that only read the
  // first parameter would miss every real-world use, because nothing sets conceal on its own.
  for (const sequence of [`${ESC}[8m`, `${ESC}[1;8m`, `${ESC}[8;31m`, `${ESC}[1;8;31m`, `${ESC}[08m`, `${ESC}[0;08;1m`]) {
    assert.equal(scanForConceal(`before${sequence}after`).conceals, true, `${JSON.stringify(sequence)} was missed`);
  }
});

test("A PALETTE COLOUR OF 8 IS NOT A CONCEAL, or the log path is gutted to close a disclosure", () => {
  // `38:5:8` and `48:5:8` select colour index 8 as a SUB-parameter. Splitting on `;` alone and
  // looking for "8" calls both a conceal, and an ordinary grey log becomes an unreadable pane.
  for (const sequence of [`${ESC}[38:5:8m`, `${ESC}[48:5:8m`, `${ESC}[1;38:5:8m`, `${ESC}[38:2:8:8:8m`]) {
    assert.equal(scanForConceal(`grey${sequence}text`).conceals, false, `${JSON.stringify(sequence)} was called a conceal`);
  }
});

test("NEGATIVE CONTROL: ordinary output and ordinary escapes conceal nothing", () => {
  // Without this, a scanner returning true for everything satisfies every assertion above and
  // refuses every pane on the host.
  for (const text of ["plain text", "", `${ESC}[31mred${ESC}[0m`, `${ESC}[2J`, `${ESC}[12;40H`,
    `${ESC}[K`, `${ESC}[?25l`, `${ESC}c`, `${ESC}[18m`, `${ESC}[80m`, `${ESC}[88m`]) {
    assert.equal(scanForConceal(text).conceals, false, `${JSON.stringify(text)} was called a conceal`);
  }
});

test("A PRIVATE SEQUENCE IS NOT AN SGR", () => {
  // `ESC[?8m` is a private-mode form, not the attribute stream. Reading it as one would refuse panes
  // for a sequence that never touched visibility.
  // THE COMPOUND FORM IS THE ONE THAT REACHES THE GUARD. `ESC[?8m` is refused by the numeric test
  // alone -- `?8` is not digits -- so a test using only that shape proves nothing about the leading
  // marker check. `ESC[?1;8m` splits into `?1` and `8`, and the second group IS digits.
  for (const sequence of [`${ESC}[?8m`, `${ESC}[>8m`, `${ESC}[=8m`, `${ESC}[<8m`,
    `${ESC}[?1;8m`, `${ESC}[>0;8m`, `${ESC}[=1;8;2m`]) {
    assert.equal(scanForConceal(sequence).conceals, false, `${JSON.stringify(sequence)} was read as an SGR`);
  }
});

test("A SEQUENCE SPLIT ACROSS CHUNKS IS STILL ONE SEQUENCE", () => {
  // A read boundary is arbitrary. `ESC[` then `8m` is two ordinary chunks and one conceal, and a
  // scanner that judged each chunk alone would be defeated by a timing accident.
  let pending = "";
  let seen = false;
  for (const chunk of [`${ESC}[`, "8", "m", "SECRET"]) {
    const result = scanForConceal(chunk, pending);
    pending = result.pending;
    seen = seen || result.conceals;
  }
  assert.equal(seen, true, "a conceal split across four chunks was missed");
});

test("THE CARRY IS BOUNDED, so a stream of lone escapes cannot grow it", () => {
  // An unterminated CSI is carried whole. Without a cap, a process emitting `ESC[` and never a final
  // byte would accumulate its whole output in this string.
  let pending = "";
  for (let i = 0; i < 50; i += 1) pending = scanForConceal(`${ESC}[${"1".repeat(20)}`, pending).pending;
  assert.ok(pending.length <= 64, `the carry grew to ${pending.length}`);
  // POSITIVE CONTROL: a carry that was dropped for length still lets the NEXT sequence be found.
  assert.equal(scanForConceal(`${ESC}[8m`, pending).conceals, true);
});

test("A LONE ESC AT THE END OF A CHUNK IS CARRIED, not misread", () => {
  const first = scanForConceal(`text${ESC}`);
  assert.equal(first.conceals, false);
  assert.equal(scanForConceal("[8m", first.pending).conceals, true);
});

test("A NON-CSI ESCAPE IS SKIPPED WITHOUT SWALLOWING WHAT FOLLOWS", () => {
  // `ESC c` is a reset, two characters, no CSI. A scanner that hunted for the next final byte from
  // there would consume the real sequence after it.
  assert.equal(scanForConceal(`${ESC}c${ESC}[8m`).conceals, true);
  assert.equal(scanForConceal(`${ESC}(B${ESC}[31m`).conceals, false);
});

console.log("conceal-scan.test.js: all assertions passed");
