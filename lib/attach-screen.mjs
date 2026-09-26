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
export class KeyboardLevels {
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

/**
 * A write-through buffer for OutputFollower that resets the local screen before the first chunk.
 *
 * NOT BEFORE THE STREAM OPENS. A process with nothing to show yet leaves the terminal as it was, so
 * the attach notice stays readable until there is something to replace it with.
 *
 * `leave()` is what detaching writes, owing back exactly the keyboard levels this stream pushed.
 */
export function passthrough(write) {
  let cleared = false;
  const levels = new KeyboardLevels();
  return {
    append(text) {
      if (!cleared) {
        cleared = true;
        write(LOCAL_SCREEN_RESET);
      }
      levels.observe(text);
      write(text);
    },
    leave: () => levels.leaveSequence(),
  };
}
