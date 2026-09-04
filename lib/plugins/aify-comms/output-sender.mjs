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

/**
 * A per-terminal, order-preserving sender.
 *
 * @param {object} deps
 * @param {(terminalId: string, body: object) => Promise<any>} deps.post  usually `api.terminalOutput`
 * @param {(message: string) => void} [deps.log]
 * @param {string} [deps.status]  the status each frame carries, e.g. `attached`
 */
export function createOutputSender({ post, log = () => {}, status = "" }) {
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
          log(`terminal ${terminalId}: dropped ${state.dropped} character(s) of output the service `
            + "could not keep up with");
          state.dropped = 0;
        }
        try {
          await post(terminalId, status ? { output: body, status } : { output: body });
        } catch (error) {
          log(`terminal ${terminalId} output not delivered: ${error?.message || error}`);
        }
      }
    } finally {
      state.inFlight = false;
      // Anything that arrived while the last POST settled: keep going rather than wait for the next
      // chunk to notice, or the tail of a burst sits unsent until the agent speaks again.
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
