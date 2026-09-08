// The buffer between a process's output stream and a pane's rows.
//
// THE CASES THAT MATTER ARE THE UGLY ONES. Bytes arrive in chunks with no relationship to lines, a
// coding agent's spinner rewrites one line with carriage returns rather than printing new ones, and
// the pane is a fixed column in a side-by-side layout, so nothing may be wider than its budget.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_LINES, MAX_LINE_COLUMNS, PaneBuffer, splitChunk } from "../lib/pane-buffer.mjs";

//: Control characters by CODE POINT. Typing them into source makes the file grep as binary --
//: including the comment saying so, which this repo has been caught by before.
const ESC = String.fromCharCode(27);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

// -- splitChunk ----------------------------------------------------------------------------------

test("a chunk of whole lines splits into them, with nothing carried", () => {
  assert.deepEqual(splitChunk("", "a\nb\nc\n"),
    { lines: ["a", "b", "c"], carry: { text: "", col: 0 } });
});

test("A LINE SPLIT ACROSS CHUNKS is one line, not two", () => {
  // The whole reason this is a carry rather than a per-chunk split. A socket can deliver "hel" and
  // "lo\n" and a pane that showed "hel" then "lo" would be reporting something nobody printed.
  const first = splitChunk("", "hel");
  assert.deepEqual(first, { lines: [], carry: { text: "hel", col: 3 } });
  const second = splitChunk(first.carry, "lo\n");
  assert.deepEqual(second, { lines: ["hello"], carry: { text: "", col: 0 } });
});

test("a line split across THREE chunks still arrives once", () => {
  let carry = "";
  const out = [];
  for (const chunk of ["one ", "two ", "three\n"]) {
    const step = splitChunk(carry, chunk);
    carry = step.carry;
    out.push(...step.lines);
  }
  assert.deepEqual(out, ["one two three"]);
  assert.equal(carry.text, "");
});

test("a trailing partial line is carried, never emitted early", () => {
  assert.deepEqual(splitChunk("", "done\nwaiting"),
    { lines: ["done"], carry: { text: "waiting", col: 7 } });
});

test("CARRIAGE RETURN REWRITES THE LINE -- it does not end one", () => {
  // A spinner emits `\rWorking. \rWorking..` and means ONE line drawn twice. Treating \r as a break
  // turns a quiet agent into an endless scroll that pushes real output out of a small ring, which is
  // exactly what a pane cannot afford.
  const { lines, carry } = splitChunk("", "Working.\rWorking..\rWorking...");
  assert.deepEqual(lines, []);
  assert.equal(carry.text, "Working...");
});

test("CRLF ends a line WITH its content -- the cursor moved, it did not erase", () => {
  assert.deepEqual(splitChunk("", "a\r\nb\r\n"),
    { lines: ["a", "b"], carry: { text: "", col: 0 } });
});

test("a carriage return OVERWRITES across a chunk boundary, leaving the tail it did not cover", () => {
  // I first asserted this yields "Done", on the assumption that \r clears the line. It does not: a
  // terminal moves the cursor to column 0 and what follows overwrites character by character, so the
  // four characters of "Done" land on "Work" and "ing." survives.
  //
  // "Doneing." is genuinely what an operator sees in a real console, and it is the visible symptom of
  // a process that redrew a line with something shorter. Tidying it away here would mean the pane
  // disagreed with the terminal about what the process printed, which is worse than an ugly line.
  assert.deepEqual(splitChunk("Working.", "\rDone\n"),
    { lines: ["Doneing."], carry: { text: "", col: 0 } });
});

test("a CRLF SPLIT ACROSS CHUNKS still ends the line with its content", () => {
  // The reason the carry carries a column at all. With a wipe model the \r at the end of one packet
  // erased the line before the \n in the next could end it, so every CRLF line arriving on a boundary
  // came out EMPTY -- silent, and only on Windows processes.
  const first = splitChunk("", "value\r");
  assert.deepEqual(first.lines, []);
  const second = splitChunk(first.carry, "\nnext");
  assert.deepEqual(second.lines, ["value"]);
});

