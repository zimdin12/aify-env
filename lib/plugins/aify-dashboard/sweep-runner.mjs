// Sweeping each watched folder's new head with the code provider's sweep client, so what a commit did to anchored code
// reaches the dashboard without anyone running it by hand.
//
// ONCE PER HEAD, AND ONLY WHERE SOMETHING IS WATCHED. A folder's head is the one the head watcher last had accepted
// (`HeadWatcher.watched`). The dashboard is asked what it watches in that project first, and a project with nothing
// watched starts no process: most registered projects have no anchor, and a commit there has nothing to sweep. The
// client (aify-project-graph `scripts/post-watch-signals.mjs`) reserves a sweep, measures the set the reservation
// returns, and posts with the sweep's id, so the dashboard can order this host's reports (aify-dashboard v1.1).
//
// THE CLIENT NAMES ITS OWN REPORTER. Its default is derived from its install, so it is the same name across aify-env
// restarts. Handed aify-env's reporter, which is new in every process, each restart would start a new sweep cursor
// and a delayed post from the old process could never be ordered against the new one. So no reporter is handed in,
// and the child's environment carries nothing it was not given (provider-child.mjs).
//
// THE EXIT CODE IS THE CLIENT'S WHOLE ANSWER, one recovery each (aify-project-graph 5d693d63, `sweep-outcome.mjs`; the
// policy is graph-tech-lead's, 2026-10-19). Mapped here for this script only: the queue client's codes mean other things.
// - 0 posted and 3 a later sweep already applied: the head is settled.
// - 2, something moved after the reservation: run again next pass; three in a row at one head stop that head.
// - 4, uncommitted changes: the head waits, 1, 2, 4, 8 then 16 minutes, and a new head replaces it. A commit made while
//   other files were uncommitted is still swept once the tree is clean.
// - 5, no answer or a 5xx or 429: the same waits, on ANY head, since it is the dashboard that is down, and never a stop.
//   Said once the wait reaches its cap.
// - 6, refused in a way running again cannot fix (a wrong key): that head stops, the client's last line is quoted, and a
//   new head is tried, so it recovers by itself once the cause is fixed.
// - 1, the client's own bug (an incomplete batch, which depends on the commit): that head stops, and a new head is tried.
// - Any other exit, or death by a signal: the folder stops until its configuration section changes or aify-env
//   restarts. That is the fail-closed case.
// A run past its time is tried again.
//
// THE SAME GRANT AND THE SAME KEY RULES AS THE PROVIDER'S QUEUE CLIENT (provider-runner.mjs), read at the moment of
// starting, and the key cut out of anything kept.

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { childEnv, runChild } from "./provider-child.mjs";
import { CleanupWarnings, CONFIG_KEY, checkoutOf, servableNow } from "./provider-runner.mjs";

export const SWEEP_SCRIPT = join("scripts", "post-watch-signals.mjs");

/** The first wait for a clean tree or for a dashboard that did not answer; each one after it doubles. */
const DIRTY_WAIT_MS = 60_000;

/** The longest such wait: an unchanged dirty head, or a dashboard that stays down, costs one process this often. */
export const DIRTY_WAIT_MAX_MS = 16 * 60_000;

/** How many exit 2s in a row at one head before that head is stopped. */
const REFUSALS_BEFORE_STOP = 3;

/** What one exit means, by the sweep client's codes. Anything it does not use, or death by a signal, is a bug. */
export function sweepOutcomeOf({ code, timedOut }) {
  if (timedOut) return "retry";
  if (code === 0 || code === 3) return "swept";
  if (code === 2) return "again";
  if (code === 4) return "dirty";
  if (code === 5) return "unavailable";
  if (code === 6) return "refused";
  if (code === 1) return "failed";
  return "bug";
}

/** The wait after the `runs`th wait-worthy exit in a row: doubling, capped. PURE. */
function waitAfter(runs) {
  return Math.min(DIRTY_WAIT_MS * 2 ** (runs - 1), DIRTY_WAIT_MAX_MS);
}

/** The client's outcome line, its last line of what it said, cut to fit a row. PURE. */
function lastLine(said) {
  const lines = said.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return (lines.at(-1) ?? "").slice(0, 300);
}

