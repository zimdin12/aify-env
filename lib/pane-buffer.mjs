// What a process has printed, kept at the size a pane can show.
//
// THE GAP THIS FILLS. `GET /processes/:id/output` streams the recent buffer and then everything new,
// and `sideBySide` renders an array of finished lines. Between them sits the part nobody had written:
// bytes arrive in chunks that have nothing to do with lines, and a pane needs the LAST N lines, not
// the first N or all of them.
//
// A CLASS, because it has identity and state -- one buffer per process, carrying what that process
// said. The line splitting underneath is a pure function taking a carry and returning a new carry, so
// the hard part (a chunk that ends mid-line, a spinner rewriting itself) is testable without an
// object, a process or a socket.
//
// WHAT A TERMINAL DOES THAT A LOG DOES NOT. Coding agents draw with carriage returns: a spinner emits
// `\rWorking. \rWorking.. \rWorking...` and means ONE line rewritten three times, not three lines.
// Treating `\r` as a line break turns a quiet spinner into an endless scroll that pushes real output
// out of the ring, which is exactly what a small pane cannot afford.
//
// So `\n` ENDS a line and `\r` MOVES THE CURSOR TO COLUMN 0 -- it does not erase. That distinction is
// not pedantry and it cost a bug: the first version cleared the line on `\r`, which made every
// CRLF-terminated line come out EMPTY, because the `\r` wiped the text before the `\n` could end it.
// Silent, and only on Windows processes. Modelling the column fixes CRLF for free and reproduces the
// real artifact too -- `"Long line\rShort"` displays as `"Shortline"` in any terminal, and a pane that
// tidied that away would be disagreeing with the console about what the process printed.

import { clipToWidth } from "./panes.mjs";
import { drawsWithCursor } from "./process-registry.mjs";

/**
 * How long after a paint a pane keeps saying so.
 *
 * Long enough that an idle TUI -- which repaints only when something changes -- does not flicker
 * between the notice and a scrambled screen, and short enough that a process which painted once and
 * then went back to logging gets its lines back while the operator is still looking.
 */

/** What a pane says when it is pointed at something it cannot draw. */
function paintingNotice(width, agent = "") {
  // IT NAMES THE COMMAND THAT WORKS, and no longer promises something Enter does not do.
  //
  // It used to say "press Enter to attach". Review followed that instruction through the real
  // SSE -> follower -> buffer -> dashboard composition: Enter switches key forwarding ON but keeps
  // this notice-only renderer, so the title changes to "typing here" and `hello` is delivered to the
  // agent while the operator sees no screen at all. Blind typing into a live worker is worse than a
  // pane that admits it cannot draw.
  //
  // `aify-env attach` is the thing that genuinely works -- it hands the process a REAL terminal,
  // which emulates the escapes this buffer cannot.
  const command = agent ? `aify-env attach ${agent}` : "aify-env attach <agent>";
  return [
    clipToWidth("live TUI — this pane cannot draw it", width),
    clipToWidth(`run: ${command}`, width),
  ];
}

/** Default ring size. Generous against a tall pane, small enough that a chatty process cannot grow it. */
export const DEFAULT_MAX_LINES = 500;

// An unterminated line and where the cursor sits in it. `col` is why this is not just a string.
//
// NOT EXPORTED. Nothing outside depends on it: `splitChunk` already accepts a bare string or
// nothing at all as a starting carry, so a caller never needs to name this. The export gate was
// right to refuse it -- an export is a thing another module depends on, and writing a test to
// justify one nobody uses would have satisfied the gate while widening the surface.
const EMPTY_CARRY = Object.freeze({ text: "", col: 0 });

/** Normalise whatever a caller passed as a carry, including the string form and nothing at all. */
function toCarry(value) {
  if (typeof value === "string") return { text: value, col: value.length };
  if (value && typeof value === "object") {
    const text = String(value.text ?? "");
    const col = Number.isFinite(value.col) ? Math.max(0, Math.floor(value.col)) : text.length;
    return { text, col };
  }
  return { text: "", col: 0 };
}