test("empty lines are real lines and are kept", () => {
  // Blank lines are how output is spaced. Dropping them would silently reflow what a process printed.
  assert.deepEqual(splitChunk("", "a\n\n\nb\n").lines, ["a", "", "", "b"]);
});

test("junk arguments do not throw and do not invent content", () => {
  const empty = { lines: [], carry: { text: "", col: 0 } };
  assert.deepEqual(splitChunk(null, null), empty);
  assert.deepEqual(splitChunk(undefined, undefined), empty);
  assert.deepEqual(splitChunk("", ""), empty);
});

// -- PaneBuffer ----------------------------------------------------------------------------------

test("it shows the BOTTOM of the output, which is where a console is read", () => {
  const buf = new PaneBuffer();
  buf.append("1\n2\n3\n4\n5\n");
  assert.deepEqual(buf.view({ height: 3, width: 80 }), ["3", "4", "5"]);
});

test("fewer lines than the pane is fine -- it does not pad to height", () => {
  // Padding is the layout's job, and doing it here would mean a pane could not tell "two lines of
  // output" from "two lines and three blank ones the process actually printed".
  const buf = new PaneBuffer();
  buf.append("only\n");
  assert.deepEqual(buf.view({ height: 5, width: 80 }), ["only"]);
});

test("THE UNTERMINATED LINE IS SHOWN, or a waiting prompt looks like a dead console", () => {
  // An agent that printed "Continue? [y/N] " and is waiting has emitted no newline for it. Holding it
  // back hides the question at exactly the moment it is being asked.
  const buf = new PaneBuffer();
  buf.append("done\nContinue? [y/N] ");
  assert.deepEqual(buf.view({ height: 4, width: 80 }), ["done", "Continue? [y/N] "]);
});

test("the unterminated line is REPLACED in place when the rest arrives, not appended", () => {
  const buf = new PaneBuffer();
  buf.append("hel");
  assert.deepEqual(buf.view({ height: 4, width: 80 }), ["hel"]);
  buf.append("lo\n");
  assert.deepEqual(buf.view({ height: 4, width: 80 }), ["hello"]);
});

test("A CHATTY PROCESS CANNOT GROW THE BUFFER -- the ring is bounded", () => {
  // Unbounded here is a leak with a delay on it, and what it leaks is whatever the busiest agent on
  // the host is saying.
  const buf = new PaneBuffer({ maxLines: 10 });
  for (let i = 0; i < 1000; i += 1) buf.append(`line ${i}\n`);
  assert.equal(buf.lines.length, 10);
  assert.deepEqual(buf.view({ height: 3, width: 80 }), ["line 997", "line 998", "line 999"]);
});

test("the ring trims correctly when ONE chunk overflows it by itself", () => {
  // The trim has to survive a single append carrying more lines than the whole budget -- a replayed
  // buffer on first subscribe does exactly that.
  const buf = new PaneBuffer({ maxLines: 3 });
  buf.append("a\nb\nc\nd\ne\n");
  assert.deepEqual(buf.lines, ["c", "d", "e"]);
});

test("a nonsense maxLines falls back rather than producing a zero-length ring", () => {
  // A ring of 0 would silently show nothing at all, which reads as a broken process.
  for (const bad of [0, -5, NaN, null, undefined, "lots"]) {
    const buf = new PaneBuffer({ maxLines: bad });
    assert.ok(buf.maxLines >= 1, `maxLines ${String(bad)} gave ${buf.maxLines}`);
  }
  assert.equal(new PaneBuffer().maxLines, DEFAULT_MAX_LINES);
});

test("lines are CLIPPED to the pane width, never wrapped", () => {
  // A pane is one column of a side-by-side layout. A wrapped line would push its own rows out of
  // alignment with the pane beside it, so the divider stops being a straight line.
  const buf = new PaneBuffer();
  buf.append(`${"x".repeat(200)}\n`);
  const [line] = buf.view({ height: 1, width: 20 });
  assert.equal(line.length, 20);
});

