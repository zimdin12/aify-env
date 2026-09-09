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
import { screenIsBlank, screenLines } from "./screen-render.mjs";
import { drawsWithCursor } from "./process-registry.mjs";
import { scanForConceal } from "./conceal-scan.mjs";
import { hasFullRepaint } from "./screen-baseline.mjs";

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

/**
 * What a pane says while a screen exists but cannot yet be trusted.
 *
 * IT SHOWS THE WAIT, NOT THE SCREEN. A picture reconstructed from a truncated history is coherent and
 * possibly wrong, and wrong-looking-right is worse in a console than blank -- an operator reads a
 * screen to decide what an agent is doing.
 *
 * AND IT NAMES THE THING THAT WORKS ANYWAY, because a wait with no way round it is a dead end.
 * `aify-env attach` hands the process a real terminal, which needs no reconstruction at all.
 *
 * IT SAYS WHETHER ANYTHING HAS BEEN PAINTED YET, because "nothing has arrived" and "what arrived
 * cannot be trusted" look identical on screen and are different problems: one resolves by waiting,
 * the other might not.
 */
function notWholeYet(screen, width, agent) {
  const command = agent ? `aify-env attach ${agent}` : "aify-env attach <agent>";
  const painted = screenIsBlank(screen.rows) ? "nothing painted yet" : "a partial screen so far";
  return [
    clipToWidth(screen.problem, width),
    clipToWidth(painted, width),
    clipToWidth(`run: ${command}`, width),
  ];
}

/**
 * The widest unterminated line this buffer will hold.
 *
 * `maxLines` BOUNDS LINES, NOT BYTES, and a process that never emits a newline was therefore
 * unbounded: review measured 100,000 code units retained with `maxLines: 1`. A coding agent painting
 * a screen is exactly that shape -- cursor moves and carriage returns, newlines rarely -- so this is
 * the ordinary case for the thing this pane exists to show, not a pathological one.
 *
 * FOUR THOUSAND COLUMNS is far past any terminal and far past any pane. Text beyond it cannot be
 * displayed by any width this view supports, and `clipToWidth` would drop it on the way out.
 *
 * THE COLUMN KEEPS COUNTING PAST THE CAP, which is what makes this safe rather than merely small: a
 * later `` still returns to column 0 and overwrites from there, so a spinner or a repaint lands
 * exactly where it would have. Only the un-displayable tail is discarded.
 */