/**
 * Split a chunk into finished lines plus the partially-drawn line left over.
 *
 * PURE, and it takes the carry as an argument rather than reading state, so a caller can test "a line
 * split across three chunks" or "a CRLF split across two" by passing the carry along by hand.
 *
 * `\r` MOVES THE CURSOR, IT DOES NOT ERASE. This started as "\r clears the line", which is the
 * intuitive reading and is wrong in a way that loses data: `"a\r\n"` then produced an EMPTY line,
 * because the `\r` wiped the text before the `\n` could end it -- so every CRLF-terminated line from a
 * Windows process vanished. A terminal moves the cursor to column 0 and lets what follows OVERWRITE,
 * leaving anything past the new text in place. Modelling the column gets CRLF right for free, and it
 * gets the artifact right too: `"Long line\rShort"` really does display as `"Shortline"`, which is a
 * thing operators see in real consoles and would not thank us for silently tidying away.
 *
 * @param {string|{text:string,col:number}} carry  the partially-drawn line so far
 * @param {string} chunk  newly arrived text
 * @returns {{lines: string[], carry: {text:string,col:number}}}
 */
export function splitChunk(carry, chunk) {
  const text = String(chunk ?? "");
  let { text: current, col } = toCarry(carry);
  const lines = [];

  for (const ch of text) {
    if (ch === "\n") {
      lines.push(current);
      current = "";
      col = 0;
    } else if (ch === "\r") {
      col = 0;
    } else if (col < current.length) {
      current = current.slice(0, col) + ch + current.slice(col + 1);
      col += 1;
    } else {
      current += ch;
      col += 1;
    }
  }

  return { lines, carry: { text: current, col } };
}

/**
 * The last N lines a process has printed, ready for a pane.
 *
 * BOUNDED BY CONSTRUCTION. Every append trims, so a process that prints for six hours costs the same
 * memory as one that printed twice. An unbounded buffer here would be a leak with a delay on it, and
 * the thing it would leak is whatever the busiest agent on the host is saying.
 */
export class PaneBuffer {
  constructor({ maxLines = DEFAULT_MAX_LINES } = {}) {
    this.maxLines = Math.max(1, Math.floor(maxLines) || DEFAULT_MAX_LINES);
    this.lines = [];
    this.carry = { ...EMPTY_CARRY };
  }

  /** Feed arrived output. Chunk boundaries are meaningless, so this is safe to call with anything. */
  append(chunk, { nowMs = Date.now() } = {}) {
    // A TUI IS NOT A LOG, and this buffer can only model a log. See `view()`.
    //
    // THE MOMENT IS INJECTABLE for the same reason every other clock in this repo is: a test that
    // cannot seal its clock is a test whose result the host decides. Sealing it in `view` alone left
    // the stamp on the real clock and the comparison on a fixed one, so the window was always
    // expired and three tests failed against a working fix.
    // NO CHUNK-BOUNDARY BOOKKEEPING HERE, and that is a deletion the mutant argued for.
    //
    // Review falsified the OLD detector by cutting one escape in half: `ESC[12;40Hfragment` was
    // caught, while the identical bytes arriving as `ESC[12;` then `40Hfragment` were not, because it
    // judged each chunk in isolation and stamped a clock. I first fixed that by carrying the
    // unterminated tail between chunks -- and then removing the carry left every test green, which is
    // the honest signal that it was doing nothing.
    //
    // It was doing nothing because `isPainting` now asks the BUFFER, and `splitChunk` has already
    // rejoined the halves into one line by then: an escape cannot contain a newline, so it can never
    // straddle the only boundary this buffer creates. The chunk boundary stopped mattering the moment
    // the question moved from "what just arrived" to "what is being held".
    const { lines, carry } = splitChunk(this.carry, chunk);
    this.carry = carry;
    if (lines.length) {
      this.lines.push(...lines);
      if (this.lines.length > this.maxLines) {
        this.lines.splice(0, this.lines.length - this.maxLines);
      }
    }
    return this;
  }