test("A CLIPPED COLOUR IS CLOSED, so it cannot bleed into the divider", () => {
  // clipToWidth walks escapes atomically and appends a reset if it cut inside one. Without it the
  // colour tints the divider and the whole pane beside it.
  const buf = new PaneBuffer();
  buf.append(`[31m${"y".repeat(50)}[0m\n`);
  const [line] = buf.view({ height: 1, width: 10 });
  assert.ok(line.endsWith("[0m"), "the cut line closes its colour");
});

test("an escape costs no columns, so colour does not steal room from text", () => {
  const buf = new PaneBuffer();
  buf.append("[31mabcde[0m\n");
  const [line] = buf.view({ height: 1, width: 5 });
  assert.ok(line.includes("abcde"), `all five printable characters survive: ${JSON.stringify(line)}`);
});

test("a height of zero shows nothing and does not throw", () => {
  const buf = new PaneBuffer();
  buf.append("a\nb\n");
  assert.deepEqual(buf.view({ height: 0, width: 80 }), []);
});

test("length counts the unterminated line, because view would show it", () => {
  const buf = new PaneBuffer();
  assert.equal(buf.length, 0);
  buf.append("a\n");
  assert.equal(buf.length, 1);
  buf.append("partial");
  assert.equal(buf.length, 2);
});

test("clear forgets everything INCLUDING the carry", () => {
  // A pane re-pointed at another process must not show half a line from the last one.
  const buf = new PaneBuffer();
  buf.append("a\nleftover");
  buf.clear();
  assert.equal(buf.length, 0);
  assert.deepEqual(buf.view({ height: 5, width: 80 }), []);
  buf.append("fresh\n");
  assert.deepEqual(buf.view({ height: 5, width: 80 }), ["fresh"]);
});

test("append returns the buffer, so a replay and the live feed chain", () => {
  const buf = new PaneBuffer();
  assert.equal(buf.append("a\n"), buf);
  assert.equal(buf.clear(), buf);
});


// -- a real screen, when somebody built one ------------------------------------------------------
//
// The pane refuses to draw a painted process as lines, and has done since the operator saw
// `Cited file didn't exist.—eflaggedCtheTbrokentpointer` -- text from different screen positions
// concatenated onto one row. That refusal stands. What is new is that a caller can now HAND IT A
// SCREEN, built by an emulator it owns, and the pane draws that instead.
//
// THE SCREEN IS PASSED IN, NOT BUILT HERE, so this file keeps its one dependency and every rule below
// is a literal. The emulator is optional and lives elsewhere; this is only about which of three
// different things the pane says.

test("A SOUND SCREEN IS DRAWN, which is the whole point of the emulator", () => {
  const buffer = new PaneBuffer();
  buffer.append(`${ESC}[2;1Hpainted`);
  assert.equal(buffer.isPainting(), true, "precondition: this buffer holds a painted screen");

  const screen = { rows: ["FIRST", "  second"], problem: "" };
  assert.deepEqual(buffer.view({ height: 6, width: 40, screen }), ["FIRST", "  second"]);
});

test("AN UNSOUND SCREEN IS NOT DRAWN, and the pane says what it is waiting for", () => {
  // A picture reconstructed from a truncated history is coherent-looking and possibly wrong.
  // Wrong-looking-right is worse than blank in a console, because an operator reads a screen to
  // decide what an agent is doing.
  const buffer = new PaneBuffer();
  buffer.append(`${ESC}[2;1Hpainted`);
  const screen = { rows: ["MISLEADING"], problem: "waiting for the first full repaint" };
  const view = buffer.view({ height: 6, width: 60, screen, agent: "sc-coder" });

  assert.ok(!view.join(" ").includes("MISLEADING"), "an untrusted screen was drawn anyway");
  assert.match(view[0], /waiting for the first full repaint/);
  assert.match(view.join(" "), /aify-env attach sc-coder/, "a wait with no way round it is a dead end");
});

