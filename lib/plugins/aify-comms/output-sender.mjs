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
// AND IT STILL NEVER THROWS AT THE CALLER. This sits under a pty listener; there is nobody above it
// to hand an error to. A failed POST is reported and the next chunk is still attempted -- dropping
// the stream because the service blinked would turn a transient outage into a dead console.

/** How much pending output to hold per terminal before dropping the OLDEST bytes. */
export const MAX_PENDING_CHARS = 256 * 1024;

/** How long `drained` waits for a terminal's queue to empty before answering that it did not. */
export const DRAIN_WAIT_MS = 2000;
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
 */
export function createOutputSender({ post, log = () => {}, status = "" }) {
  /**
   * Say something, and never let saying it become the failure.
   *
   * `log` is the CALLER'S function. `drain` is async and every caller invokes it as
   * `void drain(terminalId)`, so a logger that throws does not merely strand the pending chunk --
   * the rejection escapes with nobody to hand it to, which in the daemon is an unhandled rejection.
   * The module's comment below already said this module has no business assuming about a caller's
   * function; it assumed one anyway, by calling it unguarded.
   *
   * Both call sites are notices about something that has ALREADY happened, so a failure to announce
   * is never a reason to stop delivering output.
   */
  function announce(message) {
    try {
      log(message);
    } catch {
      // Deliberately silent: the only thing left to report it with is the thing that just failed.
    }
  }

  /** @type {Map<string, {inFlight: boolean, pending: string, dropped: number}>} */
  const streams = new Map();

  function stateFor(terminalId) {
    let state = streams.get(terminalId);
    if (!state) {
      state = { inFlight: false, pending: "", dropped: 0 };
      streams.set(terminalId, state);
    }
    return state;
  }

  async function drain(terminalId) {
    const state = streams.get(terminalId);
    if (!state || state.inFlight) return;
    state.inFlight = true;
    try {
      while (state.pending) {
        const body = state.pending;
        state.pending = "";
        if (state.dropped) {
          // SAID, NOT SILENT. A console with a hole in it that says so is debuggable; one that does
          // not is a bug report about an agent behaving strangely.
          announce(`terminal ${terminalId}: dropped ${state.dropped} character(s) of output the `
            + "service could not keep up with");
          state.dropped = 0;
        }
        try {
          await post(terminalId, status ? { output: body, status } : { output: body });
        } catch (error) {
          announce(`terminal ${terminalId} output not delivered: ${error?.message || error}`);
        }
      }
    } finally {
      state.inFlight = false;
      // Anything that arrived while the last POST settled: keep going rather than wait for the next
      // chunk to notice, or the tail of a burst sits unsent until the agent speaks again.
      //
      // THIS IS REDUNDANT WITH THE `while` ABOVE FOR EVERY SCENARIO THE SUITE EXERCISES, measured
      // 2026-09-08 and RE-MEASURED the same day against a suite one test longer: removing EITHER
      // alone leaves all eight tests green, and removing BOTH fails FOUR. The figure was three when
      // it was first written and is recorded again rather than left to rot -- a measured number in a
      // comment is only true of the suite it was measured against. `state.pending` is cleared BEFORE
      // the await, so the loop's own re-check already sees whatever arrived during it, and no async
      // boundary exists between the loop exiting and this line for anything to arrive in.
      //
      // KEPT ANYWAY, and the reason is the one case the loop cannot cover: an exception escaping the
      // `while` leaves `pending` unsent. So this is a net under a path nothing currently takes,
      // stated rather than implied, because a reader who finds two mechanisms for one job should
      // know which is the primary and that the other is not dead by accident.
      //
      // THE PATH IT NAMED IS NOW CLOSED AT ITS SOURCE. That source was `log()`, a caller's function,
      // and writing the test this comment invited showed the net was not enough: the throw exits the
      // loop, this `finally` runs, and the rejection then escapes an async `drain` that every caller
      // invokes as `void drain(...)` -- an unhandled rejection in the daemon rather than a stranded
      // chunk. `announce` contains it at the call.
      //
      // AND WHAT THIS HOOK ACTUALLY COVERED IS NARROWER THAN "the pending output", measured by
      // review: throwing from the REJECTED-POST notice does re-arm a body still queued behind it,
      // but throwing from the OVERFLOW notice loses the body already cleared from `pending` -- that
      // one is dequeued before the notice runs, so no re-arm can bring it back. The hook re-arms the
      // QUEUED TAIL; it never protected the dequeued body and does not establish exception safety.
      // It stays because a re-arm of the tail is worth one predicate, not because it is a guarantee.
      if (streams.get(terminalId)?.pending) void drain(terminalId);
    }
  }

  return {
    /** Queue one chunk. Returns immediately: a pty listener may not be made to wait. */
    send(terminalId, chunk) {
      const text = String(chunk ?? "");
      if (!text) return;
      const state = stateFor(terminalId);
      state.pending += text;
      if (state.pending.length > MAX_PENDING_CHARS) {
        // THE OLDEST GOES, not the newest. A console is read from the bottom: the recent screen is
        // what an operator and every classifier need, and keeping the head while discarding the tail
        // would preserve exactly the part nobody is looking at.
        const over = state.pending.length - MAX_PENDING_CHARS;
        state.pending = state.pending.slice(over);
        state.dropped += over;
      }
      void drain(terminalId);
    },

    /**
     * Resolve once this terminal has nothing queued and nothing in flight.
     *
     * WHAT IT IS FOR. A process's EXIT is announced by a different call than its output: the exit
     * marker carries a status and an exit code, which this sender's `send` cannot express, so it
     * goes out through `api.terminalOutput` directly. Posted the moment the process ends, it
     * overtakes whatever this queue still holds -- so a console shows `[terminal exited]` and THEN
     * the last thing the worker said, which is exactly the screen an operator opens a dead console
     * to read. Review reported the ordering; the tail itself still arrives.
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
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
      }
    },

    /** Stop tracking a terminal that has gone. Pending output is dropped with it. */
    forget(terminalId) {
      streams.delete(terminalId);
    },

    /** For tests and diagnostics: how much is waiting, and whether a POST is in flight. */
    pendingFor(terminalId) {
      const state = streams.get(terminalId);
      return state ? { pending: state.pending.length, inFlight: state.inFlight } : null;
    },
  };
}