/** Returned by `#sweep` when the plugin is stopping: nothing after it is recorded. */
const STOPPING = Symbol("stopping");

export class SweepRunner {
  #deps;
  /** folder key -> the head settled there: swept, stale, or nothing watched */
  #settled = new Map();
  /** folder key -> {head, dirtyRuns, dueAt, refusals, timeouts} for a head not yet settled */
  #waiting = new Map();
  /**
   * folder key -> {projectId, head, row, latchedUnder} for a folder stopped by a bug (head null: every head) or by
   * repeated refusals (that head only, so a new head is tried; dashboard-senior-dev on c312f5c)
   */
  #latched = new Map();
  /** folder key -> {runs, dueAt, row} while the dashboard has not answered the client: it holds every head back */
  #unavailable = new Map();
  /** folder key -> its head, as the last #reconcile found the folders: what the rows are judged against */
  #heads = new Map();
  #problems = [];
  #runs = 0;

  /**
   * @param {object} deps
   * @param {{watchSet: Function}} deps.api
   * @param {() => Promise<string>} deps.credential  the dashboard key, resolved per run
   * @param {() => Array<{projectId: string, path: string, real: string, platform?: string, head: string}>} deps.folders
   * @param {() => Promise<{roots: string[]}>} deps.watchRoots
   * @param {() => {config: object|null, problem: string}} deps.config  this plugin's own config section
   * @param {string} deps.endpoint
   * @param {string} deps.hostKey
   * @param {Function} [deps.run]  `runChild`'s signature
   * @param {object} [deps.parentEnv]
   * @param {string} [deps.nodePath]
   * @param {Function} [deps.exists]
   * @param {(path: string) => string} [deps.realpath]
   * @param {() => number} [deps.now]
   * @param {CleanupWarnings} [deps.cleanupWarnings]  where a kill not confirmed is kept: the plugin's one store, shared
   *   with the queue client, so it outlives this runner (index.mjs); this runner's own by default
   */
  constructor(deps) {
    this.#deps = { run: runChild, parentEnv: process.env, nodePath: process.execPath, exists: existsSync, realpath: realpathSync.native, now: Date.now, cleanupWarnings: new CleanupWarnings(), ...deps };
  }

