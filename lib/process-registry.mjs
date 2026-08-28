// The set of processes this environment owns.
//
// Small on purpose. It is the one place that knows what is running, which makes it the one place a
// reaper, a doctor check and a TUI all read — and the one place where "we thought it was still there"
// becomes a wrong answer three components repeat.
//
// It holds no opinion about what a process IS. A pid and the service that asked for it. Whether the
// thing inside is thinking, idle or wedged belongs to whoever owns agent semantics, and answering that
// here would put the same question in two places with two answers.

let counter = 0;

/** How many deaths to remember. Enough to hold a whole cluster -- the observed ones were five and
 *  seven -- and small enough that this can never become a memory story of its own. */
const MAX_RECENT_EXITS = 20;

/** How much of a dying process's last words to keep. One readable line, not a transcript. */
const MAX_LAST_OUTPUT = 200;

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
//: CSI and OSC, built from `String.fromCharCode` rather than typed. Writing the escape literally puts
//: a raw control byte in this file -- which happened on the first attempt, and a source file that greps
//: as binary is a source file nobody can review.
const TERMINAL_CHROME = new RegExp(
  `${ESC}\\[[0-9;?<>=]*[a-zA-Z]|${ESC}\\][^${BELL}]*${BELL}`,
  "g",
);
//: Control characters, by CODE POINT rather than by a typed range. Writing the range literally
//: puts raw control bytes in this file, which is how the first two attempts at this made the
//: source grep as binary -- including the comment that was explaining the problem. Tab and
//: newline are deliberately left in: the whitespace collapse below handles them, and they are
//: the only two a reader ever wants back.
const CONTROL_CHARS = new RegExp("[\u0000-\u0008\u000b-\u001f\u007f]", "g");

/**
 * The tail of a process's output, with the terminal chrome taken out so a human can read it.
 *
 * WHY IT IS KEPT AT ALL. An exit code cannot tell a crash from a kill: on Windows an externally
 * terminated process and a program that returned 1 are the same number. The final bytes usually can --
 * a stack trace, a provider error, or nothing at all, which is itself the signature of an abrupt end.
 *
 * Stripped and collapsed because a TUI's last frame is mostly cursor moves, and this is read by a
 * human in a narrow panel. Clipped hard: a ring must not become a log.
 */
function cleanTail(text) {
  if (typeof text !== "string" || !text) return "";
  const collapsed = text
    .replace(TERMINAL_CHROME, " ")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length <= MAX_LAST_OUTPUT ? collapsed : collapsed.slice(-MAX_LAST_OUTPUT);
}

/** Monotonic within a process, and not derived from a clock: ids must not depend on wall time. */
function nextId() {
  counter += 1;
  return `p${counter}`;
}

export class ProcessRegistry {
  #entries = new Map();

  // LIFETIME, not current. An empty `list()` is ambiguous in the one way that matters to somebody
  // looking at it: nothing running because nothing was asked of this environment, or nothing running
  // because it is broken. The operator hit exactly that -- an empty PROCESSES panel beside a
  // dashboard showing nineteen managed agents, and read it as a fault. It was idle.
  //
  // These two numbers settle it without asking any service anything, which is the constraint:
  // aify-env reports what it did, never what somebody else's agents are doing.
  #startedTotal = 0;
  #lastExitAtMs = null;
  // THE LAST FEW DEATHS, WITH HOW THEY DIED. Bounded and in memory: this is a ring for the question
  // "what just happened to my agents", not a log.
  //
  // WHY IT EXISTS. On 2026-08-26 the operator's managed workers kept dying in clusters -- five in
  // three seconds, twice -- and nothing anywhere could say how. aify-comms records an exit code and
  // signal now, but the service and the bridge on that host are both several days behind and drop
  // the fields; this environment is the one tier that has the new code AND observes the exit
  // first-hand. `lastExitAtMs` alone answers WHEN, which was never the question.
  #recentExits = [];

  /**
   * Record a process. Returns the stored entry, including the id assigned to it.
   * @param {{service: string, pid: number, terminal?: boolean}} entry
   */
  add(entry) {
    const stored = {
      id: nextId(),
      service: entry.service,
      pid: entry.pid,
      terminal: entry.terminal === true,
      startedAtMs: entry.startedAtMs ?? null,
      // WHAT THE CALLER CALLS IT. aify-env has no idea what an agent is and must not learn -- but a
      // view showing `p2  pid 129340  aify-comms` cannot tell an operator WHICH of their agents that
      // is, and they asked. So the service says, at spawn time, and this displays what it was told.
      // Same shape as `service`: a label, not a lookup.
      label: typeof entry.label === "string" ? entry.label.slice(0, 64) : "",
      // The last terminal title the process set, if it ever set one. Captured from the output stream
      // rather than asked for, because only the process knows it.
      title: "",
    };
    this.#entries.set(stored.id, stored);
    this.#startedTotal += 1;
    return stored;
  }

