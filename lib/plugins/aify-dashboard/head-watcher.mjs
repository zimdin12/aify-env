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
// than being recorded here as done, and a folder with an open problem is always looked at again: the
// quiet-tick shortcut is for a folder that is fine, and taking it with a problem open leaves that problem
// standing after the folder has recovered.
//
// A FOLDER'S GIT DIRECTORIES ARE KEPT ONLY WHILE ITS BINDING HOLDS (`bindingOf`). Rebound to another
// repository, it is resolved again, because the old repository's fingerprint would never move.
//
// WHAT ONE LOOK READS IS WHAT IT JUDGED. The folder's real places are resolved once and checked against the grant,
// and the fingerprint, the checks of what the git directories hold, and git itself all read those real paths. A
// change on the listed path, on a junction above the git directories, or to a worktree's `.git` file after the check
// therefore changes nothing this look reads; the next look sees the new binding and judges it. What is NOT closed is a
// write INSIDE the judged git directories in the moment between the checks and git's read (a link made there, a
// `commondir` or `alternates` rewritten, a real directory renamed away and a link put in its place): Node opens by
// path, so nothing here can pin what a path names across that moment.
//
// COMMITS FOLLOW THE HEAD. When the head a folder is at is not the one the dashboard has accepted
// commits up to, the commits in between are reported (`RangeReporter`), and where coverage stands is then
// read back from the dashboard rather than worked out here.
//
// A STOPPED TICK RECORDS NOTHING. The stop signal cancels the work in flight, and the errors that
// produces are the stop, not problems with the folders.

import { realpathSync } from "node:fs";

import { bindingOf, headFingerprint } from "./fingerprint.mjs";
import { containmentOf, quietContainmentOf } from "./git-dir-contents.mjs";
import { escapeOf, realPlaces, realRoots } from "./grant-check.mjs";
import { hostKeyOf, namespaceOf, parseWatchList, PLATFORM_OF, selectLocations } from "./locations.mjs";
import { RangeReporter } from "./range-reporter.mjs";
import { withinWatchRoots } from "../../watch-roots.mjs";

export const TICK_MS = 10_000;
export const LIST_EVERY_MS = 5 * 60_000;

export class HeadWatcher {
  #api;
  #git;
  #fingerprint;
  #binding;
  #realpath;
  #contents;
  /** The real paths of the roots the last refresh was granted: what every folder's resolved places are judged against */
  #realRoots = [];
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
  #commitsSent = 0;
  #resyncs = 0;
  #ranges;

  /**
   * @param {object} deps
   * @param {import("./dashboard-api.mjs").DashboardApi} deps.api
   * @param {import("./git-reader.mjs").GitReader} deps.git
   * @param {string} deps.machineId    this host's canonical machine id
   * @param {() => Promise<{roots: string[], problems: string[]}>} deps.watchRoots  what this host grants, read each refresh
   * @param {string} deps.reporter     this daemon's reporter id, one per process
   * @param {() => number} [deps.now]
   * @param {typeof headFingerprint} [deps.fingerprint]
   * @param {typeof bindingOf} [deps.binding]
   * @param {(path: string) => string} [deps.realpath]  how a path resolves to the one git really reads
   * @param {{quiet: typeof quietContainmentOf, nested: typeof containmentOf}} [deps.contents]  what a git directory may hold
   */
  constructor({ api, git, machineId, watchRoots, reporter, now = Date.now, fingerprint = headFingerprint, binding = bindingOf, realpath = realpathSync.native, contents = { quiet: quietContainmentOf, nested: containmentOf } }) {
    this.#api = api;
    this.#git = git;
    this.#machineId = String(machineId || "");
    this.#hostKey = hostKeyOf(this.#machineId);
    this.#namespace = namespaceOf(this.#machineId);
    this.#watchRoots = watchRoots;
    this.#reporter = reporter;
    this.#now = now;
    this.#fingerprint = fingerprint;
    this.#binding = binding;
    this.#realpath = realpath;
    this.#contents = contents;
    this.#ranges = new RangeReporter({ api, git, machineId: this.#machineId, reporter });
  }