  /**
   * The bottom `height` lines, each clipped to `width`.
   *
   * THE UNTERMINATED LINE IS INCLUDED. A process that has printed a prompt and is waiting has said
   * something real and emitted no newline for it; hiding that until a newline arrives makes an
   * attached console look dead at precisely the moment it is asking a question. It is shown as the
   * last line and replaced in place when the rest of it arrives.
   *
   * CLIPPED, NOT WRAPPED. A pane is one column of a side-by-side layout, so a long line that wrapped
   * would push the pane's own rows out of alignment with the pane beside it. `clipToWidth` walks
   * escapes atomically and closes any colour it cut, so a clipped line cannot bleed into the divider.
   */
  view({ height = 10, width = 80, agent = "" } = {}) {
    const rows = Math.max(0, Math.floor(height) || 0);
    if (rows === 0) return [];
    // A PICTURE CANNOT BE SHOWN AS LINES, so say so instead of showing fragments.
    //
    // THE OPERATOR SAW THIS, 2026-09-07: the pane read
    // `Cited file didn't exist.—eflaggedCtheTbrokentpointer` -- text from different screen positions
    // concatenated onto one row. Not a width bug. This buffer models newline and carriage
    // return and nothing else; a coding agent
    // paints with `ESC[row;colH` and `ESC[K`, and replaying a paint into a line model produces
    // exactly that.
    //
    // aify-comms ALREADY LEARNED THIS. `console_prompts.py`: "claude does not send spaces, it moves
    // the cursor ... a matcher run on raw bytes is looking for a string that is never transmitted."
    // It renders through pyte for this reason. This pane has no emulator and must not pretend.
    //
    // ATTACHING IS THE ANSWER AND IT ALREADY WORKS -- verified by the operator against both a claude
    // and a hermes worker the same day -- because attach pipes bytes to a REAL terminal, which
    // emulates them. So the honest pane names the one thing that does work.
    //
    // A WINDOW, NOT A LATCH. A process that paints a banner at startup and then logs is a log again
    // afterwards, and marking it forever would cost it a pane it could legitimately have.
    if (this.isPainting()) return paintingNotice(width, agent).slice(0, rows);
    const all = this.carry.text ? [...this.lines, this.carry.text] : this.lines;
    return all.slice(-rows).map((line) => clipToWidth(line, width));
  }

  /**
   * Whether the lines this pane is HOLDING are a painted screen rather than a log.
   *
   * A FACT ABOUT THE BUFFER, NOT ABOUT THE CLOCK, and that is the whole of review's second finding.
   * It used to expire after 30 seconds, which bought the notice at N+30000 and, at N+30001, the SAME
   * buffered escape released to the renderer with no new output at all. Silence is not evidence that
   * cursor controls became safe log text: the bytes did not change, only the time did.
   *
   * AND NOT A LATCH EITHER. A process that paints a banner at startup and then logs is a log again --
   * once the painted output has scrolled out of what is retained, there is nothing left that cannot
   * be read as lines. So the question is asked of the CONTENT: does what this pane would show still
   * contain cursor controls. That answers both cases with one rule, and it is state-based rather than
   * event-based, which is this repo's standing answer to exactly this shape.
   */
  isPainting() {
    if (this.carry.text && drawsWithCursor(this.carry.text)) return true;
    return this.lines.some((line) => drawsWithCursor(line));
  }

  /** How many lines are held, counting the unterminated one -- what `view` would show given room. */
  get length() {
    return this.lines.length + (this.carry.text ? 1 : 0);
  }

  /** Forget everything. Used when a pane is re-pointed at a different process. */
  clear() {
    this.lines = [];
    this.carry = { ...EMPTY_CARRY };
    return this;
  }
}
