// What `aify-env attach` writes to the operator's terminal before the process's own bytes.
//
// A LATE SUBSCRIBER PAINTS ONTO WHATEVER IS ALREADY THERE. The replay is a suffix and positions its
// text with cursor moves, so every cell it does not touch keeps what the local terminal showed before
// -- a shell, an earlier attach -- and the two ghost together until the agent redraws those cells.
// The screen has to be put in a known empty state first.
//
// FOUR SEQUENCES, EACH FOR A REASON:
//
//   ESC[?1049l  leave the alternate screen. A previous attach to a full-screen program can leave the
//               terminal there (a client killed before it could write LOCAL_SCREEN_LEAVE), and a checkpoint
//               assumes the normal screen is active -- it switches to the alternate one itself when
//               the process is in it. Leaving it when not in it changes nothing we keep.
//   ESC[0m      reset the pen, or the first unstyled cell inherits whatever colour was left set.
//   ESC[H       home, because a checkpoint paints row by row from where the cursor stands.
//   ESC[2J      erase the display.
//
// SCROLLBACK IS NOT ERASED. `ESC[3J` would throw away the operator's own history above the pane, and
// ghosting only ever happens on the visible grid: scrollback lines are never composited with live
// cells. Deleting it would cost them something and fix nothing.

const ESC = String.fromCharCode(27);

export const LOCAL_SCREEN_RESET = `${ESC}[?1049l${ESC}[0m${ESC}[H${ESC}[2J`;

/**
 * What detaching writes, so the operator's shell does not inherit the agent's terminal modes.
 *
 * THE DEFECT (v0.7 scan, F10). Detaching restored raw mode and nothing else, so whatever the agent
 * had switched on stayed on after Ctrl+] or after it exited: the shell printed onto the alternate
 * screen, the cursor stayed invisible, and clicks typed escape junk. Each reset is harmless when its
 * mode was never set, which is why all of them are sent rather than guessing which were:
 *
 *   ?1049l  leave the alternate screen            ?25h   show the cursor
 *   ?1000l ?1002l ?1003l ?1006l  mouse tracking   ?2004l bracketed paste
 *   ?1004l  focus reporting                       ?1l    normal cursor keys (DECCKM)
 *   0m      reset the pen
 *
 * Leaving the alternate screen comes first: it restores the cursor saved on entry.
 *
 * NO KEYBOARD-PROTOCOL POP HERE, because that one is NOT harmless when unset (v0.7.1 review, W14):
 * a pop the agent did not push takes a level off the operator's own stack. `KeyboardLevels` pops
 * exactly what the agent left pushed.
 */
export const LOCAL_SCREEN_LEAVE = [
  "?1049l", "?25h", "?1000l", "?1002l", "?1003l", "?1006l", "?2004l", "?1004l", "?1l", "0m",
].map((mode) => `${ESC}[${mode}`).join("");