test("it distinguishes 'nothing painted yet' from 'a partial screen'", () => {
  // The two look identical on screen and are different problems: one resolves by waiting, the other
  // might not. An operator staring at a pane deserves to know which they are in.
  const buffer = new PaneBuffer();
  buffer.append(`${ESC}[2;1Hpainted`);
  const problem = "waiting for the first full repaint";

  const blank = buffer.view({ height: 6, width: 60, screen: { rows: ["", "   "], problem } });
  assert.match(blank.join(" "), /nothing painted yet/);

  const partial = buffer.view({ height: 6, width: 60, screen: { rows: ["", "some output"], problem } });
  assert.match(partial.join(" "), /a partial screen so far/);
});

test("WITH NO SCREEN AT ALL the pane says exactly what it always said", () => {
  // The emulator is OPTIONAL. On a machine without it this path is the whole feature, and it must not
  // have changed a byte -- so this compares against the notice rather than describing it.
  const buffer = new PaneBuffer();
  buffer.append(`${ESC}[2;1Hpainted`);
  const view = buffer.view({ height: 6, width: 60, agent: "sc-coder" });
  assert.deepEqual(view, [
    "live TUI — this pane cannot draw it",
    "run: aify-env attach sc-coder",
  ]);
});

test("A NON-PAINTING PROCESS IGNORES THE SCREEN ENTIRELY", () => {
  // A plain log needs no emulator and must not get one: handing it a screen must change nothing, or
  // every ordinary process would start rendering through a path it never needed.
  const buffer = new PaneBuffer();
  buffer.append(`one${LF}two${LF}`);
  const withScreen = buffer.view({ height: 6, width: 40, screen: { rows: ["WRONG"], problem: "" } });
  const without = buffer.view({ height: 6, width: 40 });
  assert.deepEqual(withScreen, without, "a log was rendered through the screen path");
  assert.deepEqual(without, ["one", "two"]);
});

test("a screen is clipped to the pane, like every other row", () => {
  const buffer = new PaneBuffer();
  buffer.append(`${ESC}[2;1Hpainted`);
  const rows = ["r1", "r2", "r3", "r4", "r5"];
  const view = buffer.view({ height: 3, width: 40, screen: { rows, problem: "" } });
  assert.deepEqual(view, ["r1", "r2", "r3"]);
});


// -- an unterminated line is bounded too ----------------------------------------------------------

test("A LINE THAT NEVER ENDS IS CAPPED, because maxLines bounds LINES and not bytes", () => {
  // MEASURED BY REVIEW: 100,000 code units retained with `maxLines: 1`. A coding agent painting a
  // screen is exactly this shape -- cursor moves and carriage returns, newlines rarely -- so it is
  // the ordinary case for the thing this pane exists to show, not a pathological one.
  const buffer = new PaneBuffer({ maxLines: 1 });
  buffer.append("x".repeat(100_000));
  assert.equal(buffer.carry.text.length, MAX_LINE_COLUMNS,
    `an unterminated line retained ${buffer.carry.text.length} code units`);
});

test("THE COLUMN KEEPS COUNTING PAST THE CAP, which is what makes discarding safe", () => {
  // Truncating the TEXT is only correct if the position is still honest: a repaint returns to column
  // 0 and overwrites from there, and it has to land exactly where it would have.
  const buffer = new PaneBuffer({ maxLines: 2 });
  buffer.append("x".repeat(100_000));
  assert.equal(buffer.carry.col, 100_000, "the column stopped counting, so a repaint would misplace");

  buffer.append(`${CR}REPAINTED`);
  assert.match(buffer.view({ height: 2, width: 20 })[0], /^REPAINTED/,
    "a carriage-return repaint did not land at column 0");
});

test("NEGATIVE CONTROL: an ordinary line is untouched by the cap", () => {
  // The cap is far past any terminal width. If it were reachable by normal output it would be
  // corrupting every console instead of bounding a pathological one.
  const buffer = new PaneBuffer();
  buffer.append(`a normal line${LF}`);
  assert.deepEqual(buffer.view({ height: 2, width: 40 }), ["a normal line"]);
  assert.ok(MAX_LINE_COLUMNS > 1000, "the cap is narrow enough to reach in ordinary use");
});

