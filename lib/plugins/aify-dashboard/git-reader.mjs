// Every git process this plugin runs, and the rules each one runs under.
//
// THE FOLDERS BELONG TO WORKING AGENTS. A watcher that took the index lock, prompted for a password, or
// wrote anything would be felt by whoever is committing in that folder at the time. So git runs here
// with a fixed argument list and no shell, only the verbs that read, `GIT_OPTIONAL_LOCKS=0` so a status
// refresh never takes the index lock, and `GIT_TERMINAL_PROMPT=0` so nothing waits on a terminal that
// is not there.
//
// ONE AT A TIME. Two hundred folders that all moved at once (a `git pull` across a workspace) would
// otherwise start two hundred processes together on a machine whose agents are also running.
//
// STOPPABLE. Every call takes the plugin's stop signal: a running git is killed, and a queued one never
// starts. The host stops its plugins inside one shared budget, and a stop that waited out a 30 s git
// would spend the other plugins' share of it.
//
// NOT THROUGH PluginProcesses: those are terminal workers with a PTY and a reaper, and a git query
// that finishes in milliseconds is not one.
//
// GIT BY ITS ABSOLUTE PATH, FROM PATH ONLY. Given a bare `git`, Windows looks in the working directory
// before PATH, and the working directory here is a folder an agent writes: a `git.exe` placed in a granted
// folder ran inside this daemon (external review of 0.8.1, HIGH 3). Relative PATH entries are skipped for
// the same reason, and when no git is found nothing runs: falling back to the bare name is the defect.