export const MAX_LINE_COLUMNS = 4096;

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
  // COUNTED IN CODE POINTS, never in UTF-16 units, because that is the unit the column model uses.
  // An emoji is ONE cell and TWO units; a column derived from `.length` puts the cursor past the end
  // of a line the operator can see, and every overwrite after that lands in the wrong place.
  if (typeof value === "string") return { text: value, col: [...value].length };
  if (value && typeof value === "object") {
    const text = String(value.text ?? "");
    const col = Number.isFinite(value.col) ? Math.max(0, Math.floor(value.col)) : [...text].length;
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
  const start = toCarry(carry);
  let col = start.col;
  // AN ARRAY OF CODE POINTS, NOT A STRING, AND THAT IS A BOUNDS FIX RATHER THAN A TIDY-UP.
  //
  // `for...of` walks CODE POINTS; `String.length` and `slice` count UTF-16 UNITS. Mixing them made
  // the OVERWRITE branch GROW the line: with an emoji at every column, `col` was N while
  // `current.length` was 2N, so `col < current.length` stayed true for ever and each write replaced
  // ONE unit with a TWO-unit character. The line grew by one unit per character and never reached
  // the append-only cap that was supposed to bound it.
  //
  // MEASURED, `maxLines: 1`: 100,000 ASCII characters retained 4,096 units, and 20,000 emoji
  // retained 20,001 -- five times the cap, from a stream a fifth the size. A bound that holds only
  // for Latin text is not a bound; it is a bound with a locale attached.
  //
  // Indexing the same units the loop walks makes the cap hold for every script, and it makes the
  // column mean what it says: one cell, one code point.
  let cells = [...start.text];
  const lines = [];

  for (const ch of text) {
    if (ch === "\n") {
      lines.push(cells.join(""));
      cells = [];
      col = 0;
    } else if (ch === "\r") {
      col = 0;
    } else if (col < cells.length) {
      cells[col] = ch;
      col += 1;
    } else if (col < MAX_LINE_COLUMNS) {
      cells.push(ch);
      col += 1;
    } else {
      // PAST THE CAP: the column still advances, the character is not kept. Counting on is what makes
      // this safe -- a later carriage return returns to 0 and overwrites from there, so a repaint lands exactly
      // where it would have. Only text no width could ever show is discarded.
      col += 1;
    }
  }

  return { lines, carry: { text: cells.join(""), col } };
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
    //: WHETHER THIS STREAM HAS EVER TOLD THE TERMINAL TO HIDE TEXT.
    //:
    //: A LATCH, because the evidence does not survive. `splitChunk` gives an escape a column, so a
    //: carriage return overwrites it and the retained line no longer contains the conceal at all --
    //: which is how a complete, untruncated history disclosed a token the real terminal was hiding.
    //: Once the answer has been destroyed, "has it ever" is the only question this buffer can still
    //: answer honestly.
    //:
    //: RELEASED BY A FULL RESET, and only by that. `ESC c` is the one sequence that throws the whole
    //: screen away -- the same rule `screen-baseline.mjs` already enforces for a truncated replay --
    //: so after one, nothing the stream said before bears on what is displayed. Anything weaker
    //: (`ESC[2J`, `ESC[28m`) leaves concealed cells sitting in the buffer, and this project has
    //: already accepted `ESC[2J` as a reset once and disclosed through it.
    this.concealSeen = false;
    //: An unterminated escape from the previous chunk, so a sequence split across a read is still
    //: judged whole. `ESC[` then `8m` is two ordinary chunks and one conceal.
    this.concealPending = "";
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
    // ASKED OF THE RAW CHUNK, BEFORE THE COLUMN MODEL TOUCHES IT. `splitChunk` treats an escape as
    // occupying columns, so a carriage return overwrites it -- and after that no scan of what is
    // retained can find the conceal that governs the text still on screen.
    const text = String(chunk ?? "");
    // A FULL RESET IS READ FIRST, so a stream that concealed, reset, and then logged plainly is not
    // refused for ever. Ordered this way deliberately: a chunk carrying BOTH a reset and a new
    // conceal must end up latched, because the conceal came after.
    if (hasFullRepaint(text)) {
      this.concealSeen = false;
      this.concealPending = "";
    }
    const scanned = scanForConceal(text, this.concealPending);
    this.concealPending = scanned.pending;
    if (scanned.conceals) this.concealSeen = true;
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
  view({ height = 10, width = 80, agent = "", screen = null } = {}) {
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
    // AN UNTRUSTWORTHY REPLAY IS REFUSED BEFORE ANYTHING ELSE, including the log path.
    //
    // THIS CHECK USED TO LIVE INSIDE `isPainting()` AND THAT WAS THE HOLE. A retained suffix with no
    // cursor commands in it reads as a log -- so the pane printed it raw, past both the conceal
    // handling and the baseline gate. Review reproduced the disclosure: an `ESC[8m` lost off the
    // front, `SYNTHETIC_HIDDEN` in the surviving bytes, and the pane showed the secret.
    //
    // The absence of cursor commands says nothing about whether the bytes are a log. The SGR state
    // that governs them fell off the front with everything else, so "unknown" is the only honest
    // reading, and unknown must not be rendered as content.
    // ONE DECISION, ASKED HERE AND ASKED BY THE INPUT GATE. `refusalReason` is what decides
    // whether this pane shows the process or a notice about it; everything below renders that
    // decision. The session used to re-derive it from `meta` alone and so knew ONE of these three
    // branches -- see the note on `refusalReason`.
    const refusal = this.refusalReason(screen);
    if (refusal) {
      return screen?.problem
        ? notWholeYet(screen, width, agent).slice(0, rows)
        : paintingNotice(width, agent).slice(0, rows);
    }

    // NOT REACHED WHEN `refusalReason` REFUSED, which is what keeps the two in step.
    if (screen?.problem) return notWholeYet(screen, width, agent).slice(0, rows);

    // A WINDOW, NOT A LATCH. A process that paints a banner at startup and then logs is a log again
    // afterwards, and marking it forever would cost it a pane it could legitimately have.
    if (this.isPainting()) {
      // A SCREEN, IF SOMEBODY BUILT ONE. `screen` is passed in rather than constructed here so this
      // file keeps its one dependency and stays testable with literals: the emulator is optional,
      // lives in `screen-emulator.mjs`, and belongs to whoever owns the process's lifecycle.
      //
      // THREE OUTCOMES AND THEY ARE DIFFERENT CLAIMS, which is why none of them may be silent:
      //   a sound screen        -> draw it, because it IS what the process painted;
      //   an unsound screen     -> say what is being waited for, because a reconstruction from a
      //                            truncated history is coherent-looking and possibly wrong;
      //   no screen at all      -> the notice this pane has always shown, unchanged.
      // The unsound case was answered above, so a screen reaching here is one to draw -- and a
      // MISSING one was refused by `refusalReason`, so this branch is now unconditional.
      return screenLines(screen.rows, { width, height: rows });
    }
    // THE LOG PATH REFUSES A STREAM THAT HAS CONCEALED, and this is the third disclosure in this
    // feature rather than a precaution. Measured 2026-09-08 against the real parser: a complete,
    // untruncated history of `ESC[8m` + CR + `SYNTHETIC_HIDDEN` renders as four blank rows on a real
    // terminal and printed the token here. Every gate written for the first two disclosures passes
    // it -- the history IS complete, there ARE no cursor commands, and the daemon's `truncated:
    // false` was honest. What none of them measures is whether a line model can render these bytes.
    //
    // IT NAMES THE ATTACH, like every other refusal here, because attaching pipes the bytes to a
    // real terminal and that is the thing that does work.
    const all = this.carry.text ? [...this.lines, this.carry.text] : this.lines;
    return all.slice(-rows).map((line) => clipToWidth(line, width));
  }

  /**
   * Why this pane would show a NOTICE instead of the process, or "" when it would show the process.
   *
   * THE INPUT GATE ASKS THIS, and that is why it exists as a method rather than as three
   * conditions inside `view()`. A pane showing a notice is a pane whose operator has been told
   * they are not seeing the process, and forwarding keystrokes into it is blind typing at a live
   * worker. Review measured exactly that: clean metadata, no emulator, the notice on screen, and
   * `x` delivered.
   *
   * THREE BRANCHES, AND THE SESSION KNEW ONE. It re-derived "is the baseline sound" from `meta`
   * and `repaintedSince`, which answers the FIRST of these and is silent about a painting process
   * with no emulator and about a stream that has concealed. Both of those show the same notice.
   *
   * `view()` RENDERS WHAT THIS DECIDES, so a fourth branch cannot be added to one and forgotten by
   * the other.
   */
  refusalReason(screen = null) {
    if (screen?.problem) return String(screen.problem);
    // A PAINTING PROCESS WITH NO SCREEN. The emulator is optional; without one this pane can show
    // that a TUI is there and nothing of what it says.
    if (this.isPainting()) return screen ? "" : "live TUI this pane cannot draw";
    // A LOG THAT HAS CONCEALED. The line model cannot render `ESC[8m`, so the pane refuses rather
    // than printing what a real terminal hides.
    if (this.concealSeen) return "concealed output this pane cannot render";
    return "";
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
    // A DIFFERENT PROCESS'S CONCEAL IS NOT THIS ONE'S. `clear` is what re-points a pane, and
    // carrying the latch across would refuse a fresh stream for something the previous one did.
    this.concealSeen = false;
    this.concealPending = "";
    return this;
  }
}
