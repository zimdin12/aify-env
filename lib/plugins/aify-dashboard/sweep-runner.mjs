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
// THE EXIT CODE IS THE CLIENT'S WHOLE ANSWER (graph-tech-lead, 2026-10-19): 0 posted and 3 a later sweep already
// applied both settle the head; 4 is a tree with uncommitted changes, so the head waits, tried again after a wait that
// doubles up to `DIRTY_WAIT_MAX_MS`, and a commit made while other files are uncommitted is still swept once the tree is
// clean; 2 is refused, so it runs again to reserve afresh, three times; 1 and anything else is a bug and stops the
// folder until its configuration section changes or aify-env restarts. A run past its time is tried again.
//
// THE SAME GRANT AND THE SAME KEY RULES AS THE PROVIDER'S QUEUE CLIENT (provider-runner.mjs), read at the moment of
// starting, and the key cut out of anything kept.

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { childEnv, runChild } from "./provider-child.mjs";
import { CONFIG_KEY, checkoutOf, servableNow } from "./provider-runner.mjs";

export const SWEEP_SCRIPT = join("scripts", "post-watch-signals.mjs");

/** The first wait after a dirty tree; each one after it doubles. */
export const DIRTY_WAIT_MS = 60_000;

/** The longest wait for a clean tree: a folder someone works in all day costs one process this often. */
export const DIRTY_WAIT_MAX_MS = 16 * 60_000;

/** How many refusals in a row at one head before the folder is stopped. */
export const REFUSALS_BEFORE_STOP = 3;

/** What one exit means, by the client's codes. Anything it does not use, or death by a signal, is a bug. */
export function sweepOutcomeOf({ code, timedOut }) {
  if (timedOut) return "retry";
  if (code === 0 || code === 3) return "swept";
  if (code === 4) return "dirty";
  if (code === 2) return "again";
  return "bug";
}

/** Returned by `#sweep` when the plugin is stopping: nothing after it is recorded. */
const STOPPING = Symbol("stopping");

export class SweepRunner {
  #deps;
  /** folder key -> the head settled there: swept, stale, or nothing watched */
  #settled = new Map();
  /** folder key -> {head, dirtyRuns, dueAt, refusals, timeouts} for a head not yet settled */
  #waiting = new Map();
  /** folder key -> {projectId, row, latchedUnder} for a folder stopped by a bug or repeated refusals */
  #latched = new Map();
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
   */
  constructor(deps) {
    this.#deps = { run: runChild, parentEnv: process.env, nodePath: process.execPath, exists: existsSync, realpath: realpathSync.native, now: Date.now, ...deps };
  }

  /** One pass over the watched folders. Never throws; failures become problems. */
  async pass({ signal } = {}) {
    try {
      const due = this.#due();
      if (due.length === 0) {
        this.#problems = [...this.#latched.values()].map((latch) => latch.row);
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
        if (this.#latched.has(keyOf(folder))) continue;
        const said = await this.#sweep(folder, checkout.script, under, signal);
        if (said === STOPPING) return;
        if (said) problems.push(said);
      }
      this.#problems = [...problems, ...[...this.#latched.values()].map((latch) => latch.row)];
    } catch (error) {
      if (signal?.aborted) return;
      this.#problems = [`the sweep client was not run: ${error?.message || error}`];
    }
  }

  state() {
    return { runs: this.#runs, stopped: [...new Set([...this.#latched.values()].map((latch) => latch.projectId))], problems: [...this.#problems] };
  }

  /** The folders with a reported head not yet settled, whose wait (if any) is over. */
  #due() {
    const now = this.#deps.now();
    const due = [];
    for (const folder of this.#deps.folders()) {
      if (typeof folder.head !== "string" || folder.head === "") continue;
      const key = keyOf(folder);
      if (this.#settled.get(key) === folder.head) continue;
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
    if (result.stopped || signal?.aborted) return STOPPING;
    this.#runs += 1;

    const waiting = this.#waiting.get(key) ?? { head, dirtyRuns: 0, dueAt: 0, refusals: 0, timeouts: 0 };
    const said = String(result.error || "").split(credential).join("<the dashboard key>");
    switch (sweepOutcomeOf(result)) {
      case "swept":
        this.#settle(key, head);
        return "";
      case "dirty": {
        waiting.dirtyRuns += 1;
        waiting.dueAt = d.now() + Math.min(DIRTY_WAIT_MS * 2 ** (waiting.dirtyRuns - 1), DIRTY_WAIT_MAX_MS);
        this.#waiting.set(key, waiting);
        return "";
      }
      case "again": {
        waiting.refusals += 1;
        waiting.dueAt = 0;
        this.#waiting.set(key, waiting);
        if (waiting.refusals < REFUSALS_BEFORE_STOP) return "";
        return this.#latch(key, projectId, under,
          `project ${projectId}: the sweep client was refused ${waiting.refusals} times in a row at ${head}, so this folder is not swept until ${CONFIG_KEY} changes or aify-env restarts${said ? ` (${said})` : ""}`);
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
        return this.#latch(key, projectId, under,
          `project ${projectId}: the sweep client stopped with ${how}; change ${CONFIG_KEY} or restart aify-env to try again${said ? ` (${said})` : ""}`);
      }
    }
  }

  #settle(key, head) {
    this.#settled.set(key, head);
    this.#waiting.delete(key);
  }

  #latch(key, projectId, under, row) {
    this.#waiting.delete(key);
    this.#latched.set(key, { projectId, row, latchedUnder: under });
    return "";
  }
}

/** A folder is its project and its path: two worktrees of one project are swept apart, each at its own head. */
function keyOf(folder) {
  return JSON.stringify([folder.projectId, folder.path]);
}
