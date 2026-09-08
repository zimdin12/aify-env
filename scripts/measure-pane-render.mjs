// What one pane redraw costs, against the budget the pane actually redraws on.
//
// THE RENDERER HALF OF THE OPERATOR'S GOAL. The frame probe measures the whole dashboard frame; this
// measures the pane inside it -- feeding an agent's bytes into the emulator and pulling the rows back
// out -- which is the work the console pane does and nothing had a number for.
//
// THE BUDGET IS REAL, NOT INVENTED. `paneRepaintMs` is 80: arriving output coalesces into at most one
// repaint every 80ms. So the question this answers is whether a repaint fits in the window that
// schedules it, with room for everything else the frame draws.
//
// THREE THINGS ARE TIMED SEPARATELY, because they are different work and only one of them scales
// with what the agent printed:
//   WRITE     feeding the chunk into the emulator, which is xterm's parse
//   ROWS      pulling the screen back out, once per repaint regardless of how much arrived
//   COLOUR    the same extraction with SGR read from each cell, which is B5's path
//
// THE WORKLOAD IS THE COMMITTED CAPTURE, validated before use: 7 output frames and 562 characters,
// decoded through the pane's own reader. An empty, malformed or truncated fixture would otherwise be
// measured as though it were a real frame -- which is exactly what happened to this file's sibling.
//
// CONTROLS, in the same run. POSITIVE: the extracted rows must carry the capture's own text at the
// row its cursor addressing puts it on, or the extraction being timed produced nothing. NEGATIVE: a
// string never written must not appear. And every duration must be positive and finite.
//
// NOTHING REACHES stdout UNLESS EVERY CONTROL HELD.
//
// Run: node scripts/measure-pane-render.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FRAME_OUTPUT, FRAME_UNREADABLE, readFrames } from "../lib/sse-frames.mjs";
import { loadEmulator, ScreenEmulator } from "../lib/screen-emulator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, "..", "tests", "fixtures", "claude-console-sse.raw.txt");
const LF = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

//: WHAT THE COMMITTED CAPTURE DECODES TO, and what it draws. The row and the text come from the
//: capture's own `ESC[26;1H`, which is one-based, so the text lands on row index 25.
const CAPTURE_FRAMES = 7;
const CAPTURE_CHARS = 562;
const CAPTURE_ROW = 25;
const CAPTURE_TEXT = "thinking with high effort";

//: The pane redraw budget, from `paneRepaintMs` in `lib/dashboard.mjs`.
const BUDGET_MS = 80;
const REPAINTS = 200;

/** The bytes an agent sent, decoded through the pane's own reader and checked against the fixture. */
function capturedFrame() {
  const { frames, carry } = readFrames("", readFileSync(CAPTURE, "utf8"));
  const output = frames.filter((frame) => frame?.type === FRAME_OUTPUT);
  const text = output.map((frame) => frame.text).join("");
  const problems = [];
  // UNREADABLE FRAMES FIRST, before anything is filtered away. `readFrames` reports them explicitly,
  // and filtering for FRAME_OUTPUT discarded that report -- so a committed capture with one broken
  // frame appended still decoded to the expected seven frames and 562 characters, and published.
  // A workload with a frame the reader could not parse is not the workload this file names.
  const unreadable = frames.filter((frame) => frame?.type === FRAME_UNREADABLE);
  if (unreadable.length) {
    problems.push(`${unreadable.length} frame(s) could not be read `
      + `(${unreadable.map((frame) => frame.why).join("; ")}), so this capture is damaged`);
  }
  if (String(carry || "").trim()) {
    problems.push(`${String(carry).length} characters were never consumed, so this is a prefix`);
  }
  if (output.length !== CAPTURE_FRAMES || text.length !== CAPTURE_CHARS) {
    problems.push(`the capture decoded to ${output.length} frames and ${text.length} characters, `
      + `not the ${CAPTURE_FRAMES} and ${CAPTURE_CHARS} this fixture holds`);
  }
  if (!text.includes(ESC)) problems.push("the decoded capture carries no ESC byte, so it paints nothing");
  if (problems.length) {
    process.stderr.write(`NOTHING IS PUBLISHED: the captured workload is not usable:${LF}`);
    for (const problem of problems) process.stderr.write(`  - ${problem}${LF}`);
    process.exit(1);
  }
  return text;
}

/** One pane geometry, timed through the three phases a repaint actually performs. */
class Pane {
  constructor({ cols, rows }) {
    this.cols = cols;
    this.rows = rows;
    this.writeMs = [];
    this.rowsMs = [];
    this.colourMs = [];
    this.drewCapture = false;
    this.foreignFound = false;
    this.stillPainting = false;
    this.bad = 0;
  }

