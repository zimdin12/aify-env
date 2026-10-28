// The view's refresh: collect, then draw, on an interval, one collection at a time; and whether the view has stopped.
// In: `collect()`. Out: each snapshot, to `onSnapshot`.

export class RefreshLoop {
  #collect;
  #onSnapshot;
  #intervalMs;
  #timer = null;
  //: ONE COLLECTION AT A TIME (v0.7 scan, F26). See `start`.
  #collecting = false;
  // STOPPED IS CHECKED AFTER THE AWAIT, not only before the timer is cleared. Collecting a snapshot is IO: `stop()` can
  // land while one is in flight, and clearing the interval does nothing about a frame that has already begun. It
  // painted one more screen after the operator quit.
  //
  // Latent until it was not. The collection used to be two HTTP knocks and finished inside the gap; adding the health
  // checks made it long enough for the race to be the normal case, and its own test caught it -- "frames kept arriving
  // after stop(), 4 !== 3". In the daemon that frame lands during teardown, over whatever the shutdown is printing.
  #stopped = false;
  //: The last snapshot drawn, so a redraw that needs no new facts can reuse it. Null until the first collection lands,
  //: which is why `redraw` does nothing before then.
  #last = null;

  /**
   * @param {{collect: () => Promise<object>, onSnapshot: (snapshot: object) => void, intervalMs: number}} deps
   */
  constructor({ collect, onSnapshot, intervalMs }) {
    this.#collect = collect;
    this.#onSnapshot = onSnapshot;
    this.#intervalMs = intervalMs;
  }

  /** Whether the view has stopped. */
  get stopped() { return this.#stopped; }

  /**
   * Ask for the world, then draw it.
   *
   * COLLECTING IS IO AND RENDERING IS NOT, and until 0.7 they were one function. Every branch of the key handler ended
   * in this, so moving the cursor one row re-asked the daemon for everything before the screen moved -- MEASURED at
   * `1 + N` round trips per keystroke, N being the registered services. A key changes the SELECTION, and no request
   * can tell us anything about that: keys `redraw`.
   */
  async draw() {
    const snapshot = await this.#collect();
    if (this.#stopped) return;
    this.#last = snapshot;
    this.#onSnapshot(snapshot);
  }

  /**
   * Draw again from the facts already in hand.
   *
   * THE SAME DRAW, NOT A LIGHTER ONE. Reconciliation, composition and the readiness report all run exactly as they do
   * after a collection; the only difference is that the roster may be up to `intervalMs` old, which is what every
   * other terminal view also shows between refreshes.
   *
   * SWALLOWS, because the calls it replaced did: a keystroke that could not be drawn must not kill the view, and the
   * next frame still draws.
   */
  redraw() {
    if (!this.#last) return;
    try {
      this.#onSnapshot(this.#last);
    } catch {
      // The next frame still draws.
    }
  }

  /**
   * Keep drawing. A frame that throws must not kill the loop: the usual reason to have this open is watching for the
   * moment something comes back.
   *
   * ONE COLLECTION AT A TIME (v0.7 scan, F26). Service probes run in sequence with their own timeouts, so a collection
   * can outlast the interval; a tick that started another beside it let an older snapshot paint over a newer one. A
   * tick that finds one still running is skipped.
   */
  start() {
    this.#timer = setInterval(() => {
      if (this.#collecting) return;
      this.#collecting = true;
      this.draw().catch(() => {}).finally(() => { this.#collecting = false; });
    }, this.#intervalMs);
    // Never hold the process open on its own account. A daemon exits when its own work says so.
    this.#timer.unref?.();
  }

  /** SET FIRST. A frame already awaiting IO checks this on the way back; clearing the interval only stops frames that have not started. */
  stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
  }
}
