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
 *   <u      pop a keyboard-protocol level         0m     reset the pen
 *
 * Leaving the alternate screen comes first: it restores the cursor saved on entry.
 */
export const LOCAL_SCREEN_LEAVE = [
  "?1049l", "?25h", "?1000l", "?1002l", "?1003l", "?1006l", "?2004l", "<u", "0m",
].map((mode) => `${ESC}[${mode}`).join("");

/**
 * A write-through buffer for OutputFollower that resets the local screen before the first chunk.
 *
 * NOT BEFORE THE STREAM OPENS. A process with nothing to show yet leaves the terminal as it was, so
 * the attach notice stays readable until there is something to replace it with.
 */
export function passthrough(write) {
  let cleared = false;
  return {
    append(text) {
      if (!cleared) {
        cleared = true;
        write(LOCAL_SCREEN_RESET);
      }
      write(text);
    },
  };
}
