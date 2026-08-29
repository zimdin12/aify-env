// The set of processes this environment owns.
//
// Small on purpose. It is the one place that knows what is running, which makes it the one place a
// reaper, a doctor check and a TUI all read — and the one place where "we thought it was still there"
// becomes a wrong answer three components repeat.
//
// It holds no opinion about what a process IS. A pid and the service that asked for it. Whether the
// thing inside is thinking, idle or wedged belongs to whoever owns agent semantics, and answering that
// here would put the same question in two places with two answers.


import { randomUUID } from "node:crypto";

/** How many deaths to remember. Enough to hold a whole cluster -- the observed ones were five and
 *  seven -- and small enough that this can never become a memory story of its own. */
const MAX_RECENT_EXITS = 20;

/** How much of a dying process's last words to keep. One readable line, not a transcript. */
const MAX_LAST_OUTPUT = 200;

/**
 * Below this, what survived is a fragment rather than a message, and it is dropped.
 *
 * This field exists to tell a crash from a kill, because an exit code cannot: on Windows an
 * externally terminated process and a program that returned 1 are the same number. A one- or
 * two-character remnant left over from a screen repaint answers that question no better than nothing
 * does, and printing it under the heading "last words" claims that it does.
 */
const MIN_LAST_OUTPUT = 3;

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
//: THE SEQUENCES THAT MOVE THE CURSOR, as opposed to the ones that colour text. Only these break
//: reading order: absolute position (H, f), relative moves (A-G), line moves (E, F), column (d),
//: scrolling (S, T) and the erases that a repaint uses to clear what it is about to overwrite (J, K).
//: SGR colour (m), mode set/reset (h, l) and device queries leave the text in the order it was
//: written, so they are chrome to strip and not evidence that the order is lost.
const CURSOR_MOVE = new RegExp(`${ESC}\\[[0-9;]*[HfABCDEFGJKdST]`, "g");

/**
 * The tail of a process's output, with the terminal chrome taken out so a human can read it.
 *
 * WHY IT IS KEPT AT ALL. An exit code cannot tell a crash from a kill: on Windows an externally
 * terminated process and a program that returned 1 are the same number. The final bytes usually can --
 * a stack trace, a provider error, or nothing at all, which is itself the signature of an abrupt end.
 *
 * Stripped and collapsed because a TUI's last frame is mostly cursor moves, and this is read by a
 * human in a narrow panel. Clipped hard: a ring must not become a log.
 *
 * ONLY WHAT CAME AFTER THE LAST CURSOR MOVE, and this is the correction. Stripping the escapes and
 * keeping every character between them was the first version, and the comment above already knew why
 * that could not work -- a TUI's last frame IS cursor moves -- without acting on it. What an operator
 * saw on 2026-08-29 was the result:
 *
 *     last words 31s | voice o f | 1 se sion 2 1 3 2 4 3 5 4 6 5 7 6 8 7 9 8 40 9 1 20 2 1 3 2 ...
 *
 * That is one screen repaint with its geometry removed: "voice of" written in two pieces the cursor
 * moved between, and a line-number gutter counting up beside it. Every character is real and the
 * ORDER is not, which is worse than showing nothing, because it looks like a message.
 *
 * Text written after the last reposition is the only part still in reading order, so that is the part
 * kept. A program that ends by repainting yields "" and the view drops the line -- the honest answer,
 * since it left no last words, it left a picture. A plain non-TUI process contains no addressing at
 * all and is unchanged: the whole tail is in order and the whole tail is kept, which is the case this
 * field exists for.
 */
function cleanTail(text) {
  if (typeof text !== "string" || !text) return "";
  // The LAST one, not the first: everything before it may have been overwritten by everything after.
  let inOrderFrom = 0;
  for (const move of text.matchAll(CURSOR_MOVE)) {
    inOrderFrom = move.index + move[0].length;
  }
  const collapsed = text
    .slice(inOrderFrom)
    .replace(TERMINAL_CHROME, " ")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length < MIN_LAST_OUTPUT) return "";
  return collapsed.length <= MAX_LAST_OUTPUT ? collapsed : collapsed.slice(-MAX_LAST_OUTPUT);
}

/**
 * A handle names ONE process in ONE instance of this environment, and says which.
 *
 * THE DEFECT THIS CLOSES, proven against two real daemons on 2026-08-29. The counter lived at module
 * scope and started at zero every boot, so `p1` was minted again by the next instance -- for a
 * different agent, on a different pid:
 *
 *     instance 1 (pid 113896)   agent-A -> p1, pid 136412
 *     instance 2 (pid  91856)   agent-B -> p1, pid 67432
 *
 * A consumer that holds a handle across a restart -- which aify-comms does BY DESIGN, because it
 * holds a terminal open rather than calling a live process dead while this environment is away --
 * then asks "is p1 still listed", gets YES about a stranger, and acts on it: re-attaches another
 * agent's output into that terminal, relabels that row with the wrong agent, and on a stop, kills it.
 *
 * FAIL CLOSED, IN THE ID ITSELF, rather than by asking every consumer to compare an instance field
 * alongside. A consumer that forgets that comparison is back where it started, and there is no way to
 * notice it forgot. A qualified id makes a stale handle simply not match, everywhere, with no consumer
 * change at all.
 *
 * FULL UUID, NOT A SHORT ONE, and the first version got this wrong. It used `randomUUID().slice(0, 6)`
 * -- 24 bits, 16.8 million values -- to keep the TUI's id column narrow. A reviewer did the
 * arithmetic: birthday collision reaches about 1% after 581 boots and 50% after 4,823, and the test
 * minting fifty and finding no repeat cannot establish non-reuse at all. Comments saying a stale handle
 * "cannot match" would then have been probabilistic, which is the difference between a guarantee and a
 * hope, in the identity that decides whether a stop kills the right process.
 *
 * READABILITY IS THE VIEW'S PROBLEM, not the identity's. `shortHandle()` in `lib/tui.mjs` renders a
 * narrow projection; the authority stays whole. Never trim an identity to fit a column.
 *
 * Injectable so that two registries in one test are two instances, which is what the real scenario is.
 */
export function mintInstanceId() {
  return randomUUID();
}

export class ProcessRegistry {
  #entries = new Map();
  //: Per REGISTRY, not per module. Two registries are two environments, and sharing a counter between
  //: them would make a test unable to reproduce the collision above.
  #counter = 0;
  #instance;

  /** @param {{instance?: string}} [options] */
  constructor({ instance } = {}) {
    this.#instance = String(instance || mintInstanceId());
  }

  /** Which instance of this environment minted the handles in here. */
  get instance() {
    return this.#instance;
  }

  /** Monotonic within an instance, and not derived from a clock: ids must not depend on wall time. */
  #nextId() {
    this.#counter += 1;
    return `${this.#instance}-p${this.#counter}`;
  }

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
      id: this.#nextId(),
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
