// The view's screen: what is on it, the difference the next frame writes, the view's own screen while it runs, and the
// rate arriving pane output may redraw at. In: lines. Out: bytes written.
//
// ONLY WHAT CHANGED, when we own a screen. The old loop cleared and repainted every row twice a second whether or not
// one character differed, which the eye reads as flicker and which a side pane with live output in it could not
// survive. `frameUpdate` writes nothing at all for an unchanged frame; see lib/frame.mjs for why the first one still
// clears.
//
// A PIPE IS NOT A SCREEN, and that distinction is why `clearScreen` still gates this. Escapes in a log are noise, and
// a service manager parsing this output would get cursor moves interleaved with the banner. Redirected output keeps
// the plain full write it has always had.

import { ENTER_VIEW, LEAVE_VIEW, frameUpdate } from "../frame.mjs";

export class FrameWriter {
  #write;
  #clearScreen;
  #once;
  #processEvents;
  #paneRepaintMs;
  #release;
  //: The frame currently on screen, so the next one can be a DIFFERENCE rather than a repaint. Empty means we have not
  //: painted yet, which is what makes the first frame clear.
  #previous = [];
  //: Whether this view has switched to its own screen, so `leave` gives it back exactly once.
  #entered = false;
  //: Coalesces pane progress into at most one repaint per `paneRepaintMs`. Null when none is due.
  #paneTimer = null;

  /**
   * @param {{write: (text: string) => void, clearScreen: boolean, once: boolean, processEvents: object|null,
   *   paneRepaintMs: number, onExit: () => void}} deps  `onExit` runs when the process ends with this view up
   */
  constructor({ write, clearScreen, once, processEvents, paneRepaintMs, onExit }) {
    this.#write = write;
    this.#clearScreen = clearScreen;
    this.#once = once;
    this.#processEvents = processEvents;
    this.#paneRepaintMs = paneRepaintMs;
    this.#release = () => onExit();
  }

  /** Put `lines` on the screen. A write that throws leaves the cached frame as it was, and throws. */
  show(lines) {
    if (!this.#clearScreen) {
      this.#write(`${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
      return;
    }
    // A LIVE VIEW DRAWS ON A SCREEN OF ITS OWN, with the cursor hidden (v0.7 scan, F13), and `leave` hands the
    // operator's screen back. Not for a one-shot render: that frame is the output, and it has to still be there after
    // the command exits.
    let bytes = frameUpdate(this.#previous, lines);
    if (!this.#once && !this.#entered && bytes) {
      bytes = `${ENTER_VIEW}${bytes}`;
      this.#entered = true;
      // AND IT IS GIVEN BACK HOWEVER THE PROCESS ENDS (v0.7.1 review, E2). `exit` is emitted for an uncaught exception
      // or rejection too, which no caller's handler saw; the view's stop is synchronous, which is all an `exit`
      // listener gets to be.
      this.#processEvents?.on?.("exit", this.#release);
    }
    // CACHED AFTER THE WRITE SUCCEEDS, never before. Caching first meant a FAILED frame still recorded those lines as on
    // screen -- so re-entering the same state produced no bytes at all, and a readiness that the failure had revoked
    // came straight back with nothing having been drawn. Review measured input reaching bravo while a display oracle
    // fed only successful writes still showed alpha. An intention is not a frame.
    if (bytes) this.#write(bytes);
    this.#previous = lines;
  }

  /**
   * Forget what is on screen, so the next frame is written whole: after a resize, and on Ctrl+L. `frameUpdate` writes
   * only rows that CHANGED against its own model of the screen, so anything that disturbs the screen from outside
   * leaves rows it will never rewrite.
   */
  forget() {
    this.#previous = [];
  }

  /**
   * WHEN THE PANE HAS SOMETHING NEW, DRAW IT -- at a bounded rate. `live()` false means the view is stopping.
   *
   * THIS IS A CORRECTNESS PATH, not a nicety. Input is gated on a STREAMING frame having been drawn, and the refresh
   * timer used to be the only thing that ever redrew, so attaching left the console refusing keys against
   * "connecting..." for up to `intervalMs`. It is also why the pane updated at 0.5 frames a second while the bytes were
   * arriving continuously.
   *
   * BOUNDED, because the alternative is a repaint per chunk from a producer that emits thousands a second. A frame
   * measured 0.9ms at 40 processes, so this floor costs about 1% of a core while a console is open and nothing at all
   * when one is not: no pane, no follower, no progress.
   */
  paneProgress(live, repaint) {
    if (!live() || this.#paneTimer) return;
    this.#paneTimer = setTimeout(() => {
      this.#paneTimer = null;
      // CHECKED AGAIN HERE. `stop()` can land while this timer is pending, and a frame painted during teardown lands
      // over whatever the shutdown is printing.
      if (live()) repaint();
    }, this.#paneRepaintMs);
    this.#paneTimer.unref?.();
  }

  /**
   * A PENDING PANE REPAINT IS A FRAME THAT HAS NOT HAPPENED YET.
   *
   * NO MUTANT CAN KILL THIS TODAY, and saying so is better than implying it is load-bearing: the timer's own callback
   * re-checks `live()` before drawing, and the handle is `unref`d, so removing this clear changes neither what is
   * written nor whether the process can exit. It is kept because a scheduled callback that outlives the thing that
   * scheduled it is a shape this file has been bitten by before.
   */
  cancelPaneRepaint() {
    if (this.#paneTimer) {
      clearTimeout(this.#paneTimer);
      this.#paneTimer = null;
    }
  }

  /** THE OPERATOR'S SCREEN AND CURSOR COME BACK, synchronously: a daemon prints its shutdown onto that screen. */
  leave() {
    if (!this.#entered) return;
    this.#entered = false;
    try { this.#write(LEAVE_VIEW); } catch { /* a terminal that is gone needs nothing back */ }
  }

  /** No longer give the screen back on the process's exit. */
  unhook() {
    this.#processEvents?.off?.("exit", this.#release);
  }
}
