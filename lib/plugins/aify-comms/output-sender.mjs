// Terminal output reaches the service IN ORDER, one POST per terminal at a time.
//
// WHAT WAS WRONG. Every pty chunk fired its own `void api.terminalOutput(...)` with no ordering and
// no bound. The service assigns `output_seq` in ARRIVAL order and its own comment says what follows:
// concurrent POSTs reorder against seq and the console is scrambled. Two chunks in flight at once is
// enough, and a busy agent produces far more than two. External review, Round 8 M3, which also names
// this as a second candidate cause for the "scrambled console" a width fix was credited with.
//
// ONE IN FLIGHT PER TERMINAL, and per terminal rather than globally: two agents' consoles have no
// ordering relationship with each other, and serialising them together would make a slow service on
// one terminal stall every other. Ordering is a per-stream property.
//
// COALESCING IS WHAT MAKES IT BOUNDED. While a POST is in flight, further chunks append to one
// pending buffer rather than queueing one job each -- so a service that stops answering costs a
// buffer per terminal, not an unbounded list of promises. That is also the shape the service's own
// `TERMINAL_OUTPUT_WRITES` queue uses on the other side of the wire, for the same reason: a console
// stream is a stream, and joining two adjacent chunks loses nothing a reader can see.
//
// ONE POST PER WINDOW, NOT ONE PER CHUNK. The service answers in milliseconds, so the in-flight merge
// above rarely had anything to merge: nine working agents posted ~34 times a second and held the
// service at 20-35% of a core (measured 2026-10-13). A terminal now posts at most once per
// COALESCE_MS. The first chunk of a quiet stream still goes at once, so a typed key echoes without
// waiting; a burst past FLUSH_AT_CHARS goes at once; and an exit or a detach flushes at once.
//
// AND IT STILL NEVER THROWS AT THE CALLER. This sits under a pty listener; there is nobody above it
// to hand an error to. A failed POST is reported and the next chunk is still attempted -- dropping
// the stream because the service blinked would turn a transient outage into a dead console.

/** How much pending output to hold per terminal before dropping the OLDEST bytes. */
export const MAX_PENDING_CHARS = 256 * 1024;

/** The least time between two posts of one terminal's output; what arrives between them goes in one post. */
export const COALESCE_MS = 100;

/** Pending output this large is posted at once rather than at the end of its window. */
export const FLUSH_AT_CHARS = 64 * 1024;

/** How long `drained` waits for a terminal's queue to empty before answering that it did not. */
const DRAIN_WAIT_MS = 2000;
//: How often it looks. Five milliseconds is far below the round trip it is waiting on, and the wait
//: costs nothing when there is nothing queued -- the first look answers.
const DRAIN_POLL_MS = 5;

/**
 * A per-terminal, order-preserving sender.
 *
 * @param {object} deps
 * @param {(terminalId: string, body: object) => Promise<any>} deps.post  usually `api.terminalOutput`
 * @param {(message: string) => void} [deps.log]
 * @param {string} [deps.status]  the status each frame carries, e.g. `attached`
 * @param {() => number} [deps.now]  the clock the window is measured on
 */
