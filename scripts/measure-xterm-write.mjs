// What xterm does with a frame before anything is drawn.
//
// THE HOP, and the half of it this can honestly claim: from `term.write(chunk, done)` to `done`
// firing -- xterm's own signal that the bytes have been PARSED and applied to its buffer. That is
// hop FIVE's first half. The second half is the renderer painting that buffer into a DOM or a
// canvas, plus the browser's own scheduling, and NEITHER is in any number here. `@xterm/headless` is
// the same parser the browser runs with the renderer removed, which is exactly what makes it useful
// for the first half and useless for the second.
//
// WHY THIS IS WORTH MEASURING WITHOUT A BROWSER. Hop five has stood at "not measured, needs a
// browser" while it was the last unexamined suspect for the operator's "the browser terminal kind of
// lags sometimes". Half of it does not need one. If the parse is cheap, the remaining suspect is
// narrowed to rendering and scheduling; if it is expensive, that is an answer nobody had to open a
// browser to get.
//
// THE 64KB ARM IS THE RESYNC WORST CASE, not an arbitrary large number. On a sequence gap the
// dashboard refetches the authoritative buffer and writes it in one go, falling back to the raw
// `output` tail when no snapshot is present -- and that tail is capped at 64KB. So that row is the
// single largest write this path can produce.
//
// THE CONTROLS ARE IN THE SAME RUN. POSITIVE: after each arm the terminal's buffer must CONTAIN a
// marker that arm wrote, or the parse being timed did nothing. NEGATIVE: a marker never written must
// not be found -- a probe that cannot return ABSENT cannot return PRESENT. And a write whose
// callback never fires inside the bound is a REJECTION, counted, never aged against anything else.
//
// NOTHING REACHES stdout UNLESS EVERY CONTROL HELD.
//
// Run: node scripts/measure-xterm-write.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FRAME_OUTPUT, readFrames } from "../lib/sse-frames.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, "..", "tests", "fixtures", "claude-console-sse.raw.txt");
const LF = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
// THE SAME COUNT FOR EVERY ARM, so SIZE is the only thing that differs between them. The 64KB arm
// ran 60 writes to the others' 200 until a mutation exposed the confound: with all four arms set to
// the SAME size the growth ratio still read 2.87x, which can only have come from the write count.
// Per-write amortisation is not independent of how many writes it is averaged over.
const WRITES = 60;
const CALLBACK_TIMEOUT_MS = 2000;

/** The real bytes an agent sent, decoded exactly as the pane's own reader decodes them. */
function realFrame() {
  const { frames } = readFrames("", readFileSync(CAPTURE, "utf8"));
  return frames.filter((frame) => frame?.type === FRAME_OUTPUT).map((frame) => frame.text).join("");
}

/**
 * Painted bytes of a requested size: cursor addressing, colour and text, which is what a TUI sends.
 * Plain text of the same length would measure the cheapest possible parse and call it a frame.
 */
function paintedBytes(targetChars, marker) {
  const parts = [];
  let size = 0;
  let row = 1;
  while (size < targetChars) {
    const line = `${ESC}[${row};1H${ESC}[38;5;${(row % 200) + 16}m`
      + `row ${row} of a full-screen redraw with some content on it${ESC}[0m`;
    parts.push(line);
    size += line.length;
    row = (row % 200) + 1;
  }
  // THE WITNESS GOES LAST, AND ITS FIRST PLACEMENT WAS WRONG. It sat behind `ESC[H`, which is row 1
  // -- the same cell the first painted line addresses -- so every painted arm overwrote its own
  // marker and the run refused to publish. That is the positive control doing exactly its job on the
  // probe itself: the parse HAD happened, and the check that it reached the screen was looking at a
  // cell the payload had since repainted.
  parts.push(`${ESC}[40;1H${marker}`);
  return parts.join("");
}

