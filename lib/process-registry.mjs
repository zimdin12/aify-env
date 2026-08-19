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
    };
    this.#entries.set(stored.id, stored);
    return stored;
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
