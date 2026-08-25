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

/** Monotonic within a process, and not derived from a clock: ids must not depend on wall time. */
function nextId() {
  counter += 1;
  return `p${counter}`;
}

export class ProcessRegistry {
  #entries = new Map();

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
    return stored;
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

  /** Forget a process. Unknown ids are a no-op — a reaper must be safe to run twice. */
  remove(id) {
    this.#entries.delete(id);
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
}