console.log("pane-buffer.test.js: all assertions passed");

// ── the cap counted the wrong units ──────────────────────────────────────────────────────────────
//
// MEASURED at `maxLines: 1`: 100,000 ASCII characters retained 4,096 UTF-16 units, and 20,000 emoji
// retained 20,001 -- five times the cap, from a stream a fifth the size. A bound that holds only for
// Latin text is not a bound; it is a bound with a locale attached.
//
// THE MECHANISM: `for...of` walks CODE POINTS, `String.length` and `slice` count UTF-16 UNITS. With
// an emoji at every column `col` was N while `current.length` was 2N, so the OVERWRITE branch --
// which is not the one the cap guards -- ran for ever, and each write replaced one unit with a
// two-unit character. The line grew by one unit per character and never reached the append-only cap.

test("THE LINE CAP HOLDS FOR EVERY SCRIPT, not just for Latin text", () => {
  const retained = (text) => {
    const buffer = new PaneBuffer({ maxLines: 1 });
    buffer.append(text);
    return [...buffer.carry.text].length;
  };
  // POSITIVE CONTROL: the case that always worked still works, so a cap that stopped applying at all
  // could not satisfy this block.
  assert.equal(retained("x".repeat(100_000)), MAX_LINE_COLUMNS);
  for (const [name, ch] of [["emoji", "\u{1F600}"], ["CJK", "漢"], ["accented", "é"], ["combining", "é"]]) {
    const held = retained(ch.repeat(20_000));
    assert.ok(held <= MAX_LINE_COLUMNS, `${name}: retained ${held} cells against a cap of ${MAX_LINE_COLUMNS}`);
  }
});

test("AND THE MEMORY IT COSTS IS BOUNDED TOO, which is what the cap is for", () => {
  // Code points are the unit of the model; UTF-16 units are the unit of the memory. One code point
  // is at most two units, so the cap in cells implies a cap in units -- and that implication is the
  // only reason a cell cap is a memory bound at all.
  const buffer = new PaneBuffer({ maxLines: 1 });
  buffer.append("\u{1F600}".repeat(20_000));
  assert.ok(buffer.carry.text.length <= MAX_LINE_COLUMNS * 2,
    `retained ${buffer.carry.text.length} UTF-16 units`);
});

test("A CARRIAGE RETURN OVERWRITES WIDE CHARACTERS BY CELL, not by unit", () => {
  // The same defect from the visible end. Overwriting one UTF-16 unit of a surrogate pair leaves the
  // other half behind, which is a lone surrogate on the operator's screen -- and the column count
  // drifts from what they can see with every character after it.
  const buffer = new PaneBuffer({ maxLines: 5 });
  buffer.append(`\u{1F600}\u{1F600}\u{1F600}${CR}AB${LF}`);
  assert.deepEqual(buffer.view({ height: 3, width: 40, screen: { problem: "" } }), ["AB\u{1F600}"]);
});

test("A COLUMN IS A CODE POINT WHEN THE CARRY ARRIVES AS A BARE STRING", () => {
  // `splitChunk` accepts a string carry and derives the column from it. Derived from `.length`, the
  // cursor starts at TWICE the real column on a line of emoji -- and once that doubled number passes
  // the cap, every further character is silently discarded while the line is still half empty. The
  // tail of the line simply vanishes.
  //
  // A CARRIAGE RETURN HIDES THIS, which is why the first version of this test proved nothing: CR
  // sets the column to 0 whatever it was, so the wrong derivation never gets to matter. A mutant
  // restoring `.length` survived it.
  const wide = "\u{1F600}".repeat(3000);
  const { carry } = splitChunk(wide, "TAIL");
  assert.equal([...carry.text].length, 3004, "characters were dropped while the line was under the cap");
  assert.ok(carry.text.endsWith("TAIL"));
  // POSITIVE CONTROL: the same call with ASCII, where both derivations agree, still appends.
  assert.ok(splitChunk("x".repeat(3000), "TAIL").carry.text.endsWith("TAIL"));
});