  /**
   * Change what the caller calls this process.
   *
   * SET AT SPAWN WAS NOT ENOUGH, and the operator said why: a launcher can be started with no
   * identity at all and register itself later, mid-conversation. The identity is the same identity
   * whenever it arrives, so the row has to be able to learn it -- otherwise the AGENT column is
   * correct for spawns that knew the answer up front and permanently blank for every other path.
   *
   * Unknown ids are a no-op, like `setTitle`: a label is never worth throwing over, and the caller
   * reconciling labels may name a process that has just exited.
   *
   * @returns {boolean} whether an entry was found and changed
   */
  setLabel(id, label) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    // The same 64-character bound `add` applies. A cap enforced on one writer and not the other is
    // not a cap: it is a cap plus a way around it.
    entry.label = typeof label === "string" ? label.slice(0, 64) : "";
    return true;
  }

  /**
   * Record the terminal title a process set. Unknown ids are a no-op: output can outlive the entry by
   * a tick, and a title is never worth throwing over.
   */
  setTitle(id, title) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.title = String(title ?? "").slice(0, 120);
  }

  /**
   * Forget a process. Unknown ids are a no-op — a reaper must be safe to run twice.
   *
   * The exit time is PASSED IN, not read from a clock here. This class stays clock-free for the same
   * reason its ids do: a caller can then drive it to any moment in a test, and nothing in it can
   * flicker. Callers that do not care may omit it, and an unknown id records nothing at all — a
   * reaper's second pass must not move a timestamp it did not cause.
   */
  remove(id, { atMs = null, exitCode = undefined, exitSignal = "", reason = "", lastOutput = "" } = {}) {
    const entry = this.#entries.get(id);
    if (!this.#entries.delete(id)) return;
    if (typeof atMs === "number" && Number.isFinite(atMs)) this.#lastExitAtMs = atMs;
    // NULL AND ZERO ARE DIFFERENT ANSWERS, all the way down. A signalled process reports a null code;
    // zero is a clean exit and the most common value there is. `exitCode` is stored as given and a
    // caller that knows nothing (a reaper finding a corpse) passes nothing, which stays `null` --
    // "we found it gone" rather than "it exited cleanly".
    this.#recentExits.push({
      id,
      pid: entry?.pid ?? 0,
      service: entry?.service ?? "",
      label: entry?.label ?? "",
      atMs: typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null,
      exitCode: typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : null,
      exitSignal: typeof exitSignal === "string" ? exitSignal.trim() : "",
      // WHICH PATH REMOVED IT, which the first real reading of this ring turned out to need. Three
      // answers, and they are three different incidents: `exited` means the process's own close event
      // was observed and the code beside it is real; `stopped` means a caller asked, so somebody
      // decided this; `reaped` means the sweep found a pid that was already gone. Only the first
      // carries an exit code, and the other two must not be mistaken for it.
      reason: typeof reason === "string" && reason ? reason : "unknown",
      // WHAT IT WAS SAYING WHEN IT WENT. An exit code cannot tell a crash from a kill -- on Windows an
      // externally terminated process and a program that returned 1 are the same number -- but the
      // final bytes usually can: a stack trace, a provider error, or nothing at all, which is itself
      // the signature of an abrupt end. Cleaned and clipped by `cleanTail`.
      lastOutput: cleanTail(lastOutput),
    });
    if (this.#recentExits.length > MAX_RECENT_EXITS) {
      this.#recentExits.splice(0, this.#recentExits.length - MAX_RECENT_EXITS);
    }
  }

  get(id) {
    return this.#entries.get(id) ?? null;
  }

  /**
   * Everything currently owned.
   *
   * A COPY, and copies of the entries. A caller that can mutate this can change what a reaper sees
   * without going through the one place that is supposed to know.
   */
  list() {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }

  get size() {
    return this.#entries.size;
  }

  /**
   * What this environment has DONE, as opposed to what it is holding. Read by the view so an empty
   * list can say which kind of empty it is.
   */
  get history() {
    return {
      startedTotal: this.#startedTotal,
      lastExitAtMs: this.#lastExitAtMs,
      // NEWEST LAST, so a reader scrolling a health payload sees the most recent at the bottom where
      // a log would put it. Copies, for the same reason `list()` returns copies.
      recentExits: this.#recentExits.map((exit) => ({ ...exit })),
    };
  }
}