import { execFile as nodeExecFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { resolveExecutable } from "../../interpreter.mjs";

/** How long one git process may run before it is killed and its folder reported. */
export const GIT_TIMEOUT_MS = 30_000;

/** The only verbs this plugin may run. Each of them reads. */
export const READ_ONLY_VERBS = Object.freeze(["rev-parse", "log"]);

/**
 * A full object id: SHA-1 or SHA-256, lower-case hex, as `rev-parse --verify` prints it.
 *
 * EVERY ID THIS PLUGIN HANDS GIT IS CHECKED AGAINST IT FIRST. The ids a commit range is read between come from the
 * dashboard, and an id that began with `-` would be read by git as an option.
 */
export const FULL_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const FULL_HEAD = FULL_ID;

/**
 * git's absolute path from the absolute entries of `env`'s PATH, or null.
 *
 * @param {object} env  the environment whose PATH is searched (`Path` on a plain Windows object)
 */
export function gitOnPath(env, { find = resolveExecutable, sep = process.platform === "win32" ? ";" : ":" } = {}) {
  const dirs = String(env?.PATH ?? env?.Path ?? "").split(sep).map((dir) => dir.trim()).filter((dir) => isAbsolute(dir));
  const found = find("git", { pathValue: dirs.join(sep), sep });
  return isAbsolute(found) ? found : null;
}

/** How much a `git log` of one range may print. A range is read once per head move. */
export const LOG_MAX_BYTES = 64 * 1024 * 1024;

/** A failed git call, with the sentence a doctor row shows for it, git's exit code when it exited, and what it said. */
export class GitReadError extends Error {
  constructor(message, { exitCode = null, stderr = "" } = {}) {
    super(message);
    this.name = "GitReadError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Throws unless `id` is a full commit id. */
function checkedId(id, what) {
  if (typeof id !== "string" || !FULL_ID.test(id)) throw new GitReadError(`${what} ${JSON.stringify(id)} is not a full commit id`);
  return id;
}

/** How `commitsBetween` asks git to print each commit: a NUL before it, and one after each field. */
const LOG_FORMAT = "--format=%x00%H%x00%ct%x00%s";

/** Why a log was refused, with where it stopped making sense. */
function unparsable(what) {
  return new GitReadError(`git log printed ${what}, so none of this range is reported`);
}

/**
 * The commits `git log -z --name-only` printed in `LOG_FORMAT`, oldest first as asked.
 *
 * NUL-FRAMED, because NUL is the one byte that cannot be in a subject or a path. A subject may hold any other
 * control character, and the \x1e and \x1f this once split on cut a subject short or made one commit two. With
 * `-z` git also stops quoting paths, so `naïve.txt` arrives as itself rather than as `"na\303\257ve.txt"`. Measured
 * on git 2.54: each commit prints as NUL, id, NUL, seconds, NUL, subject, NUL; one that changed files follows that
 * with a newline and each path, each path followed by a NUL. Git cuts a subject at a NUL that plumbing put there.
 *
 * REFUSED WHOLE, NOT READ ROUGHLY. Anything that does not fit is an error: a shortened subject, or the next
 * commit's id stored as a file name, would be a history the dashboard keeps and nobody wrote.
 *
 * `committedAt` is milliseconds, the unit the dashboard stores; git prints seconds.
 */
export function parseLog(text) {
  const out = String(text);
  if (out === "") return [];
  const tokens = out.split("\0");
  if (tokens.pop() !== "") throw unparsable("a record that does not end with a NUL");
  const commits = [];
  let at = 0;
  while (at < tokens.length) {
    const [opening, sha, seconds, subject] = tokens.slice(at, at + 4);
    const which = `commit ${commits.length + 1}`;
    if (opening !== "") throw unparsable(`something before ${which} other than a NUL`);
    if (subject === undefined) throw unparsable(`${which} cut short`);
    if (!FULL_ID.test(sha)) throw unparsable(`${JSON.stringify(sha)} where ${which}'s id belongs`);
    if (!/^\d+$/.test(seconds)) throw unparsable(`${JSON.stringify(seconds)} where ${which}'s time belongs`);
    at += 4;
    const files = [];
    if (at < tokens.length && tokens[at] !== "") {
      if (!tokens[at].startsWith("\n")) throw unparsable(`${which}'s files without the newline that opens them`);
      tokens[at] = tokens[at].slice(1);
      for (; at < tokens.length && tokens[at] !== ""; at += 1) files.push(tokens[at]);
      if (files.length === 0) throw unparsable(`an empty file name in ${which}`);
    }
    commits.push({ sha, committedAt: Number(seconds) * 1000, subject, files });
  }
  return commits;
}

/**
 * What a failed git process means, in the words an operator acts on.
 *
 * DUBIOUS OWNERSHIP BY NAME, because it is the likely failure on Windows: a folder created by another
 * user (an installer, an elevated shell, a container) is refused by git until it is listed in
 * `safe.directory`, and the raw message does not say that the fix is a git setting rather than a
 * permission.
 */
export function gitFailureMessage(args, error, stderr) {
  const said = String(stderr || "").trim().split(/\r?\n/).find((line) => line.trim() !== "") || "";
  const command = `git ${args.join(" ")}`;
  if (/dubious ownership/i.test(stderr || "")) {
    return `git refuses this folder as dubious ownership; add it to safe.directory (git config --global --add safe.directory <folder>): ${said}`;
  }
  if (error?.killed || error?.signal === "SIGTERM") return `${command} took longer than ${GIT_TIMEOUT_MS / 1000} s and was stopped`;
  if (error?.code === "ENOENT") return "git is not on this host's PATH";
  return `${command} failed${said ? `: ${said}` : ""}`;
}

export class GitReader {
  #execFile;
  #env;
  #findGit;
  #git = null;
  #timeoutMs;
  #queue = Promise.resolve();

  /**
   * @param {object} [deps]
   * @param {Function} [deps.execFile]  node's `execFile` signature; injected so a test can count calls
   * @param {object} [deps.env]         the environment git inherits, before the two fixed variables
   * @param {number} [deps.timeoutMs]
   * @param {Function} [deps.findGit]   () => git's absolute path or null; looked up until it is found
   */
  constructor({ execFile = nodeExecFile, env = process.env, timeoutMs = GIT_TIMEOUT_MS, findGit = () => gitOnPath(env) } = {}) {
    this.#execFile = execFile;
    this.#findGit = findGit;
    this.#env = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Run one read-only git command in `cwd`, after every command queued before it has finished.
   *
   * @param {string} [options.gitDir]  the git directory git reads, instead of the one it would find from `cwd`
   * @returns {Promise<string>} its standard output
   */
  run(cwd, args, { signal, gitDir, maxBuffer } = {}) {
    if (!READ_ONLY_VERBS.includes(args[0])) {
      return Promise.reject(new GitReadError(`git ${args[0]} is not a read-only verb this plugin may run`));
    }
    const env = gitDir === undefined ? this.#env : { ...this.#env, GIT_DIR: gitDir };
    const result = this.#queue.then(() => (signal?.aborted
      ? Promise.reject(new GitReadError(`git ${args.join(" ")} was not started: the plugin is stopping`))
      : this.#spawn(cwd, args, env, signal, maxBuffer)));
    // The queue waits on every call, failed or not: one folder's error must not stop the next folder.
    this.#queue = result.catch(() => {});
    return result;
  }

  /** The folder's own git directory and the common one its branch refs live in, both absolute. */
  async gitDirs(location, options = {}) {
    // The working tree's top level too: a folder inside a repository is read through the repository git walks up to,
    // and that is what the grant check judges. A bare repository has none, and is refused here.
    const out = await this.run(location, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], options);
    const [toplevel, gitDir, commonDir] = out.split(/\r?\n/).map((line) => line.trim());
    if (!toplevel || !gitDir || !commonDir) throw new GitReadError("git rev-parse did not name the working tree and the git directories");
    // `--git-common-dir` may be relative to the folder; the other two never are.
    return { toplevel, gitDir, commonDir: resolve(location, commonDir) };
  }

  /**
   * Run `args` against one folder's judged places: every read of a folder's head or history comes through here.
   *
   * ⛔ READ FROM THE JUDGED PLACES, never from the listed folder. Given the folder's path, git would resolve it again,
   * through whatever a junction on it or its `.git` file names by then: a junction re-pointed between the grant check
   * and this read had the outside HEAD reported (review of bf4ce1c, G-RACE), and a range read the same way would read
   * the outside history. So the real git directory is named outright, as GIT_DIR: that is what closes it, because git
   * then consults neither the folder nor its `.git` file (measured). It runs in the real working tree only because it
   * must run somewhere. A path is refused, not run.
   * Not pinned by GIT_DIR: a linked worktree's `commondir`, which git's refs still follow even under GIT_COMMON_DIR
   * (measured on git 2.54), so a rewrite of it inside the judged git directory is the stated residual.
   *
   * @param {{toplevel: string, gitDir: string}} places  real paths, judged inside the grant (grant-check.mjs)
   */
  #inPlaces(places, args, options) {
    if (typeof places?.toplevel !== "string" || typeof places?.gitDir !== "string") {
      throw new GitReadError("a git read needs the folder's judged working tree and git directory, not its path");
    }
    return this.run(places.toplevel, args, { ...options, gitDir: places.gitDir });
  }

  /** The commit HEAD names, as a full id. A folder with no commit yet is a failure, not a head. */
  async head(places, options = {}) {
    const out = (await this.#inPlaces(places, ["rev-parse", "--verify", "HEAD"], options)).trim();
    if (!FULL_HEAD.test(out)) throw new GitReadError("HEAD names no commit yet");
    return out;
  }

  /**
   * Whether `id` names a commit this repository holds.
   *
   * ABSENCE IS RECOGNISED, NEVER INFERRED. `rev-parse --verify --quiet` answers a commit it cannot find with exit 1
   * and nothing on stderr (measured, git 2.54). A folder that is not a repository, one git refuses, or an object
   * store it cannot read exits 128 or says why, and is a failure. A failure read as "missing" sends a resync, and
   * the dashboard records the history in between as a gap the folder never lost.
   */
  async hasCommit(places, id, options = {}) {
    try {
      await this.#inPlaces(places, ["rev-parse", "--verify", "--quiet", `${checkedId(id, "commit")}^{commit}`], options);
      return true;
    } catch (error) {
      if (error instanceof GitReadError && error.exitCode === 1 && error.stderr.trim() === "") return false;
      throw error;
    }
  }

  /** Whether every commit reachable from `ancestor` is reachable from `head`: `ancestor` is in `head`'s history. */
  async contains(places, ancestor, head, options = {}) {
    const out = await this.#inPlaces(places, ["log", "-1", "--format=%H", checkedId(ancestor, "ancestor"), `^${checkedId(head, "head")}`], options);
    return out.trim() === "";
  }

  /** The commits after `base` up to `target`, oldest first, each with the files it changed. */
  async commitsBetween(places, base, target, options = {}) {
    const range = `${checkedId(base, "base")}..${checkedId(target, "target")}`;
    const out = await this.#inPlaces(places, ["log", "-z", "--reverse", "--no-color", LOG_FORMAT, "--name-only", range],
      { ...options, maxBuffer: LOG_MAX_BYTES });
    return parseLog(out);
  }

  #spawn(cwd, args, env, signal, maxBuffer) {
    this.#git ??= this.#findGit();
    if (!this.#git) {
      return Promise.reject(new GitReadError("git is not on this host's PATH as an absolute path; nothing was run in this folder"));
    }
    return new Promise((resolveRun, reject) => {
      this.#execFile(this.#git, args, { cwd, env, timeout: this.#timeoutMs, windowsHide: true, encoding: "utf8", ...(maxBuffer ? { maxBuffer } : {}), ...(signal ? { signal } : {}) },
        (error, stdout, stderr) => {
          if (error) reject(new GitReadError(gitFailureMessage(args, error, stderr), { exitCode: Number.isInteger(error.code) ? error.code : null, stderr: String(stderr ?? "") }));
          else resolveRun(String(stdout));
        });
    });
  }
}
