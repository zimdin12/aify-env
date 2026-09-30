// A terminal stream's line feeds as a Windows console needs them: Index (ESC D) wherever a VT parser
// would execute LF, and nothing else changed.
//
// THE DEFECT (2026-09-30), the scrambled herdr pane. On Windows the process's PTY is a ConPTY, and
// ConPTY moves the cursor down with a bare LF, meaning "same column". A console treats a program's LF
// as CR+LF unless DISABLE_NEWLINE_AUTO_RETURN is set, and Node cannot set it. So in a herdr pane, or
// any Windows terminal, that row went back to column 1, and what it did not cover stayed behind: "bot-"
// for "both", stray box-drawing at column 0. Measured by replaying a recorded hermes stream through a
// ConPTY into xterm: it diverged at the first `CUP; LF; text` (chunk 664 of 4470) through the system
// ConPTY and through herdr's own, and matched to the end with this translation.
//
// THE PARSER IS THE VT500 TABLE, NOT A HEURISTIC (reviews of e880d48, 0557d21 and bfacc7a: three
// hand-written state machines, each wrong in a new place). `TRANSITIONS` is xterm's own table
// (`@xterm/xterm` src/common/parser/EscapeSequenceParser.ts, `VT500_TRANSITION_TABLE`, from
// https://vt100.net/emu/dec_ansi_parser), ported in xterm's order, so later rules override earlier ones
// exactly as they do there. Where xterm's parse loop changes a state outside the table, that is ported
// too and says so. The parity test compares against xterm itself, so a divergence is a test failure.
//
// WHAT HAPPENS TO AN LF, by the state the table is in when it arrives:
//   executed (ground, escape, escape-intermediate, the four CSI states)
//     at ground it becomes Index. Inside a sequence, the sequence is HELD until it ends and the LF is
//     written as Index at once, ahead of the held bytes. Equivalent because LF only moves the row, the
//     other controls a parser executes there only move the column (CR, BS, HT) or nothing, and a
//     sequence acts only when it ends.
//   ignored or collected (OSC, DCS, SOS/PM/APC): written as it came; the parser never executes it.
//
// THE HOLD HAS A CEILING. When a chunk ends with more than HOLD_LIMIT characters of one unfinished
// sequence held, those are written as they stand and the rest of that sequence passes as it comes; the
// parser state is kept, so the two stay in step, and an LF later in that same sequence is written as it
// came. A sequence that ends within the chunk is never affected, however long.
//
// ONLY LF. VT and FF also move a line in xterm; ConPTY does not emit them, and what a console does with
// them was not measured, so they pass unchanged.

const ESC = String.fromCharCode(27);
//: ESC D, Index: down one row in the same column, scrolling at the bottom margin.
const INDEX = `${ESC}D`;
const LF = 0x0a;
//: How much of one unfinished sequence may be carried to the next chunk (see THE HOLD HAS A CEILING).
const HOLD_LIMIT = 4096;

// Parser states and actions, numbered as xterm numbers them.
const S = Object.freeze({
  GROUND: 0, ESCAPE: 1, ESCAPE_INTERMEDIATE: 2, CSI_ENTRY: 3, CSI_PARAM: 4, CSI_INTERMEDIATE: 5,
  CSI_IGNORE: 6, SOS_PM_APC_STRING: 7, OSC_STRING: 8, DCS_ENTRY: 9, DCS_PARAM: 10, DCS_IGNORE: 11,
  DCS_INTERMEDIATE: 12, DCS_PASSTHROUGH: 13,
});
const A = Object.freeze({
  IGNORE: 0, ERROR: 1, PRINT: 2, EXECUTE: 3, OSC_START: 4, OSC_PUT: 5, OSC_END: 6, CSI_DISPATCH: 7,
  PARAM: 8, COLLECT: 9, ESC_DISPATCH: 10, CLEAR: 11, DCS_HOOK: 12, DCS_PUT: 13, DCS_UNHOOK: 14,
});
const STATES = Object.values(S).length;
//: Every code point at or above this is one class, as in xterm.
const NON_ASCII = 0xa0;
const CLASSES = NON_ASCII + 1;

