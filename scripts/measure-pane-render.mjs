// What a pane's emulate-and-extract costs, operation by operation.
//
// THE RENDERER HALF OF THE OPERATOR'S GOAL. The frame probe measures the whole dashboard frame; this
// measures the pane inside it -- feeding an agent's bytes into the emulator and pulling the rows back
// out -- which is the work the console pane does and nothing had a number for.
//
// `paneRepaintMs` IS A CADENCE, NOT A BUDGET, and these figures are not compared against it. It is
// 80ms: arriving output coalesces into at most one repaint every 80ms. That is how often a repaint is
// SCHEDULED, which is not an observed end-to-end completion time, and an earlier version of this file
// divided a three-phase sum by it and called the result a fraction of a budget.
//
// THREE OPERATIONS, TIMED SEPARATELY, and they are NOT three stages of one repaint:
//   WRITE     feeding the chunk into the emulator, awaited
//   ROWS      pulling the screen back out
//   COLOUR    the same extraction with SGR read from each cell, which is B5's path
//
// `output-follower.mjs` finishes the parse, THEN notifies progress, and `dashboard.mjs` schedules
// the repaint after -- different lifecycle phases -- and the follower selects ONE `rows({ color })`
// call, so ROWS and COLOUR are ALTERNATIVES rather than stages. Any combined figure below is the
// median of PAIRED per-iteration sums for one of those two paths, never a sum of medians.
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FRAME_OUTPUT, FRAME_UNREADABLE, readFrames } from "../lib/sse-frames.mjs";
import { loadEmulator, ScreenEmulator } from "../lib/screen-emulator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, "..", "tests", "fixtures", "claude-console-sse.raw.txt");
const LF = String.fromCharCode(10);
//: Colour codes, so the two extraction paths can be compared on the TEXT they carry.
const SGR = /\u001b\[[0-9;]*m/g;
const ESC = String.fromCharCode(27);

//: WHAT THE COMMITTED CAPTURE DECODES TO, and what it draws. The row and the text come from the
//: capture's own `ESC[26;1H`, which is one-based, so the text lands on row index 25.
//: The committed artifact itself, so "a real captured frame" is an identity claim this file can
//: actually make. Shape alone (the two counts below) is satisfied by a same-shape substitution.
const CAPTURE_SHA256 = "fc91c6c072b40b8d00af0e89e59a115415783d2ce2773b138d5d9b3cfe4efe1c";
const CAPTURE_FRAMES = 7;
const CAPTURE_CHARS = 562;
const CAPTURE_ROW = 25;
const CAPTURE_TEXT = "thinking with high effort";

//: The CADENCE a pane repaint is scheduled on, from `paneRepaintMs` in `lib/dashboard.mjs`. It is
//: reported for context and nothing below is divided by it.
const CADENCE_MS = 80;
const REPAINTS = 200;

/** The bytes an agent sent, decoded through the pane's own reader and checked against the fixture. */
function capturedFrame() {
  // THE RAW BYTES, hashed before anything is decoded. The frame and character counts pin the
  // capture's SHAPE, and a same-shape substitution passes them -- but this file claims the frame a
  // working agent actually sent, which is an identity claim about the committed artifact.
  // Replacing the fixture is a legitimate thing to do; it is a one-line edit here that says so.
  const rawBytes = readFileSync(CAPTURE);
  const digest = createHash("sha256").update(rawBytes).digest("hex");
  const { frames, carry } = readFrames("", rawBytes.toString("utf8"));
  const output = frames.filter((frame) => frame?.type === FRAME_OUTPUT);
  const text = output.map((frame) => frame.text).join("");
  const problems = [];
  if (digest !== CAPTURE_SHA256) {
    problems.push(`the capture is not the committed artifact: sha256 ${digest.slice(0, 16)}... `
      + `against the expected ${CAPTURE_SHA256.slice(0, 16)}...`);
  }
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

/** One pane geometry, with each operation timed separately -- they are not one repaint. */
class Pane {
  constructor({ cols, rows }) {
    this.cols = cols;
    this.rows = rows;
    this.writeMs = [];
    this.rowsMs = [];
    this.colourMs = [];
    // PAIRED PER ITERATION, because adding two independent medians is not the median of the sum --
    // review's anticorrelated carrier printed 100.1ms from two 50ms medians while every joined
    // iteration was 50.2ms.
    this.plainPathMs = [];
    this.colourPathMs = [];
    this.notApplied = 0;
    this.contentlessExtractions = 0;
    this.pathsDisagreed = 0;
    this.emptyExtractions = 0;
    this.foreignInTimed = 0;
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
        // EVERY RETURN VALUE IS CHECKED, outside the bracket that timed it. `write` answers whether
        // it APPLIED, and the extractions answer with the screen -- all three were discarded, so
        // 200 writes returning false, or 200 extractions returning [], published four geometries.
        const write = await this.#timeAsync(() => screen.write(chunk));
        if (!write.value) this.notApplied += 1;

        const plain = this.#time(() => screen.rows());
        const colour = this.#time(() => screen.rows({ color: true }));
        for (const extraction of [plain, colour]) {
          if (!Array.isArray(extraction.value) || extraction.value.length !== this.rows) {
            this.emptyExtractions += 1;
            continue;
          }
          const joined = extraction.value.join(LF);
          if (joined.includes("<never-written-by-any-pane>")) {
            this.foreignInTimed += 1;
            continue;
          }
          // SHAPE IS NOT A SCREEN ORACLE. A full-height array of blanks, or of unrelated text, has
          // the right length and says nothing -- review published all four geometries with every
          // timed extraction returning `Array(height).fill('')`. What the capture actually paints is
          // known, so it is asked for: the marker text, on the row its cursor addressing puts it on.
          //
          // ONLY WHERE THE PANE CAN SHOW IT, and only against the CONTENT rather than by redrawing
          // the first screen 200 times -- this capture is not idempotent, so re-establishing the
          // first state per iteration would measure a different thing.
          if (this.rows > CAPTURE_ROW
              && !String(extraction.value[CAPTURE_ROW] || "").includes(CAPTURE_TEXT)) {
            this.contentlessExtractions += 1;
            continue;
          }
          // AND THE TWO PATHS MUST AGREE ON WHAT IS ON THE SCREEN. They are alternatives over one
          // buffer, so a coloured extraction whose text differs from the plain one is not the same
          // screen with SGR added -- it is a different answer.
          if (extraction === colour) {
            const strippedColour = joined.replace(SGR, "");
            const strippedPlain = plain.value.join(LF).replace(SGR, "");
            if (strippedColour !== strippedPlain) this.pathsDisagreed += 1;
          }
        }

        this.writeMs.push(write.ms);
        this.rowsMs.push(plain.ms);
        this.colourMs.push(colour.ms);
        // THE TWO PATHS, EACH PAIRED WITH ITS OWN WRITE. The follower selects ONE `rows({ color })`
        // call -- they are alternatives, not stages -- so a path is a write plus one extraction.
        this.plainPathMs.push(write.ms + plain.ms);
        this.colourPathMs.push(write.ms + colour.ms);
      }
      // AND THE EXTRACTION STILL PRODUCES A SCREEN AT THE END, so the timed loop did not leave the
      // emulator in a state where `rows()` returns nothing.
      const painted = screen.rows();
      this.stillPainting = painted.length === this.rows
        && painted.some((row) => String(row || "").trim() !== "");
    } finally {
      screen.dispose();
    }
    for (const list of [this.writeMs, this.rowsMs, this.colourMs,
                        this.plainPathMs, this.colourPathMs]) {
      this.bad += list.filter((ms) => !Number.isFinite(ms) || ms <= 0).length;
      list.sort((a, b) => a - b);
    }
  }

  /** Time the work AND hand back what it returned, so the caller can judge it outside the bracket. */
  #time(work) {
    const started = process.hrtime.bigint();
    const value = work();
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
  }

  /** The WAIT, not the parse: what a repaint spends before the screen is readable. */
  async #timeAsync(work) {
    const started = process.hrtime.bigint();
    const value = await work();
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
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

