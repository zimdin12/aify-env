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
  append(chunk) {
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
  view({ height = 10, width = 80 } = {}) {
    const rows = Math.max(0, Math.floor(height) || 0);
    if (rows === 0) return [];
    const all = this.carry.text ? [...this.lines, this.carry.text] : this.lines;
    return all.slice(-rows).map((line) => clipToWidth(line, width));
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