/** The VT500 table, `[action, next]` per (state, class), built in xterm's order. */
const TRANSITIONS = (() => {
  const table = Array.from({ length: STATES * CLASSES }, () => [A.ERROR, S.GROUND]);
  const r = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);
  const add = (codes, state, action, next) => { for (const code of codes) table[state * CLASSES + code] = [action, next]; };
  const PRINTABLES = r(0x20, 0x7f);
  const EXECUTABLES = [...r(0x00, 0x18), 0x19, ...r(0x1c, 0x20)];

  add(PRINTABLES, S.GROUND, A.PRINT, S.GROUND);
  for (let state = 0; state < STATES; state += 1) {
    add([0x18, 0x1a, 0x99, 0x9a], state, A.EXECUTE, S.GROUND);
    add(r(0x80, 0x90), state, A.EXECUTE, S.GROUND);
    add(r(0x90, 0x98), state, A.EXECUTE, S.GROUND);
    add([0x9c], state, A.IGNORE, S.GROUND);
    add([0x1b], state, A.CLEAR, S.ESCAPE);
    add([0x9d], state, A.OSC_START, S.OSC_STRING);
    add([0x98, 0x9e, 0x9f], state, A.IGNORE, S.SOS_PM_APC_STRING);
    add([0x9b], state, A.CLEAR, S.CSI_ENTRY);
    add([0x90], state, A.CLEAR, S.DCS_ENTRY);
  }
  add(EXECUTABLES, S.GROUND, A.EXECUTE, S.GROUND);
  add(EXECUTABLES, S.ESCAPE, A.EXECUTE, S.ESCAPE);
  add([0x7f], S.ESCAPE, A.IGNORE, S.ESCAPE);
  add(EXECUTABLES, S.OSC_STRING, A.IGNORE, S.OSC_STRING);
  add(EXECUTABLES, S.CSI_ENTRY, A.EXECUTE, S.CSI_ENTRY);
  add([0x7f], S.CSI_ENTRY, A.IGNORE, S.CSI_ENTRY);
  add(EXECUTABLES, S.CSI_PARAM, A.EXECUTE, S.CSI_PARAM);
  add([0x7f], S.CSI_PARAM, A.IGNORE, S.CSI_PARAM);
  add(EXECUTABLES, S.CSI_IGNORE, A.EXECUTE, S.CSI_IGNORE);
  add(EXECUTABLES, S.CSI_INTERMEDIATE, A.EXECUTE, S.CSI_INTERMEDIATE);
  add([0x7f], S.CSI_INTERMEDIATE, A.IGNORE, S.CSI_INTERMEDIATE);
  add(EXECUTABLES, S.ESCAPE_INTERMEDIATE, A.EXECUTE, S.ESCAPE_INTERMEDIATE);
  add([0x7f], S.ESCAPE_INTERMEDIATE, A.IGNORE, S.ESCAPE_INTERMEDIATE);
  // osc
  add([0x5d], S.ESCAPE, A.OSC_START, S.OSC_STRING);
  add(PRINTABLES, S.OSC_STRING, A.OSC_PUT, S.OSC_STRING);
  add([0x7f], S.OSC_STRING, A.OSC_PUT, S.OSC_STRING);
  add([0x9c, 0x1b, 0x18, 0x1a, 0x07], S.OSC_STRING, A.OSC_END, S.GROUND);
  add(r(0x1c, 0x20), S.OSC_STRING, A.IGNORE, S.OSC_STRING);
  // sos/pm/apc
  add([0x58, 0x5e, 0x5f], S.ESCAPE, A.IGNORE, S.SOS_PM_APC_STRING);
  add(PRINTABLES, S.SOS_PM_APC_STRING, A.IGNORE, S.SOS_PM_APC_STRING);
  add(EXECUTABLES, S.SOS_PM_APC_STRING, A.IGNORE, S.SOS_PM_APC_STRING);
  add([0x9c], S.SOS_PM_APC_STRING, A.IGNORE, S.GROUND);
  add([0x7f], S.SOS_PM_APC_STRING, A.IGNORE, S.SOS_PM_APC_STRING);
  // csi
  add([0x5b], S.ESCAPE, A.CLEAR, S.CSI_ENTRY);
  add(r(0x40, 0x7f), S.CSI_ENTRY, A.CSI_DISPATCH, S.GROUND);
  add(r(0x30, 0x3c), S.CSI_ENTRY, A.PARAM, S.CSI_PARAM);
  add([0x3c, 0x3d, 0x3e, 0x3f], S.CSI_ENTRY, A.COLLECT, S.CSI_PARAM);
  add(r(0x30, 0x3c), S.CSI_PARAM, A.PARAM, S.CSI_PARAM);
  add(r(0x40, 0x7f), S.CSI_PARAM, A.CSI_DISPATCH, S.GROUND);
  add([0x3c, 0x3d, 0x3e, 0x3f], S.CSI_PARAM, A.IGNORE, S.CSI_IGNORE);
  add(r(0x20, 0x40), S.CSI_IGNORE, A.IGNORE, S.CSI_IGNORE);
  add([0x7f], S.CSI_IGNORE, A.IGNORE, S.CSI_IGNORE);
  add(r(0x40, 0x7f), S.CSI_IGNORE, A.IGNORE, S.GROUND);
  add(r(0x20, 0x30), S.CSI_ENTRY, A.COLLECT, S.CSI_INTERMEDIATE);
  add(r(0x20, 0x30), S.CSI_INTERMEDIATE, A.COLLECT, S.CSI_INTERMEDIATE);
  add(r(0x30, 0x40), S.CSI_INTERMEDIATE, A.IGNORE, S.CSI_IGNORE);
  add(r(0x40, 0x7f), S.CSI_INTERMEDIATE, A.CSI_DISPATCH, S.GROUND);
  add(r(0x20, 0x30), S.CSI_PARAM, A.COLLECT, S.CSI_INTERMEDIATE);
  // esc_intermediate
  add(r(0x20, 0x30), S.ESCAPE, A.COLLECT, S.ESCAPE_INTERMEDIATE);
  add(r(0x20, 0x30), S.ESCAPE_INTERMEDIATE, A.COLLECT, S.ESCAPE_INTERMEDIATE);
  add(r(0x30, 0x7f), S.ESCAPE_INTERMEDIATE, A.ESC_DISPATCH, S.GROUND);
  add(r(0x30, 0x50), S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  add(r(0x51, 0x58), S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  add([0x59, 0x5a, 0x5c], S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  add(r(0x60, 0x7f), S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  // dcs entry
  add([0x50], S.ESCAPE, A.CLEAR, S.DCS_ENTRY);
  add(EXECUTABLES, S.DCS_ENTRY, A.IGNORE, S.DCS_ENTRY);
  add([0x7f], S.DCS_ENTRY, A.IGNORE, S.DCS_ENTRY);
  add(r(0x1c, 0x20), S.DCS_ENTRY, A.IGNORE, S.DCS_ENTRY);
  add(r(0x20, 0x30), S.DCS_ENTRY, A.COLLECT, S.DCS_INTERMEDIATE);
  add(r(0x30, 0x3c), S.DCS_ENTRY, A.PARAM, S.DCS_PARAM);
  add([0x3c, 0x3d, 0x3e, 0x3f], S.DCS_ENTRY, A.COLLECT, S.DCS_PARAM);
  add(EXECUTABLES, S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  add(r(0x20, 0x80), S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  add(r(0x1c, 0x20), S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  add(EXECUTABLES, S.DCS_PARAM, A.IGNORE, S.DCS_PARAM);
  add([0x7f], S.DCS_PARAM, A.IGNORE, S.DCS_PARAM);
  add(r(0x1c, 0x20), S.DCS_PARAM, A.IGNORE, S.DCS_PARAM);
  add(r(0x30, 0x3c), S.DCS_PARAM, A.PARAM, S.DCS_PARAM);
  add([0x3c, 0x3d, 0x3e, 0x3f], S.DCS_PARAM, A.IGNORE, S.DCS_IGNORE);
  add(r(0x20, 0x30), S.DCS_PARAM, A.COLLECT, S.DCS_INTERMEDIATE);
  add(EXECUTABLES, S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_INTERMEDIATE);
  add([0x7f], S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_INTERMEDIATE);
  add(r(0x1c, 0x20), S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_INTERMEDIATE);
  add(r(0x20, 0x30), S.DCS_INTERMEDIATE, A.COLLECT, S.DCS_INTERMEDIATE);
  add(r(0x30, 0x40), S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_IGNORE);
  add(r(0x40, 0x7f), S.DCS_INTERMEDIATE, A.DCS_HOOK, S.DCS_PASSTHROUGH);
  add(r(0x40, 0x7f), S.DCS_PARAM, A.DCS_HOOK, S.DCS_PASSTHROUGH);
  add(r(0x40, 0x7f), S.DCS_ENTRY, A.DCS_HOOK, S.DCS_PASSTHROUGH);
  add(EXECUTABLES, S.DCS_PASSTHROUGH, A.DCS_PUT, S.DCS_PASSTHROUGH);
  add(PRINTABLES, S.DCS_PASSTHROUGH, A.DCS_PUT, S.DCS_PASSTHROUGH);
  add([0x7f], S.DCS_PASSTHROUGH, A.IGNORE, S.DCS_PASSTHROUGH);
  add([0x1b, 0x9c, 0x18, 0x1a], S.DCS_PASSTHROUGH, A.DCS_UNHOOK, S.GROUND);
  // special handling of unicode chars
  add([NON_ASCII], S.GROUND, A.PRINT, S.GROUND);
  add([NON_ASCII], S.OSC_STRING, A.OSC_PUT, S.OSC_STRING);
  add([NON_ASCII], S.CSI_IGNORE, A.IGNORE, S.CSI_IGNORE);
  add([NON_ASCII], S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  add([NON_ASCII], S.DCS_PASSTHROUGH, A.DCS_PUT, S.DCS_PASSTHROUGH);
  return table;
})();

/**
 * The raw table entry, `[action, next]`, with no parse-loop override. Exported so a test can compare
 * the port with the table inside the xterm the parity tests run against, entry by entry.
 */
export function vt500TableEntry(state, code) {
  return TRANSITIONS[state * CLASSES + (code < NON_ASCII ? code : NON_ASCII)];
}

/** The table's answer for one code point in one state, including the parse loop's own override. */
function transition(state, code) {
  const [action, next] = TRANSITIONS[state * CLASSES + (code < NON_ASCII ? code : NON_ASCII)];
  // xterm's parse loop, not its table: an ESC that ends an OSC or a DCS passthrough goes on to ESCAPE
  // (`if (code === 0x1b) transition |= ParserState.ESCAPE`), which is how `ESC \` ends a string.
  if (code === 0x1b && (action === A.OSC_END || action === A.DCS_UNHOOK)) return [action, S.ESCAPE];
  return [action, next];
}

//: The states whose sequence is held: every one, besides ground, in which the table EXECUTES an LF.
//: Derived from the table, so a state the table executes controls in cannot be missed.
const HOLDING_STATES = new Set(Object.values(S).filter((state) => state !== S.GROUND && transition(state, LF)[0] === A.EXECUTE));

/** One stream's translation; it keeps the parser state across `translate()` calls. */
export class ConsoleLineFeeds {
  #state = S.GROUND;
  #held = "";
  #holding = false;

  /** The part of `text` that can be written now, translated; an unfinished sequence waits. */
  translate(text) {
    let out = "";
    for (const ch of text) out += this.#step(ch);
    if (this.#holding && this.#held.length > HOLD_LIMIT) {
      out += this.#held;
      this.#held = "";
      this.#holding = false;
    }
    return out;
  }

  #step(ch) {
    const code = ch.codePointAt(0);
    const [action, next] = transition(this.#state, code);
    const from = this.#state;
    this.#state = next;
    if (code === LF && action === A.EXECUTE) {
      // Executed where it stands: ground, or inside a held sequence (written ahead of it). Past the
      // ceiling the sequence is no longer held and its start is already written, so it passes as is.
      return from === S.GROUND || this.#holding ? INDEX : ch;
    }
    // ESC and the C1 introducers start a new sequence and abandon a held one; `[` after ESC is the
    // same CLEAR action but continues the sequence it belongs to.
    const enteringNewSequence = action === A.CLEAR && (code === 0x1b || code >= 0x80);
    if (HOLDING_STATES.has(next) && HOLDING_STATES.has(from) && !enteringNewSequence) {
      if (!this.#holding) return ch;
      this.#held += ch;
      return "";
    }
    // Leaving the held sequence (it ended, was cancelled, or turned into a string), or starting a new
    // one: what was held goes out first.
    const released = this.#held;
    this.#held = "";
    this.#holding = HOLDING_STATES.has(next);
    if (this.#holding) {
      this.#held = ch;
      return released;
    }
    return `${released}${ch}`;
  }
}
