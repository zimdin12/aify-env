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
export const READ_ONLY_VERBS = Object.freeze(["rev-parse", "log", "cat-file"]);

/** A head is a full object id: SHA-1 or SHA-256, lower-case hex, as `rev-parse --verify` prints it. */
const FULL_HEAD = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

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

/** A failed git call, with the sentence a doctor row shows for it. */
export class GitReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitReadError";
  }
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
  run(cwd, args, { signal, gitDir } = {}) {
    if (!READ_ONLY_VERBS.includes(args[0])) {
      return Promise.reject(new GitReadError(`git ${args[0]} is not a read-only verb this plugin may run`));
    }
    const env = gitDir === undefined ? this.#env : { ...this.#env, GIT_DIR: gitDir };
    const result = this.#queue.then(() => (signal?.aborted
      ? Promise.reject(new GitReadError(`git ${args.join(" ")} was not started: the plugin is stopping`))
      : this.#spawn(cwd, args, env, signal)));
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
   * The commit HEAD names, as a full id. A folder with no commit yet is a failure, not a head.
   *
   * ⛔ READ FROM THE JUDGED PLACES, never from the listed folder. Given the folder's path, git would resolve it again,
   * through whatever a junction on it or its `.git` file names by then: a junction re-pointed between the grant check
   * and this read had the outside HEAD reported (review of bf4ce1c, G-RACE). So the real git directory is named
   * outright, as GIT_DIR: that is what closes it, because git then consults neither the folder nor its `.git` file
   * (measured). It runs in the real working tree only because it must run somewhere. A path is refused, not run.
   * Not pinned by GIT_DIR: a linked worktree's `commondir`, which git's refs still follow even under GIT_COMMON_DIR
   * (measured on git 2.54), so a rewrite of it inside the judged git directory is the stated residual.
   *
   * @param {{toplevel: string, gitDir: string}} places  real paths, judged inside the grant (grant-check.mjs)
   */
  async head(places, options = {}) {
    if (typeof places?.toplevel !== "string" || typeof places?.gitDir !== "string") {
      throw new GitReadError("a head read needs the folder's judged working tree and git directory, not its path");
    }
    const out = (await this.run(places.toplevel, ["rev-parse", "--verify", "HEAD"], { ...options, gitDir: places.gitDir })).trim();
    if (!FULL_HEAD.test(out)) throw new GitReadError("HEAD names no commit yet");
    return out;
  }

  #spawn(cwd, args, env, signal) {
    this.#git ??= this.#findGit();
    if (!this.#git) {
      return Promise.reject(new GitReadError("git is not on this host's PATH as an absolute path; nothing was run in this folder"));
    }
    return new Promise((resolveRun, reject) => {
      this.#execFile(this.#git, args, { cwd, env, timeout: this.#timeoutMs, windowsHide: true, encoding: "utf8", ...(signal ? { signal } : {}) },
        (error, stdout, stderr) => {
          if (error) reject(new GitReadError(gitFailureMessage(args, error, stderr)));
          else resolveRun(String(stdout));
        });
    });
  }
}
