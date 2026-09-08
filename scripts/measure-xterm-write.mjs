// What xterm does with a frame before anything is drawn.
//
// WHAT IS MEASURED, named as narrowly as it deserves: AMORTIZED HEADLESS WRITE-COMPLETION WALL
// TIME. From `term.write(chunk, done)` to `done` firing, over a batch, divided by the batch size.
// That span contains the parse AND xterm's own deferral of it -- the installed WriteBuffer yields
// after a 12ms slice -- so it is not the parser's cost in isolation and this file does not claim it
// is. An earlier version did: it argued that equal write counts subtracted the scheduling, and
// review disproved that by charging every arm an identical parser cost and changing only the large
// arm's timer, which made the script publish 5.43x.
//
// It is still the useful number, because it is what a caller waits for. `@xterm/headless` is the
// same parser the browser runs with the renderer removed -- which makes it usable for this half and
// useless for the other. The renderer painting the buffer, and the browser scheduling that work
// against everything else on the page, are in no figure here.
//
// WHY THIS IS WORTH MEASURING WITHOUT A BROWSER. Hop five has stood at "not measured, needs a
// browser" while it was the last unexamined suspect for the operator's "the browser terminal kind of
// lags sometimes". Half of it does not need one. If the parse is cheap, the remaining suspect is
// narrowed to rendering and scheduling; if it is expensive, that is an answer nobody had to open a
// browser to get.
//
// THE 64KB ARM IS A WORKLOAD, NOT A WORST CASE, and calling it one was borrowing the wrong bound.
// 64KB caps the raw `output` TAIL. The console prefers the SNAPSHOT and both callers write
// `snapshot || output`, and nothing caps a snapshot: `terminal_snapshot_view` attaches it whole.
// Review serialised a constructed legal 132x40 screen of alternating truecolor and got 111,135
// UTF-8 bytes, against 5,935 for its plain paired control, and 103,215 for a plain 500x200. So the
// largest write this path can produce is well above 64KB and depends on what is ON the screen
// rather than on any cap. This row is a big, realistic write; it is not the ceiling.
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
  parts.push(marker);
  return parts.join("");
}

class Arm {
  constructor({ label, payload, writes = WRITES }) {
    this.label = label;
    this.payload = payload;
    this.writes = writes;
    // TWO WITNESSES, ONE PER PHASE. A single marker let the LATENCY phase's twenty writes satisfy
    // the check while the timed batch did nothing at all -- the buffer said "something wrote this"
    // and the timed span said nothing. Each phase now leaves its own mark, and both are required.
    const stem = label.replace(/[^a-z0-9]/gi, "");
    this.marker = `<lat-${stem}>`;
    this.batchMarker = `<bat-${stem}>`;
    this.ms = [];
    this.parseMs = NaN;
    this.timedOut = 0;
    this.overran = false;
    this.batchWrote = false;
  }

  async run(Terminal) {
    // ONE TERMINAL PER ARM, at the geometry the console actually uses. A terminal reused across arms
    // would carry the previous arm's scrollback and charset state into this one's timings.
    const term = new Terminal({ cols: 132, rows: 40, allowProposedApi: true, scrollback: 1000 });
    // ONE ROW EACH. Both phases addressed row 40, so the batch's marker erased the latency
    // phase's and the run refused -- the same cell collision that hid the very first witness behind
    // `ESC[H`, one phase later. A witness has to survive everything written after it.
    const body = this.payload.replace("@@MARKER@@", `${ESC}[39;1H${this.marker}`);
    const batchBody = this.payload.replace("@@MARKER@@", `${ESC}[40;1H${this.batchMarker}`);
    // UTF-8 BYTES, not UTF-16 units. `String.length` counts units, and the real captured fixture is
    // 582 units against 593 bytes -- so every throughput figure was divided by the wrong number.
    this.bytes = Buffer.byteLength(batchBody, "utf8");
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

      // CHECKED WHEN THIS PHASE ENDS, not at the end of everything. The painted arms repaint all
      // forty rows on every write, so the batch necessarily erases whatever the latency phase left
      // -- there is no row to hide a witness on. Each phase is asked about while its own output is
      // still the most recent thing on the screen.
      this.wroteSomething = screenOf(term).includes(this.marker);

      const batchStarted = process.hrtime.bigint();
      const deadlineNs = batchStarted + BigInt(CALLBACK_TIMEOUT_MS * 10) * 1000000n;
      const finished = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), CALLBACK_TIMEOUT_MS * 10);
        for (let i = 0; i < this.writes; i += 1) {
          if (i === this.writes - 1) {
            term.write(batchBody, () => { clearTimeout(timer); resolve(true); });
          } else {
            term.write(batchBody);
          }
        }
      });
      const batchEnded = process.hrtime.bigint();
      // A CLEARED TIMEOUT IS NOT A MET DEADLINE. A synchronous parse can run past the bound and
      // then clear a timer the blocked loop never got to run -- review measured a batch finishing
      // at 20056.6ms against a 20000ms bound and publishing. The AGE at completion is what decides.
      this.overran = batchEnded > deadlineNs;
      if (!finished) this.timedOut += this.writes;
      else this.parseMs = Number(batchEnded - batchStarted) / 1e6 / this.writes;

      this.ms.sort((a, b) => a - b);
      const screen = screenOf(term);
      // BOTH PHASES, INDEPENDENTLY. The latency phase's witness no longer stands in for the batch's.
      this.batchWrote = screen.includes(this.batchMarker);
      // AND THE NEGATIVE: a marker of the same shape that no arm ever wrote.
      this.foreignFound = screen.includes("<neverwrittenbyanyarm>");
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
  // THE MARKER TRAILS THE CAPTURE, because a real frame repaints and would overwrite a leading one.
  new Arm({ label: "a real captured frame", payload: `${REAL}@@MARKER@@` }),
  new Arm({ label: "painted 1 KB", payload: paintedBytes(1024, "@@MARKER@@") }),
  new Arm({ label: "painted 16 KB", payload: paintedBytes(16 * 1024, "@@MARKER@@") }),
  new Arm({ label: "painted 64 KB", payload: paintedBytes(64 * 1024, "@@MARKER@@") }),
];

