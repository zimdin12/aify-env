// The view's keyboard: the caller's terminal in raw mode while the view runs, its reads decoded and handed to the
// session one key at a time, input held for the rest of a paste marker let go when the terminal goes quiet, and the
// terminal given back as it was found.
//
// RAW MODE IS THE CALLER'S TERMINAL, so it is restored on the way out no matter which way we leave. A view that exits
// leaving the terminal in raw mode hands the operator a shell that no longer echoes what they type, and the fix for
// that is not obvious to anyone it happens to.

import { StringDecoder } from "node:string_decoder";

export class Keyboard {
  #input;
  #session;
  #act;
  #repaint;
  #isStopped;
  #rawWasOn;
  #onData = null;
  //: The timer that lets held-back input go. See `#scheduleFlush`.
  #flushTimer = null;

  /**
   * @param {{input: object, session: object, act: (result: object) => boolean, repaint: () => void,
   *   isStopped: () => boolean}} deps  `act` returns true when the view is being left
   */
  constructor({ input, session, act, repaint, isStopped }) {
    this.#input = input;
    this.#session = session;
    this.#act = act;
    this.#repaint = repaint;
    this.#isStopped = isStopped;
    this.#rawWasOn = Boolean(input?.isRaw);
  }

  /** Take the keyboard. */
  start() {
    this.#input.setRawMode?.(true);
    this.#input.resume?.();
    const decoder = new StringDecoder("utf8");
    this.#onData = (chunk) => {
      // NOTHING A CALLBACK DOES MAY REACH THE STREAM. This runs as a `data` listener, so a callback that throws becomes
      // an uncaught exception and the view dies on a keypress -- which a test caught here, having been written on the
      // assumption it could not happen.
      try {
        // DECODED ACROSS READS (v0.7 scan, F23). `String(chunk)` decoded each read on its own, so a character whose
        // bytes straddled two reads -- a large non-ASCII paste -- reached the agent as two replacement characters. One
        // decoder holds the partial bytes until the rest arrives.
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (!text) return;
        // ONE READ MAY CARRY SEVERAL KEYS, handled in order (v0.7 scan, F14). See the session's `handleChunk`.
        for (const result of this.#session.handleChunk(text)) {
          if (this.#act(result)) return;
        }
      } catch {
        // A keystroke that could not be handled is not worth the screen. The next frame still draws.
      }
      this.#scheduleFlush();
      // NO REFETCH. A key changes the selection, and the daemon has nothing to say about that.
      this.#repaint();
    };
    this.#input.on("data", this.#onData);
  }

  /** Give the keyboard back: no held input let go later, the listener off, raw mode as it was, the stream paused. */
  stop() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (!this.#onData) return;
    this.#input.off?.("data", this.#onData);
    if (!this.#rawWasOn) this.#input.setRawMode?.(false);
    this.#input.pause?.();
  }

  /**
   * INPUT HELD BACK FOR THE REST OF A PASTE MARKER is let go once the terminal goes quiet (v0.7.1 review, T06).
   * Rescheduled on every read, so "quiet" is measured from the last one.
   */
  #scheduleFlush() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    const wait = this.#session.inputFlushMs;
    if (wait === null || this.#isStopped()) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (this.#isStopped()) return;
      try {
        for (const result of this.#session.flushInput()) if (this.#act(result)) return;
      } catch {
        // As for a read: a key that could not be handled is not worth the screen.
      }
      this.#repaint();
      // AGAIN, because a paste given up in part is still open and its lost end is timed too.
      this.#scheduleFlush();
    }, wait);
    this.#flushTimer.unref?.();
  }
}