const rows = [`WHAT A PANE'S EMULATE-AND-EXTRACT COSTS. \`paneRepaintMs\` is ${CADENCE_MS}ms, which is`,
  "the CADENCE a repaint is scheduled on -- not an observed end-to-end completion budget, and these",
  "are not compared against it.",
  "",
  "  pane        write p50    plain p50   colour p50   write+plain   write+colour",
  "              (awaited)    (extract)   (extract     (PAIRED per   (PAIRED per",
  "                                        + SGR)       iteration)    iteration)"];
const refusals = [];

for (const pane of PANES) {
  await pane.run(CHUNK);
  const write = percentile(pane.writeMs, 0.5);
  const plain = percentile(pane.rowsMs, 0.5);
  const colour = percentile(pane.colourMs, 0.5);
  // THE COMBINED FIGURES ARE MEDIANS OF PAIRED SUMS, not sums of medians. Adding two independent
  // p50s is not the p50 of the sum: review's anticorrelated carrier printed 100.1ms from two 50ms
  // medians while every joined iteration was 50.2ms.
  const plainPath = percentile(pane.plainPathMs, 0.5);
  const colourPath = percentile(pane.colourPathMs, 0.5);
  rows.push(`  ${`${pane.cols}x${pane.rows}`.padEnd(10)}  ${write.toFixed(4).padStart(9)}  `
    + `${plain.toFixed(4).padStart(11)}  ${colour.toFixed(4).padStart(11)}  `
    + `${plainPath.toFixed(4).padStart(12)}  ${colourPath.toFixed(4).padStart(13)}`);
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
  if (pane.notApplied) {
    refusals.push(`${pane.cols}x${pane.rows}: ${pane.notApplied} timed write(s) reported that they `
      + `did NOT apply, so the emulator did not take the bytes those samples timed`);
  }
  if (pane.emptyExtractions) {
    refusals.push(`${pane.cols}x${pane.rows}: ${pane.emptyExtractions} timed extraction(s) did not `
      + `return a full ${pane.rows}-row screen, so those samples timed something that produced `
      + `nothing`);
  }
  if (pane.contentlessExtractions) {
    refusals.push(`${pane.cols}x${pane.rows}: ${pane.contentlessExtractions} timed extraction(s) `
      + `returned a full screen that does NOT carry the capture's own text at row ${CAPTURE_ROW}, `
      + `so the right SHAPE was timed and the wrong CONTENT`);
  }
  if (pane.pathsDisagreed) {
    refusals.push(`${pane.cols}x${pane.rows}: ${pane.pathsDisagreed} coloured extraction(s) carried `
      + `different text from the plain one over the same buffer, so they are not one screen`);
  }
  if (pane.foreignInTimed) {
    refusals.push(`${pane.cols}x${pane.rows}: a string no pane wrote appeared in `
      + `${pane.foreignInTimed} timed extraction(s)`);
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
  console.log("");
  console.log("WITHDRAWN: \"one repaint is a fifth of its budget\". That summed the write, the plain "
    + "extraction and the coloured one, and the real path does none of that: `output-follower.mjs` "
    + "finishes the parse, THEN notifies progress, and `dashboard.mjs` schedules the repaint after -- "
    + "different lifecycle phases -- and the follower selects ONE `rows({ color })` call, so plain "
    + "and coloured are ALTERNATIVES rather than stages. The two paired columns are the two "
    + "alternatives; neither is compared against the cadence, which is not a completion budget.");
  console.log("WHAT THIS IS NOT: the cost of DRAWING those rows into a terminal, which is the frame "
    + "probe's subject, nor a browser. This is the pane's own emulate-and-extract, which is the work "
    + "that had no number.");
}
