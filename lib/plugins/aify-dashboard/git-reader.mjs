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
// NOT THROUGH PluginProcesses: those are terminal workers with a PTY and a reaper, and a git query
// that finishes in milliseconds is not one.

import { execFile as nodeExecFile } from "node:child_process";
import { resolve } from "node:path";

/** How long one git process may run before it is killed and its folder reported. */
export const GIT_TIMEOUT_MS = 30_000;

/** The only verbs this plugin may run. Each of them reads. */
export const READ_ONLY_VERBS = Object.freeze(["rev-parse", "log", "cat-file"]);

/** A head is a full object id: SHA-1 or SHA-256, lower-case hex, as `rev-parse --verify` prints it. */
const FULL_HEAD = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

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
  #timeoutMs;
  #queue = Promise.resolve();

  /**
   * @param {object} [deps]
   * @param {Function} [deps.execFile]  node's `execFile` signature; injected so a test can count calls
   * @param {object} [deps.env]         the environment git inherits, before the two fixed variables
   * @param {number} [deps.timeoutMs]
   */
  constructor({ execFile = nodeExecFile, env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
    this.#execFile = execFile;
    this.#env = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Run one read-only git command in `cwd`, after every command queued before it has finished.
   *
   * @returns {Promise<string>} its standard output
   */
  run(cwd, args) {
    if (!READ_ONLY_VERBS.includes(args[0])) {
      return Promise.reject(new GitReadError(`git ${args[0]} is not a read-only verb this plugin may run`));
    }
    const result = this.#queue.then(() => this.#spawn(cwd, args));
    // The queue waits on every call, failed or not: one folder's error must not stop the next folder.
    this.#queue = result.catch(() => {});
    return result;
  }

  /** The folder's own git directory and the common one its branch refs live in, both absolute. */
  async gitDirs(location) {
    const out = await this.run(location, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
    const [gitDir, commonDir] = out.split(/\r?\n/).map((line) => line.trim());
    if (!gitDir || !commonDir) throw new GitReadError("git rev-parse did not name the git directories");
    // `--git-common-dir` may be relative to the folder; `--absolute-git-dir` never is.
    return { gitDir, commonDir: resolve(location, commonDir) };
  }

  /** The commit HEAD names, as a full id. A folder with no commit yet is a failure, not a head. */
  async head(location) {
    const out = (await this.run(location, ["rev-parse", "--verify", "HEAD"])).trim();
    if (!FULL_HEAD.test(out)) throw new GitReadError("HEAD names no commit yet");
    return out;
  }

  #spawn(cwd, args) {
    return new Promise((resolveRun, reject) => {
      this.#execFile("git", args, { cwd, env: this.#env, timeout: this.#timeoutMs, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) reject(new GitReadError(gitFailureMessage(args, error, stderr)));
          else resolveRun(String(stdout));
        });
    });
  }
}
