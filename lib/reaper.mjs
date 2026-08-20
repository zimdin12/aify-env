// Forgetting processes that are gone, on evidence rather than on notification.
//
// This project has a 97-minute incident behind it: a spawn sat "running" because the one function that
// marks a terminal dead is one of about twenty-six writers on that path and was never called. Nothing
// was broken in the sense of throwing; the notification simply did not happen. Cleanup that has to
// hold for ALL paths keys on the observed state, so the reaper does not wait to be told. It looks.
//
// The second rule keeps the reaper from becoming the next incident. "I could not tell whether this pid
// is alive" is not "it is dead". Reaping on no evidence drops a live process out of the only place
// that knows about it, which is strictly worse than the leak being fixed. Unknown entries are KEPT and
// RETURNED, so a count that stays above zero is something a health check can surface rather than
// something nobody ever sees.

/** How often a running environment sweeps. Slow on purpose: this converges state, it does not race. */
export const SWEEP_INTERVAL_MS = 30_000;

/**
 * Does this pid exist?
 *
 * Signal 0 performs the permission and existence checks without delivering anything. EPERM means the
 * process is there and not ours, which is still ALIVE — reading it as dead would forget a process that
 * is very much running.
 */
export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Split owned processes into alive, dead and unknown.
 *
 * Pure: entries and a probe in, three lists out. The probe is injected because "is this pid alive" is
 * the one genuinely ambient question here, and a test that asks the real operating system measures the
 * machine it runs on.
 *
 * @param {{id: string, pid: number}[]} entries
 * @param {(pid: number) => boolean} isAlive
 */
export function classifyProcesses(entries, isAlive) {
  const alive = [];
  const dead = [];
  const unknown = [];

  for (const entry of entries ?? []) {
    // A pid we never really had is not evidence of death. It is evidence that something went wrong at
    // start, and forgetting the entry would erase the only trace of it.
    if (!Number.isInteger(entry.pid) || entry.pid <= 0) {
      unknown.push(entry);
      continue;
    }
    let answer;
    try {
      answer = isAlive(entry.pid);
    } catch {
      unknown.push(entry);
      continue;
    }
    // Only a real boolean is an answer. A probe returning undefined has not said "no".
    if (answer === true) alive.push(entry);
    else if (answer === false) dead.push(entry);
    else unknown.push(entry);
  }

  return { alive, dead, unknown };
}

/**
 * The reaper a running environment should use.
 *
 * A named, tested thing rather than an object literal at a call site, because it was an object literal
 * at a call site and it was wired with `remove: () => {}` — a no-op. The sweep classified processes
 * correctly every thirty seconds and removed none of them. Decorative, and invisible to a unit test of
 * the sweep, because the sweep was never wrong.
 *
 * It calls `stop()` rather than removing a registry entry: stop releases the registry entry, the live
 * handle AND the output buffer. Removing the entry alone would leave the buffer behind, which is a leak
 * with a slower fuse than the one being fixed.
 */
export function createReaper(runner, { isAlive = defaultIsAlive } = {}) {
  return new Reaper({
    registry: {
      list: () => runner.list(),
      remove: (id) => {
        // Fire and forget, and swallow: one wedged process must not stop the rest of the host being
        // cleaned up. The registry entry is already gone by the time this resolves either way.
        Promise.resolve(runner.stop(id)).catch(() => {});
      },
    },
    isAlive,
  });
}

export class Reaper {
  #registry;
  #isAlive;
  #timer = null;

  constructor({ registry, isAlive = defaultIsAlive } = {}) {
    this.#registry = registry;
    this.#isAlive = isAlive;
  }

  /**
   * One pass. Returns what it reaped and what it could not answer for.
   *
   * Safe to run twice; a reaper on a schedule will be asked about things that already went.
   */
  sweep() {
    const { dead, unknown } = classifyProcesses(this.#registry.list(), this.#isAlive);
    for (const entry of dead) this.#registry.remove(entry.id);
    return { reaped: dead.map((entry) => entry.id), unknown };
  }

  start(intervalMs = SWEEP_INTERVAL_MS) {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), intervalMs);
    // A sweep must never be the reason a process cannot exit.
    this.#timer.unref?.();
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