export function createOutputSender({ post, log = () => {}, status = "", now = Date.now, setTimer = setTimeout,
  clearTimer = clearTimeout }) {
  /**
   * Say something, and never let saying it become the failure.
   *
   * `log` is the CALLER'S function, and every drain runs as `void drain(terminalId)`, so a logger that
   * throws would escape as an unhandled rejection in the daemon. Both call sites announce something that
   * has ALREADY happened, so a failure to announce is never a reason to stop delivering output.
   */
  function announce(message) {
    try {
      log(message);
    } catch {
      // Deliberately silent: the only thing left to report it with is the thing that just failed.
    }
  }

  /** @type {Map<string, {inFlight: boolean, pending: string, dropped: number, timer: any, lastPostAt: number}>} */
  const streams = new Map();

  function stateFor(terminalId) {
    let state = streams.get(terminalId);
    if (!state) {
      state = { inFlight: false, pending: "", dropped: 0, timer: null, lastPostAt: -Infinity };
      streams.set(terminalId, state);
    }
    return state;
  }

  // A drain and its re-arm carry the STATE they started with, not the terminal id: a terminal forgotten while a post
  // was in flight (an exit whose drain timed out) still posts what was queued behind it, late but not lost (review of
  // 179e63e; the sender before it did the same through its loop).

  /** Post what is pending now, or arm the end of its window to. A post in flight re-arms when it settles. */
  function schedule(terminalId, state = streams.get(terminalId)) {
    if (!state || !state.pending || state.inFlight) return;
    const wait = state.lastPostAt + COALESCE_MS - now();
    // Past the cap it goes now, an armed window or not (drain clears the timer).
    if (wait <= 0 || state.pending.length >= FLUSH_AT_CHARS) {
      void drain(terminalId, state);
      return;
    }
    if (state.timer) return;
    state.timer = setTimer(() => {
      state.timer = null;
      void drain(terminalId, state);
    }, wait);
    state.timer?.unref?.();
  }

  /** Post everything pending in one POST, now; the window then decides when the next goes. */
  async function drain(terminalId, state = streams.get(terminalId)) {
    if (!state || state.inFlight) return;
    if (state.timer) {
      clearTimer(state.timer);
      state.timer = null;
    }
    if (!state.pending) return;
    state.inFlight = true;
    const body = state.pending;
    state.pending = "";
    try {
      if (state.dropped) {
        // SAID, NOT SILENT. A console with a hole in it that says so is debuggable; one that does
        // not is a bug report about an agent behaving strangely.
        announce(`terminal ${terminalId}: dropped ${state.dropped} character(s) of output the `
          + "service could not keep up with");
        state.dropped = 0;
      }
      state.lastPostAt = now();
      try {
        await post(terminalId, status ? { output: body, status } : { output: body });
      } catch (error) {
        announce(`terminal ${terminalId} output not delivered: ${error?.message || error}`);
      }
    } finally {
      state.inFlight = false;
      // Whatever arrived while it was in flight goes next, at the end of this post's window.
      schedule(terminalId, state);
    }
  }

  return {
    /** Queue one chunk. Returns immediately: a pty listener may not be made to wait. */
    send(terminalId, chunk) {
      const text = String(chunk ?? "");
      if (!text) return;
      const state = stateFor(terminalId);
      // What is already pending goes before a chunk that would carry it past the cap, rather than being dropped as
      // the oldest when nothing is in flight to wait for.
      if (!state.inFlight && state.pending && state.pending.length + text.length > FLUSH_AT_CHARS) void drain(terminalId, state);
      state.pending += text;
      if (state.pending.length > MAX_PENDING_CHARS) {
        // THE OLDEST GOES, not the newest. A console is read from the bottom: the recent screen is
        // what an operator and every classifier need, and keeping the head while discarding the tail
        // would preserve exactly the part nobody is looking at.
        const over = state.pending.length - MAX_PENDING_CHARS;
        state.pending = state.pending.slice(over);
        state.dropped += over;
      }
      schedule(terminalId);
    },

    /**
     * Post this terminal's queue NOW, and resolve once it has nothing queued and nothing in flight.
     *
     * WHAT IT IS FOR. A process's EXIT is announced by a different call than its output: the exit
     * marker carries a status and an exit code, which `send` cannot express, so it goes out through
     * `api.terminalOutput` directly, after this. An exit does not wait out the window.
     *
     * @returns {Promise<boolean>} whether it actually drained. FALSE IS A REAL ANSWER: a service
     *   that has stopped responding must not hold an exit marker for ever, so the caller proceeds
     *   and can say that the order is not guaranteed for this one.
     */
    async drained(terminalId, timeoutMs = DRAIN_WAIT_MS) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
      for (;;) {
        const state = streams.get(terminalId);
        if (!state || (!state.pending && !state.inFlight)) return true;
        if (!state.inFlight) void drain(terminalId);
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
      }
    },

    /** Flush every terminal at once, for a detaching plugin. @returns {Promise<boolean>} whether all drained. */
    async flushAll(timeoutMs = DRAIN_WAIT_MS) {
      const settled = await Promise.all([...streams.keys()].map((id) => this.drained(id, timeoutMs)));
      return settled.every(Boolean);
    },

    /** Stop tracking a terminal that has gone. Pending output is dropped with it. */
    forget(terminalId) {
      const state = streams.get(terminalId);
      if (state?.timer) clearTimer(state.timer);
      streams.delete(terminalId);
    },

    /** For tests and diagnostics: how much is waiting, and whether a POST is in flight. */
    pendingFor(terminalId) {
      const state = streams.get(terminalId);
      return state ? { pending: state.pending.length, inFlight: state.inFlight } : null;
    },
  };
}