class Arm {
  constructor({ label, payload, writes = WRITES }) {
    this.label = label;
    this.payload = payload;
    this.writes = writes;
    this.marker = `<${label.replace(/[^a-z0-9]/gi, "")}>`;
    this.ms = [];
    this.parseMs = NaN;
    this.timedOut = 0;
  }

  async run(Terminal) {
    // ONE TERMINAL PER ARM, at the geometry the console actually uses. A terminal reused across arms
    // would carry the previous arm's scrollback and charset state into this one's timings.
    const term = new Terminal({ cols: 132, rows: 40, allowProposedApi: true, scrollback: 1000 });
    const body = this.payload.replace("@@MARKER@@", this.marker);
    try {
      // TWO DIFFERENT QUESTIONS, AND THE FIRST VERSION ANSWERED ONLY ONE OF THEM BY ACCIDENT.
      //
      // LATENCY is one write, awaited: what a browser pays for a single arriving frame. xterm defers
      // its callback to a later turn, so on this host every arm read ~15.4ms whatever its size --
      // the platform's ~15.6ms timer granularity, not the parse. That number is real and belongs
      // here, but it is a property of the SCHEDULER and it swamped the thing being measured.
      //
      // PARSE COST is the whole batch issued back to back with only the LAST callback awaited. The
      // deferral is then paid a handful of times for the run instead of once per write, so what is
      // left is the work.
      for (let i = 0; i < Math.min(this.writes, 20); i += 1) {
        const started = process.hrtime.bigint();
        const settled = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), CALLBACK_TIMEOUT_MS);
          term.write(body, () => { clearTimeout(timer); resolve(true); });
        });
        if (!settled) { this.timedOut += 1; continue; }
        this.ms.push(Number(process.hrtime.bigint() - started) / 1e6);
      }

      const batchStarted = process.hrtime.bigint();
      const finished = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), CALLBACK_TIMEOUT_MS * 10);
        for (let i = 0; i < this.writes; i += 1) {
          if (i === this.writes - 1) term.write(body, () => { clearTimeout(timer); resolve(true); });
          else term.write(body);
        }
      });
      if (!finished) this.timedOut += this.writes;
      else this.parseMs = Number(process.hrtime.bigint() - batchStarted) / 1e6 / this.writes;

      this.ms.sort((a, b) => a - b);
      this.bytes = body.length;
      // THE POSITIVE CONTROL: the parse that was timed has to have reached the buffer.
      this.wroteSomething = screenOf(term).includes(this.marker);
      // AND THE NEGATIVE: a marker of the same shape that no arm ever wrote.
      this.foreignFound = screenOf(term).includes("<neverwrittenbyanyarm>");
    } finally {
      term.dispose();
    }
  }
}

function screenOf(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join(LF);
}

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
}

let Terminal;
try {
  const headless = await import("@xterm/headless");
  ({ Terminal } = headless.default ?? headless);
} catch {
  process.stderr.write(`NOTHING IS PUBLISHED: @xterm/headless is not installed, so nothing parsed `
    + `anything and there is no measurement to report.${LF}`);
  process.exit(1);
}

const REAL = realFrame();
const ARMS = [
  new Arm({ label: "a real captured frame", payload: `@@MARKER@@${REAL}` }),
  new Arm({ label: "painted 1 KB", payload: paintedBytes(1024, "@@MARKER@@") }),
  new Arm({ label: "painted 16 KB", payload: paintedBytes(16 * 1024, "@@MARKER@@") }),
  new Arm({ label: "painted 64 KB (resync)", payload: paintedBytes(64 * 1024, "@@MARKER@@") }),
];

const rows = ["HOP FIVE, FIRST HALF: term.write() -> xterm says it has parsed the bytes",
  "  arm                        bytes   latency p50   parse/write     MB/s parsed",
  "                                        (one frame)    (amortised)                "];
const refusals = [];