const rows = ["HOP FIVE, FIRST HALF: amortized headless write-completion wall time",
  "  arm                     UTF-8 B   latency p50   write/frame     MB/s written",
  "                                        (one write)   (amortised,                ",
  "                                                       includes xterm's deferral)"];
const refusals = [];

for (const arm of ARMS) {
  await arm.run(Terminal);
  const p50 = percentile(arm.ms, 0.5);
  const mbps = (arm.parseMs > 0 && arm.bytes > 0)
    ? (arm.bytes / 1e6) / (arm.parseMs / 1000)
    : NaN;
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
    refusals.push(`${arm.label}: the latency phase's marker is not in the buffer afterwards, so `
      + `whatever was timed did not reach the screen`);
  }
  if (!arm.batchWrote) {
    refusals.push(`${arm.label}: the TIMED BATCH's own marker is not in the buffer, so the span `
      + `that produced the published figure drew nothing -- the latency phase's writes are not `
      + `evidence for it`);
  }
  if (arm.overran) {
    refusals.push(`${arm.label}: the batch finished after its own deadline and cleared a timer the `
      + `blocked loop never ran, so "it completed in time" was decided by a callback rather than `
      + `by the clock`);
  }
  if (!Number.isFinite(arm.parseMs) || arm.parseMs <= 0) {
    refusals.push(`${arm.label}: the per-write figure is ${arm.parseMs}, which is not a positive `
      + `finite number -- zero and negative both published before, with NaN throughput beside them`);
  }
  if (!(arm.bytes > 0)) {
    refusals.push(`${arm.label}: the payload measured ${arm.bytes} bytes, so every throughput here `
      + `has a zero denominator`);
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
// FINITE AND POSITIVE FIRST, because an inequality between two invalid numbers is not a comparison:
// `-5 >= -5 * 2` is true, so two equal NEGATIVE costs satisfied a growth check meant to prove the
// timings track the work.
if (![small, large].every((ms) => Number.isFinite(ms) && ms > 0)) {
  refusals.push(`the growth check compared ${small} and ${large}, at least one of which is not a `
    + `positive finite number, so the inequality between them means nothing`);
} else if (!(large >= small * MIN_GROWTH)) {
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
  console.log(`Both phases of every arm left their own witness on the screen, a marker no arm wrote `
    + `was not found, and 64 KB costs ${(large / small).toFixed(1)}x what 1 KB costs -- so these `
    + `timings vary with the work rather than being a fixed overhead.`);
  console.log(`THE LATENCY COLUMN IS THE SCHEDULER: every arm reads about the same `
    + `${percentile(ARMS[0].ms, 0.5).toFixed(1)}ms whatever its size, which is this host's ~15.6ms `
    + `timer granularity showing through xterm's deferred callback. A browser defers differently, so `
    + `it does not transfer.`);
  console.log(`AND THE AMORTISED COLUMN IS NOT THE PARSER IN ISOLATION EITHER. It is write-completion `
    + `wall time per frame, which contains xterm's own deferral -- the WriteBuffer yields after a `
    + `12ms slice -- so a growth ratio shows that the arms differ, not that the difference is parsing. `
    + `Separating the parser from its scheduling would need per-interval instrumentation this does not `
    + `have.`);
  console.log("WHAT THIS IS NOT, and it is half the hop: the RENDERER is absent. Painting the parsed "
    + "buffer into a DOM or canvas, and the browser's scheduling of that work against everything "
    + "else on the page, are not in any figure above and still need a browser.");
}