  /** One pass over the watched folders. Never throws; failures become problems. */
  async pass({ signal } = {}) {
    try {
      this.#reconcile();
      const due = this.#due();
      if (due.length === 0) {
        this.#problems = this.#standing();
        return;
      }
      const { config, problem } = this.#deps.config();
      const under = JSON.stringify(config ?? null);
      // A changed configuration section lifts every stop: the operator changed something, so it is tried again.
      for (const [key, latch] of this.#latched) if (latch.latchedUnder !== under) this.#latched.delete(key);
      const checkout = config === null ? { problem } : checkoutOf(config, this.#deps.exists, SWEEP_SCRIPT);
      if (checkout.problem) {
        this.#problems = [`${due.length} watched folder(s) have a new head to sweep, and none is swept: ${checkout.problem}`];
        return;
      }
      const problems = [];
      for (const folder of due) {
        if (signal?.aborted) return;
        // Any stop still here is the folder's, or this head's (#reconcile retired the rest).
        if (this.#latched.has(keyOf(folder))) continue;
        const said = await this.#sweep(folder, checkout.script, under, signal);
        if (said === STOPPING) return;
        if (said) problems.push(said);
      }
      this.#problems = [...problems, ...this.#standing()];
    } catch (error) {
      if (signal?.aborted) return;
      this.#problems = [`the sweep client was not run: ${error?.message || error}`];
    }
  }

  state() {
    return { runs: this.#runs, stopped: [...new Set([...this.#latched.values()].map((latch) => latch.projectId))], problems: [...this.#problems, ...this.#deps.cleanupWarnings.rows()] };
  }

  /** The rows that stand between passes: the stops, and a dashboard that has stayed down to the cap. */
  #standing() {
    // ⛔ A "tried again every 16 minutes" row only while that is true. A folder not watched, stopped (at this head or
    // entirely), or back at a head already settled is not tried, though its waits are kept (dashboard-senior-dev,
    // REVISE of 2087409, P3 1, and on aed0fac).
    const retried = (key) => {
      const head = this.#heads.get(key);
      return typeof head === "string" && head !== "" && this.#settled.get(key) !== head && !this.#latched.has(key);
    };
    const down = [...this.#unavailable].flatMap(([key, entry]) => (entry.row && retried(key) ? [entry.row] : []));
    return [...[...this.#latched.values()].map((latch) => latch.row), ...down];
  }

  /**
   * Bring what is kept per folder up to the folders as they are now, before anything reads it.
   *
   * ⛔ BEFORE THE SETTLED SHORTCUT. A stop at one head is retired as soon as the folder is at another, settled or not:
   * checked only for folders still due, a return to a settled head kept the stop at the head it had left
   * (dashboard-senior-dev, REVISE of 2087409, P3 2). A stop of the whole folder is kept.
   *
   * A folder no longer watched keeps no stop at a head: its row would say it was tried. Its folder-wide stop is kept,
   * so listing it again does not lift a bug stop, and so is its wait for the dashboard, which #standing does not show.
   */
  #reconcile() {
    const heads = new Map();
    for (const folder of this.#deps.folders()) heads.set(keyOf(folder), typeof folder.head === "string" ? folder.head : "");
    this.#heads = heads;
    for (const [key, latch] of this.#latched) {
      if (latch.head === null) continue;
      if (!heads.has(key) || (heads.get(key) !== "" && heads.get(key) !== latch.head)) this.#latched.delete(key);
    }
  }

  /** The folders with a reported head not yet settled, whose wait (if any) is over. */
  #due() {
    const now = this.#deps.now();
    const due = [];
    for (const folder of this.#deps.folders()) {
      if (typeof folder.head !== "string" || folder.head === "") continue;
      const key = keyOf(folder);
      if (this.#settled.get(key) === folder.head) continue;
      // A dashboard that did not answer holds every head back: a new commit does not bring it up.
      const down = this.#unavailable.get(key);
      if (down && now < down.dueAt) continue;
      const waiting = this.#waiting.get(key);
      // A new head replaces whatever was waiting, at once.
      if (waiting && waiting.head !== folder.head) this.#waiting.delete(key);
      else if (waiting && now < waiting.dueAt) continue;
      due.push(folder);
    }
    return due;
  }

  /** Sweep one folder's head once, if it may run. Returns the doctor row it leaves, "" for none. */
  async #sweep(folder, script, under, signal) {
    const d = this.#deps;
    const key = keyOf(folder);
    const { projectId, head } = folder;

    const grant = await d.watchRoots();
    if (!Array.isArray(grant?.roots)) throw new Error("this aify-env's watch roots could not be read");
    if (!servableNow(folder, projectId, grant.roots, { realpath: d.realpath })) {
      return `project ${projectId}: ${folder.path} is not inside the grant as it stands now, so it is not swept`;
    }

    let watched;
    try {
      watched = await d.api.watchSet(d.hostKey, projectId, { signal });
    } catch (error) {
      if (signal?.aborted) return STOPPING;
      return `project ${projectId}: the dashboard's watch set was not read, so ${head} is not swept yet (${error?.message || error})`;
    }
    if (!watched || typeof watched !== "object" || !Array.isArray(watched.items)) {
      return `project ${projectId}: the dashboard's answer about its watch set was not the shape it should be, so ${head} is not swept yet`;
    }
    if (watched.items.length === 0) {
      this.#settle(key, head);
      return "";
    }

    const credential = String((await d.credential()) || "");
    if (!credential) return `project ${projectId}: no credential for aify-dashboard on this host, so the sweep client was not started`;
    // No APG_DASHBOARD_REPORTER: the client's own derivation is the name that survives a restart (see the header).
    const env = childEnv(d.parentEnv, {
      APG_DASHBOARD_URL: d.endpoint, APG_DASHBOARD_KEY: credential, APG_DASHBOARD_PROJECT: projectId, APG_DASHBOARD_HOST: d.hostKey,
    });
    const result = await d.run({ nodePath: d.nodePath, script, cwd: folder.real, env, key: credential, signal });
    // ⛔ A KILL NOT CONFIRMED IS SAID, HOWEVER THE RUN ENDED, before a stop returns: as the queue client says its own
    // (provider-runner.mjs), into the same store, which keeps it until aify-env restarts (comms-senior-dev, R1 on 4ae0d24).
    if (result.unconfirmed) {
      const how = result.stopped ? "was stopped" : "ran past its time";
      d.cleanupWarnings.note(d.endpoint, projectId, `project ${projectId}: the sweep client serving ${d.endpoint} was killed when it ${how}, and ${String(result.unconfirmed).split(credential).join("<the dashboard key>")}: its processes may still be running (shown until aify-env restarts)`, "sweep");
    }
    if (result.stopped || signal?.aborted) return STOPPING;
    this.#runs += 1;

    const waiting = this.#waiting.get(key) ?? { head, dirtyRuns: 0, dueAt: 0, refusals: 0, timeouts: 0 };
    const said = String(result.error || "").split(credential).join("<the dashboard key>");
    const outcome = sweepOutcomeOf(result);
    // The wait for a dashboard that did not answer ends when it answers: a re-read or a refusal here, a settled head in
    // #settle. A dirty tree is decided before anything is asked, so it ends nothing.
    if (outcome === "again" || outcome === "refused") this.#unavailable.delete(key);
    // Three refusals IN A ROW: any other outcome between two of them starts the count again (comms-senior-dev, on 872f4e6).
    if (outcome !== "again") waiting.refusals = 0;
    switch (outcome) {
      case "unavailable": {
        const down = this.#unavailable.get(key) ?? { runs: 0, dueAt: 0, row: "" };
        down.runs += 1;
        const wait = waitAfter(down.runs);
        down.dueAt = d.now() + wait;
        down.row = wait < DIRTY_WAIT_MAX_MS ? ""
          : `project ${projectId}: the dashboard has not answered the sweep client ${down.runs} times in a row (${lastLine(said)}); it is tried again every ${DIRTY_WAIT_MAX_MS / 60_000} minutes`;
        this.#unavailable.set(key, down);
        return "";
      }
      case "refused":
        return this.#latch(key, projectId, head, under,
          `project ${projectId}: the sweep client was refused at ${head} (${lastLine(said)}), and running again cannot fix that; a new head is tried`);
      case "failed":
        return this.#latch(key, projectId, head, under,
          `project ${projectId}: the sweep client stopped with exit 1 (its own bug) at ${head} (${lastLine(said)}); a new head is tried`);
      case "swept":
        this.#settle(key, head);
        return "";
      case "dirty": {
        waiting.dirtyRuns += 1;
        waiting.dueAt = d.now() + waitAfter(waiting.dirtyRuns);
        this.#waiting.set(key, waiting);
        return "";
      }
      case "again": {
        waiting.refusals += 1;
        waiting.dueAt = 0;
        this.#waiting.set(key, waiting);
        if (waiting.refusals < REFUSALS_BEFORE_STOP) return "";
        return this.#latch(key, projectId, head, under,
          `project ${projectId}: the sweep client was refused ${waiting.refusals} times in a row at ${head}, so this head is not swept again until a new head, a change to ${CONFIG_KEY} or an aify-env restart${said ? ` (${said})` : ""}`);
      }
      case "retry": {
        waiting.timeouts += 1;
        waiting.dueAt = 0;
        this.#waiting.set(key, waiting);
        return waiting.timeouts >= 2 ? `project ${projectId}: the sweep client ran past its time ${waiting.timeouts} times in a row and was stopped` : "";
      }
      default: {
        const exit = result.code ?? result.signal ?? "none";
        const how = exit === "none" ? "no exit: it could not be started" : `exit ${exit} (a bug)`;
        return this.#latch(key, projectId, null, under,
          `project ${projectId}: the sweep client stopped with ${how}; change ${CONFIG_KEY} or restart aify-env to try again${said ? ` (${said})` : ""}`);
      }
    }
  }

  #settle(key, head) {
    this.#settled.set(key, head);
    this.#waiting.delete(key);
    // Settling took an answer from the dashboard, so it is not down: its row would stand with no retry behind it.
    this.#unavailable.delete(key);
  }

  #latch(key, projectId, head, under, row) {
    this.#waiting.delete(key);
    this.#latched.set(key, { projectId, head, row, latchedUnder: under });
    return "";
  }
}

/** A folder is its project and its path: two worktrees of one project are swept apart, each at its own head. */
function keyOf(folder) {
  return JSON.stringify([folder.projectId, folder.path]);
}