for (const arm of ARMS) {
  await arm.run(Terminal);
  const p50 = percentile(arm.ms, 0.5);
  const mbps = arm.parseMs > 0 ? (arm.bytes / 1e6) / (arm.parseMs / 1000) : NaN;
  rows.push(`  ${arm.label.padEnd(24)}  ${String(arm.bytes).padStart(6)}  `
    + `${p50.toFixed(3).padStart(11)}  ${arm.parseMs.toFixed(4).padStart(13)}  `
    + `${mbps.toFixed(1).padStart(13)}`);
  if (!Number.isFinite(arm.parseMs)) {
    refusals.push(`${arm.label}: the batch never finished, so there is no parse cost for it`);
  }
  if (arm.timedOut) {
    refusals.push(`${arm.label}: ${arm.timedOut} write callback(s) never fired inside `
      + `${CALLBACK_TIMEOUT_MS}ms, so those writes cannot be timed`);
  }
  if (!arm.ms.length) refusals.push(`${arm.label}: no write was timed at all`);
  if (!arm.wroteSomething) {
    refusals.push(`${arm.label}: the marker it wrote is not in the buffer afterwards, so whatever `
      + `was timed did not reach the screen`);
  }
  if (arm.foreignFound) {
    refusals.push(`${arm.label}: a marker NO arm wrote was found in the buffer, so this check `
      + `cannot tell present from absent`);
  }
  if (arm.ms.some((ms) => !Number.isFinite(ms))) {
    refusals.push(`${arm.label}: a non-finite duration was admitted`);
  }
}

// THE COST HAS TO GROW WITH THE WORK, or the arms are not measuring the parse at all. Sixty-four
// times the bytes taking the same time would mean the timer is reading something else.
// A MEANINGFUL FACTOR, NOT MERELY `>`, AND SET FROM TWO MEASUREMENTS RATHER THAN FROM TASTE. The
// first version required only that 64KB cost MORE than 1KB and PASSED on a ratio of 1.0x, because
// both arms were reading the scheduler's ~15.4ms floor instead of the parse. A control satisfied by
// noise is not a control.
//
// The floor sits between two things that were actually measured on this host: arms of IDENTICAL size
// give 0.99x, and the real geometry gives 4.1x. 2x is comfortably above the first and comfortably
// below the second, so it cannot be met by noise and does not go red on an ordinary run. The ratio is
// sublinear -- 64x the bytes for ~4x the time -- because per-write overhead dominates at 1KB, which
// is why a floor anywhere near 64 would be wrong.
const MIN_GROWTH = 2;
const small = ARMS[1].parseMs;
const large = ARMS[3].parseMs;
if (!(large >= small * MIN_GROWTH)) {
  refusals.push(`64 KB parses in ${large.toFixed(4)}ms and 1 KB in ${small.toFixed(4)}ms -- `
    + `${(large / small).toFixed(2)}x for 64x the bytes, under the ${MIN_GROWTH}x floor. These `
    + `timings are not tracking the work.`);
}

if (refusals.length) {
  process.stderr.write(`${LF}NOTHING IS PUBLISHED. A number is only a hop if its controls held:${LF}`);
  for (const line of refusals) process.stderr.write(`  - ${line}${LF}`);
  process.exitCode = 1;
} else {
  for (const row of rows) console.log(row);
  console.log("");
  console.log(`Every arm's marker reached the buffer, a marker no arm wrote was not found, and 64 KB `
    + `parses in ${(large / small).toFixed(1)}x the time 1 KB does, so these timings track the work.`);
  console.log(`THE LATENCY COLUMN IS THE SCHEDULER, NOT THE PARSE: every arm reads about the same `
    + `${percentile(ARMS[0].ms, 0.5).toFixed(1)}ms whatever its size, which is this host's ~15.6ms `
    + `timer granularity showing through xterm's deferred callback. A browser defers differently, so `
    + `that column does not transfer; the parse column is the one about the work.`);
  console.log("WHAT THIS IS NOT, and it is half the hop: the RENDERER is absent. Painting the parsed "
    + "buffer into a DOM or canvas, and the browser's scheduling of that work against everything "
    + "else on the page, are not in any figure above and still need a browser.");
}