//: A kitty keyboard-protocol push (`CSI > flags u`), a pop (`CSI < n u`), or the alternate screen
//: being entered or left (`?1049`, `?1047`, `?47`).
const KEYBOARD_OR_SCREEN = /\x1b\[(?:(>)[0-9;]*u|<([0-9]*)u|\?(?:1049|1047|47)([hl]))/g;
//: The longest unfinished sequence carried to the next read. Anything longer is not one of ours.
const CARRY_LIMIT = 16;

/**
 * The keyboard-protocol levels an agent's output has pushed onto this terminal and not popped.
 *
 * PER SCREEN, because the kitty specification requires it: "The main and alternate screens in the
 * terminal emulator must maintain their own, independent, keyboard mode stacks." A level pushed on
 * the alternate screen has to be popped while the alternate screen is showing.
 *
 * ACROSS READS, because a sequence can be split anywhere between two chunks of the stream.
 */
class KeyboardLevels {
  #pushed = { main: 0, alternate: 0 };
  #screen = "main";
  #carry = "";

  /** Count what one chunk of the agent's output pushes, pops and switches. */
  observe(text) {
    let data = `${this.#carry}${text}`;
    this.#carry = "";
    const tail = data.lastIndexOf(ESC);
    if (tail >= 0 && data.length - tail < CARRY_LIMIT && !/^\x1b(?:\[[0-?]*[ -/]*[@-~]|[^[])/.test(data.slice(tail))) {
      this.#carry = data.slice(tail);
      data = data.slice(0, tail);
    }
    for (const [, push, pop, screen] of data.matchAll(KEYBOARD_OR_SCREEN)) {
      if (screen) this.#screen = screen === "h" ? "alternate" : "main";
      else if (push) this.#pushed[this.#screen] += 1;
      else this.#pushed[this.#screen] = Math.max(0, this.#pushed[this.#screen] - (Number(pop) || 1));
    }
  }

  /**
   * The whole leave sequence: the alternate screen's levels popped ON the alternate screen (visiting
   * it if the agent had already left it), then `LOCAL_SCREEN_LEAVE`, then the main screen's levels.
   */
  leaveSequence() {
    const pop = (n) => (n > 0 ? `${ESC}[<${n}u` : "");
    const { main, alternate } = this.#pushed;
    const visit = alternate > 0 && this.#screen === "main" ? `${ESC}[?1049h` : "";
    return `${visit}${pop(alternate)}${LOCAL_SCREEN_LEAVE}${pop(main)}`;
  }
}

//: ESC D, Index: down one row in the same column, scrolling at the bottom margin. What LF means to
//: a VT terminal, with no carriage return a console can add.
const INDEX = `${ESC}D`;
//: How much of one escape or CSI sequence is held back. Past it the held bytes are written and the
//: rest of THAT sequence passes as it comes; the parser state is kept either way.
const HOLD_LIMIT = 4096;
//: C1 controls a parser also accepts as single code points, and the state each one enters.
const C1_STATES = new Map([
  [0x9b, "csi"], [0x9d, "osc"], [0x90, "string"], [0x98, "string"], [0x9e, "string"], [0x9f, "string"],
  [0x9c, "ground"],
]);
//: The escape finals that open a control string instead of ending the sequence.
const ESCAPE_STRING_STATES = new Map([["]", "osc"], ["P", "string"], ["X", "string"], ["^", "string"], ["_", "string"]]);

/**
 * A stream's line feeds as a Windows console needs them: Index wherever a VT parser would execute LF.
 *
 * THE DEFECT (2026-09-30), the scrambled herdr pane. On Windows the process's PTY is a ConPTY, and
 * ConPTY moves the cursor down with a bare LF, meaning "same column". A console treats a program's
 * LF as CR+LF unless DISABLE_NEWLINE_AUTO_RETURN is set, and Node cannot set it. So in a herdr pane,
 * or any Windows terminal, that row went back to column 1, and what it did not cover stayed behind:
 * "bot-" for "both", stray box-drawing at column 0. Measured by replaying a recorded hermes stream
 * through a ConPTY into xterm: it diverged at the first `CUP; LF; text` (chunk 664 of 4470) through the
 * system ConPTY and through herdr's own, and matched to the end with this translation.
 *
 * ONLY WHERE A PARSER EXECUTES LF (reviews of e880d48 and 0557d21). An emulator must end in the same
 * state reading the stream or the translated stream, so this follows the VT500 parser across chunks:
 *
 *   anywhere     CAN and SUB end any sequence or string (ground); ESC starts an escape; the C1
 *                introducers (CSI 0x9B, OSC 0x9D, DCS 0x90, SOS 0x98, PM 0x9E, APC 0x9F) start
 *                theirs, and ST (0x9C) ends a string.
 *   ground       LF becomes Index.
 *   escape, csi  the sequence is HELD until its final byte, and an LF inside it is written as Index
 *                at once, ahead of the held bytes. Equivalent because LF only moves the row, the other
 *                C0 controls a parser executes there only move the column (CR, BS, HT) or nothing,
 *                and a sequence acts only at its final byte.
 *   osc          passes untouched to BEL, ST or ESC \; a parser ignores an LF there.
 *   string       DCS, SOS, PM, APC: pass untouched to ST or ESC \. BEL does NOT end them.
 *
 * A sequence longer than HOLD_LIMIT is written as it stands and the rest of it passes as it comes: the
 * state is kept, so the parser and this stay in step, and an LF inside that one sequence is written
 * as it came. That is the supported boundary; no length is treated as illegal.
 *
 * `translate()` returns what can be written now; bytes of an unfinished sequence come out with the
 * chunk that finishes it, which is when a terminal could act on them anyway.
 */
export class ConsoleLineFeeds {
  #state = "ground";
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
    if (code === 0x18 || code === 0x1a) return this.#enter("ground", ch);
    if (ch === ESC) return this.#enter("escape", ch, { hold: true });
    if (C1_STATES.has(code)) return this.#enter(C1_STATES.get(code), ch, { hold: code === 0x9b });
    switch (this.#state) {
      case "ground":
        return ch === "\n" ? INDEX : ch;
      case "osc":
        if (ch === "\x07") this.#state = "ground";
        return ch;
      case "string":
        return ch;
      default:
        return this.#inSequence(ch, code);
    }
  }

  /** Escape and CSI: hold, and say where an executed LF goes. */
  #inSequence(ch, code) {
    if (ch === "\n") return this.#holding ? INDEX : ch;
    if (code < 0x20 || code === 0x7f) return this.#keep(ch);                    // executed in place
    if (this.#state === "escape") {
      if (ch === "[") { this.#state = "csi"; return this.#keep(ch); }
      if (ESCAPE_STRING_STATES.has(ch)) return this.#enter(ESCAPE_STRING_STATES.get(ch), ch);
      if (code >= 0x20 && code <= 0x2f) return this.#keep(ch);                  // intermediate
      return this.#enter("ground", ch);                          // final
    }
    if (code >= 0x40 && code <= 0x7e) return this.#enter("ground", ch); // CSI final
    return this.#keep(ch);                                                         // parameter, intermediate
  }

  /** Add `ch` to the held sequence, or pass it when this sequence is no longer held. */
  #keep(ch) {
    if (!this.#holding) return ch;
    this.#held += ch;
    return "";
  }

  /**
   * Enter `state` on `ch`, releasing what was held: `ch` either starts a new held sequence (`hold`) or
   * is written after the released bytes, which it completes or cancels.
   */
  #enter(state, ch, { hold = false } = {}) {
    const released = this.#held;
    this.#state = state;
    this.#holding = hold;
    this.#held = hold ? ch : "";
    return hold ? released : `${released}${ch}`;
  }
}

/**
 * A write-through buffer for OutputFollower that resets the local screen before the first chunk.
 *
 * NOT BEFORE THE STREAM OPENS. A process with nothing to show yet leaves the terminal as it was, so
 * the attach notice stays readable until there is something to replace it with.
 *
 * `leave()` is what detaching writes, owing back exactly the keyboard levels this stream pushed.
 * On Windows the stream's line feeds are written as Index (`ConsoleLineFeeds`).
 */
export function passthrough(write, { platform = process.platform } = {}) {
  let cleared = false;
  const levels = new KeyboardLevels();
  const lineFeeds = platform === "win32" ? new ConsoleLineFeeds() : null;
  const forConsole = lineFeeds ? (text) => lineFeeds.translate(text) : (text) => text;
  return {
    append(text) {
      if (!cleared) {
        cleared = true;
        write(LOCAL_SCREEN_RESET);
      }
      levels.observe(text);
      write(forConsole(text));
    },
    leave: () => levels.leaveSequence(),
  };
}