  async run(chunk) {
    // THE FACTORY, not the constructor: `create` is the path every caller takes and the one
    // that resolves the optional package.
    const screen = await ScreenEmulator.create({ cols: this.cols, rows: this.rows });
    if (!screen) throw new Error("the emulator is absent, which the caller already checked");
    try {
      // VERIFIED AFTER THE FIRST WRITE, not after two hundred. This capture positions its cursor
      // absolutely, so replaying it repeatedly is not idempotent -- the screen after 201 writes is a
      // different screen, and checking the control there failed on every pane while the extraction
      // was working perfectly. One write is what the capture test asserts about, so it is what this
      // asserts about too.
      // AWAITED. `write` returns a promise -- the parse is deferred -- and reading `rows()`
      // without awaiting returned a blank screen on every pane while the extraction was
      // working perfectly. The control caught it, which is the only reason it was not
      // published as a very fast repaint.
      await screen.write(chunk);
      const first = screen.rows();
      this.drewCapture = this.rows > CAPTURE_ROW
        && String(first[CAPTURE_ROW] || "").includes(CAPTURE_TEXT);
      this.foreignFound = first.join(LF).includes("<never-written-by-any-pane>");

      for (let i = 0; i < REPAINTS; i += 1) {
        this.writeMs.push(await this.#timeAsync(() => screen.write(chunk)));
        this.rowsMs.push(this.#time(() => screen.rows()));
        this.colourMs.push(this.#time(() => screen.rows({ color: true })));
      }
      // AND THE EXTRACTION STILL PRODUCES A SCREEN AT THE END, so the timed loop did not leave the
      // emulator in a state where `rows()` returns nothing.
      const painted = screen.rows();
      this.stillPainting = painted.length === this.rows
        && painted.some((row) => String(row || "").trim() !== "");
    } finally {
      screen.dispose();
    }
    for (const list of [this.writeMs, this.rowsMs, this.colourMs]) {
      this.bad += list.filter((ms) => !Number.isFinite(ms) || ms <= 0).length;
      list.sort((a, b) => a - b);
    }
  }

  #time(work) {
    const started = process.hrtime.bigint();
    work();
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  /** The WAIT, not the parse: what a repaint spends before the screen is readable. */
  async #timeAsync(work) {
    const started = process.hrtime.bigint();
    await work();
    return Number(process.hrtime.bigint() - started) / 1e6;
  }
}

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
}

const deps = await loadEmulator();
if (!deps) {
  process.stderr.write(`NOTHING IS PUBLISHED: @xterm/headless is not installed, so no pane could be `
    + `rendered and there is nothing to measure.${LF}`);
  process.exit(1);
}

const CHUNK = capturedFrame();
// The geometries a console pane actually gets: the dashboard's own default, a wide terminal, and the
// 132x26 the operator's live PTYs report.
const PANES = [new Pane({ cols: 80, rows: 24 }), new Pane({ cols: 132, rows: 26 }),
               new Pane({ cols: 132, rows: 40 }), new Pane({ cols: 200, rows: 50 })];

const rows = [`ONE PANE REPAINT, against the ${BUDGET_MS}ms budget \`paneRepaintMs\` schedules it on`,
  "  pane        write p50   rows p50   colour p50   all three   % of budget",
  "              (AWAITED,   (extract)  (extract +                            ",
  "               floored)               SGR)                                 "];
const refusals = [];

for (const pane of PANES) {
  await pane.run(CHUNK);
  const write = percentile(pane.writeMs, 0.5);
  const plain = percentile(pane.rowsMs, 0.5);
  const colour = percentile(pane.colourMs, 0.5);
  const total = write + plain + colour;
  rows.push(`  ${`${pane.cols}x${pane.rows}`.padEnd(10)}  ${write.toFixed(4).padStart(9)}  `
    + `${plain.toFixed(4).padStart(9)}  ${colour.toFixed(4).padStart(11)}  `
    + `${total.toFixed(4).padStart(9)}  ${(100 * total / BUDGET_MS).toFixed(2).padStart(10)}%`);
  // ONLY WHERE THE CHECK IS AVAILABLE. A 24-row pane cannot show row 25, so demanding it there
  // refuses a pane for being small rather than for being wrong -- and a control that fires on a
  // correct run is one somebody switches off. The panes that CAN be checked are counted below, so
  // "not checked here" never quietly becomes "checked and fine".
  if (pane.rows > CAPTURE_ROW && !pane.drewCapture) {
    refusals.push(`${pane.cols}x${pane.rows}: the extracted screen does not carry the capture's own `
      + `text at row ${CAPTURE_ROW}, so whatever was timed produced nothing`);
  }
  if (pane.foreignFound) {
    refusals.push(`${pane.cols}x${pane.rows}: a string no pane wrote was found on the screen`);
  }
  if (!pane.stillPainting) {
    refusals.push(`${pane.cols}x${pane.rows}: after the timed repaints the extraction no longer `
      + `returns a full, non-empty screen, so the later samples measured something else`);
  }
  if (pane.bad) {
    refusals.push(`${pane.cols}x${pane.rows}: ${pane.bad} timing(s) were zero, negative or not a `
      + `number`);
  }
}

// THE 80x24 PANE CANNOT SHOW ROW 25, so its positive control is expected to be unavailable rather
// than failed -- and saying so is the difference between a control that was checked and one that was
// quietly skipped.
const tooShort = PANES.filter((pane) => pane.rows <= CAPTURE_ROW);
const checked = PANES.filter((pane) => pane.rows > CAPTURE_ROW);
if (!checked.length) {
  refusals.push("no pane was tall enough to show the capture's own row, so nothing verified that "
    + "the extraction produced anything");
}

if (refusals.length) {
  process.stderr.write(`${LF}NOTHING IS PUBLISHED. A number is only a repaint if its controls held:${LF}`);
  for (const line of refusals) process.stderr.write(`  - ${line}${LF}`);
  process.exitCode = 1;
} else {
  for (const row of rows) console.log(row);
  console.log("");
  console.log(`${checked.length} of ${PANES.length} panes are tall enough to show the capture's own `
    + `row ${CAPTURE_ROW} and all of them carry its text there; `
    + `${tooShort.map((p) => `${p.cols}x${p.rows}`).join(", ")} cannot and is not counted as a check.`);
  console.log("WHAT THIS IS NOT: the cost of DRAWING those rows into a terminal, which is the frame "
    + "probe's subject, nor a browser. This is the pane's own emulate-and-extract, which is the work "
    + "that had no number.");
}