  /** One tick: the list when it is due, then every folder. Never throws; failures become problems. */
  async tick({ signal } = {}) {
    if (this.#now() - this.#listAttemptAt >= LIST_EVERY_MS) await this.refreshList({ signal });
    for (const [path, folder] of this.#folders) {
      if (signal?.aborted) return;
      await this.#look(path, folder, signal);
    }
  }

  /** Fetch the watch list and decide which folders to watch. Keeps the last good list on failure. */
  async refreshList({ signal } = {}) {
    this.#listAttemptAt = this.#now();
    if (this.#hostKey === "") {
      this.#listProblem = `this host's machine id "${this.#machineId}" has no host key after its colon`;
      return;
    }
    try {
      const parsed = parseWatchList(await this.#api.watchList(this.#hostKey, { signal }), this.#hostKey);
      if (!parsed.ok) throw new Error(parsed.problem);
      this.#items = parsed.items;
      this.#listProblem = "";
    } catch (error) {
      if (signal?.aborted) return;
      this.#listProblem = error?.message || String(error);
    }
    if (this.#items === null) return;
    const roots = await this.#roots();
    const { watch, refused } = selectLocations(this.#items, { namespace: this.#namespace, roots });
    this.#refused = refused;
    const kept = new Map();
    for (const location of watch) {
      const folder = this.#folders.get(location.path) ?? { bound: null, dirs: null, print: "", sentHead: "", cursor: null, problem: "" };
      // The project is taken from each refresh, so a folder re-registered under another project is served as that one.
      // Set on the folder itself, not a copy: a look in progress holds this object and writes to it.
      folder.projectId = location.projectId;
      kept.set(location.path, folder);
    }
    this.#folders = kept;
  }

  /**
   * The folders being watched now, with their projects: the only folders anything else in this plugin may serve.
   * `platform` is how their paths compare against a grant, the same rule that chose them.
   *
   * ONLY THOSE THE LAST LOOK JUDGED INSIDE THE GRANT. A listed folder whose repository is outside it (grant-check.mjs)
   * stays in the list with its problem, and one not yet looked at has not been judged at all; serving either would
   * start a process that reads the repository outside.
   *
   * `real` is the folder's real path as that look judged it, and is where a client runs: `path` is matched against
   * the grant and the project, and is resolved afresh by anything that opens it.
   */
  watched() {
    const platform = this.#platform();
    return [...this.#folders].filter(([, folder]) => folder.inside === true)
      .map(([path, folder]) => ({ projectId: folder.projectId, path, real: folder.real, platform }));
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
      commitsSent: this.#commitsSent,
      resyncs: this.#resyncs,
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
        this.#realRoots = [];
        return [];
      }
      this.#rootsProblems = [...grant.problems];
      this.#realRoots = realRoots(grant.roots, { realpath: this.#realpath, platform: this.#platform() });
      return grant.roots;
    } catch (error) {
      this.#rootsProblems = [`this aify-env's watch roots could not be read (${error?.message || error}), so no folder is read`];
      this.#realRoots = [];
      return [];
    }
  }

  /** How this watcher's paths compare against a grant: the same rule that chose its folders. */
  #platform() {
    return PLATFORM_OF[this.#namespace] ?? process.platform;
  }

  async #look(path, folder, signal) {
    // Inside the grant only once this look has judged it so; anything that stops the look first leaves it outside.
    folder.inside = false;
    try {
      const bound = this.#binding(path);
      if (bound !== folder.bound) {
        folder.bound = bound;
        folder.dirs = null;
        folder.print = "";
      }
      folder.dirs ??= await this.#git.gitDirs(path, { signal });
      // ONE RESOLUTION PER LOOK: the real places are judged, and then every read in this look is of them, the git read
      // too. Read through the listed path instead, a junction re-pointed on it after the check led git out of the
      // grant on that same look (review of bf4ce1c, G-RACE).
      const places = realPlaces(folder.dirs, { realpath: this.#realpath });
      const escape = escapeOf(places, this.#realRoots, this.#platform());
      if (escape) throw new Error(`this folder is not read: ${escape}; grant that folder too, or stop listing this one`);
      // The folder itself as this look finds it, which is where the provider's client is run (`watched`): the listed
      // path is resolved again whenever it is used, and a junction re-pointed after this look would lead the client out.
      folder.real = this.#realpath(path);
      if (!withinWatchRoots(folder.real, this.#realRoots, this.#platform())) {
        throw new Error(`this folder is not read: it is ${folder.real}, outside every granted root; grant that folder too, or stop listing this one`);
      }
      // Every look, before the fingerprint reads HEAD and stats the ref it names: none of those may lead out either.
      const quiet = this.#contents.quiet(places);
      if (quiet) throw new Error(`this folder is not read: ${quiet}; grant that folder too, or stop listing this one`);
      const print = this.#fingerprint(places);
      // Quiet only when the last full look found nothing wrong, so that look's judgement stands.
      if (folder.sentHead !== "" && print === folder.print && folder.problem === "") {
        folder.inside = true;
        return;
      }
      // Something moved, so git is about to read refs and history: nothing nested in those directories may lead out.
      const nested = this.#contents.nested(places, this.#realRoots, this.#platform());
      if (nested) throw new Error(`this folder is not read: ${nested}; grant that folder too, or stop listing this one`);
      folder.inside = true;
      const head = await this.#git.head(places, { signal });
      if (head !== folder.sentHead) {
        folder.cursor = cursorFrom(await this.#report(path, head, signal));
        folder.sentHead = head;
        this.#reportsSent += 1;
      }
      if (folder.cursor.ackedHead !== head) {
        const outcome = await this.#ranges.sync({ path, places, head, cursor: folder.cursor, signal });
        if (outcome.kind === "range") this.#commitsSent += outcome.commits;
        if (outcome.kind === "resync") this.#resyncs += 1;
        // Where coverage now stands is the dashboard's to say, so it is read back, not computed here. Short of the
        // head (a range superseded because the cursor moved while it was sent) is a problem, so the next tick tries
        // again instead of taking the quiet-tick shortcut past a folder that is behind.
        folder.cursor = cursorFrom(await this.#report(path, head, signal));
        if (folder.cursor.ackedHead !== head) {
          throw new Error(`the dashboard's coverage stopped at ${folder.cursor.ackedHead}, short of ${head}; it is tried again`);
        }
      }
      folder.print = print;
      folder.problem = "";
      // A git directory that vanished (the folder re-cloned, a worktree removed) is found afresh.
      if (print.startsWith("HEAD=absent")) folder.dirs = null;
    } catch (error) {
      if (signal?.aborted) return;
      // A range or resync refused as stale carries the cursor as it really is; the next look starts from it.
      const current = cursorOrNull(error?.current);
      if (current !== null) folder.cursor = current;
      folder.problem = error?.message || String(error);
    }
  }

  #report(path, head, signal) {
    return this.#api.reportHead({ machineId: this.#machineId, path, head, reporter: this.#reporter }, { signal });
  }
}

/** The dashboard's coverage of a folder, from its answer, or null when the answer does not carry it. */
function cursorOrNull(value) {
  return value && typeof value.ackedHead === "string" && Number.isSafeInteger(value.cursorRevision)
    ? { ackedHead: value.ackedHead, cursorRevision: value.cursorRevision }
    : null;
}

/**
 * The same, refusing an answer without it. FAILS CLOSED: a head report the dashboard answered without saying
 * which head it has accepted gives no base to report commits from, and guessing one would skip or repeat them.
 */
function cursorFrom(answer) {
  const cursor = cursorOrNull(answer);
  if (cursor === null) throw new Error("the dashboard's answer to a head report did not say which head it has accepted, so commits are not reported");
  return cursor;
}
