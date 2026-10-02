// Watching the listed folders and telling aify-dashboard where each one's HEAD is.
//
// ONE TICK, EVERY TEN SECONDS, does at most two things in order: refresh the watch list when it is due
// (every five minutes), then look at every folder. Looking is a stat; git runs only for a folder whose
// fingerprint moved, so an idle workspace costs no process at all.
//
// A FAILED REFRESH KEEPS THE LAST GOOD LIST. The dashboard being down for a minute is not the operator
// unregistering every project, and treating it as an empty list would stop every report until the next
// refresh succeeded, with nothing on this side saying why.
//
// A HEAD IS SENT WHEN IT DIFFERS FROM THE LAST ONE THE DASHBOARD ACCEPTED, and the fingerprint is kept
// only after that acceptance. A report that failed is therefore tried again on the next tick, rather
// than being recorded here as done.

import { headFingerprint } from "./fingerprint.mjs";
import { hostKeyOf, namespaceOf, parseWatchList, selectLocations } from "./locations.mjs";

export const TICK_MS = 10_000;
export const LIST_EVERY_MS = 5 * 60_000;

export class HeadWatcher {
  #api;
  #git;
  #fingerprint;
  #machineId;
  #hostKey;
  #namespace;
  #watchRoots;
  #reporter;
  #now;

  #items = null;
  #listProblem = "";
  #listAttemptAt = Number.NEGATIVE_INFINITY;
  #rootsProblems = [];
  #refused = [];
  /** path -> what is known about that folder */
  #folders = new Map();
  #reportsSent = 0;

  /**
   * @param {object} deps
   * @param {import("./dashboard-api.mjs").DashboardApi} deps.api
   * @param {import("./git-reader.mjs").GitReader} deps.git
   * @param {string} deps.machineId    this host's canonical machine id
   * @param {() => Promise<{roots: string[], problems: string[]}>} deps.watchRoots  what this host grants, read each refresh
   * @param {string} deps.reporter     this daemon's reporter id, one per process
   * @param {() => number} [deps.now]
   * @param {typeof headFingerprint} [deps.fingerprint]
   */
  constructor({ api, git, machineId, watchRoots, reporter, now = Date.now, fingerprint = headFingerprint }) {
    this.#api = api;
    this.#git = git;
    this.#machineId = String(machineId || "");
    this.#hostKey = hostKeyOf(this.#machineId);
    this.#namespace = namespaceOf(this.#machineId);
    this.#watchRoots = watchRoots;
    this.#reporter = reporter;
    this.#now = now;
    this.#fingerprint = fingerprint;
  }

  /** One tick: the list when it is due, then every folder. Never throws; failures become problems. */
  async tick() {
    if (this.#now() - this.#listAttemptAt >= LIST_EVERY_MS) await this.refreshList();
    for (const [path, folder] of this.#folders) await this.#look(path, folder);
  }

  /** Fetch the watch list and decide which folders to watch. Keeps the last good list on failure. */
  async refreshList() {
    this.#listAttemptAt = this.#now();
    if (this.#hostKey === "") {
      this.#listProblem = `this host's machine id "${this.#machineId}" has no host key after its colon`;
      return;
    }
    try {
      const parsed = parseWatchList(await this.#api.watchList(this.#hostKey), this.#hostKey);
      if (!parsed.ok) throw new Error(parsed.problem);
      this.#items = parsed.items;
      this.#listProblem = "";
    } catch (error) {
      this.#listProblem = error?.message || String(error);
    }
    if (this.#items === null) return;
    const roots = await this.#roots();
    const { watch, refused } = selectLocations(this.#items, { namespace: this.#namespace, roots });
    this.#refused = refused;
    const kept = new Map();
    for (const location of watch) {
      kept.set(location.path, this.#folders.get(location.path) ?? { dirs: null, print: "", sentHead: "", problem: "" });
    }
    this.#folders = kept;
  }

  /** What this watcher is doing, for `/health` and the doctor's plugin-problems row. */
  state() {
    const problems = [];
    if (this.#listProblem) {
      problems.push(this.#items === null
        ? `no watch list yet: ${this.#listProblem}`
        : `the watch list was not refreshed (${this.#listProblem}); still watching the last good list`);
    }
    problems.push(...this.#rootsProblems);
    for (const { path, reason } of this.#refused) problems.push(`${path} is not read: ${reason}`);
    for (const [path, folder] of this.#folders) if (folder.problem) problems.push(`${path}: ${folder.problem}`);
    return {
      hostKey: this.#hostKey,
      watching: this.#folders.size,
      refused: this.#refused.length,
      reportsSent: this.#reportsSent,
      problems,
    };
  }

  /**
   * The granted roots, from `shared.watchRoots()`: `{roots, problems}`, where each problem names a grant
   * that granted nothing (a malformed list, an agent workspace that is not absolute, an unreadable
   * definition store).
   *
   * THE WHOLE SHAPE OR NOTHING. An answer whose `problems` is not a list grants nothing and says so,
   * rather than taking its roots and dropping its reasons: the shape changed once already (from a single
   * `problem`), and reading the old field then was silent.
   */
  async #roots() {
    const isTextList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
    try {
      const grant = await this.#watchRoots();
      if (!isTextList(grant?.roots) || !isTextList(grant?.problems)) {
        this.#rootsProblems = ["this aify-env's watch roots are not {roots, problems} lists, so no folder is read"];
        return [];
      }
      this.#rootsProblems = [...grant.problems];
      return grant.roots;
    } catch (error) {
      this.#rootsProblems = [`this aify-env's watch roots could not be read (${error?.message || error}), so no folder is read`];
      return [];
    }
  }

  async #look(path, folder) {
    try {
      folder.dirs ??= await this.#git.gitDirs(path);
      const print = this.#fingerprint(folder.dirs);
      if (folder.sentHead !== "" && print === folder.print) return;
      const head = await this.#git.head(path);
      if (head !== folder.sentHead) {
        await this.#api.reportHead({ machineId: this.#machineId, path, head, reporter: this.#reporter });
        folder.sentHead = head;
        this.#reportsSent += 1;
      }
      folder.print = print;
      folder.problem = "";
      // A git directory that vanished (the folder re-cloned, a worktree removed) is found afresh.
      if (print.startsWith("HEAD=absent")) folder.dirs = null;
    } catch (error) {
      folder.problem = error?.message || String(error);
    }
  }
}
