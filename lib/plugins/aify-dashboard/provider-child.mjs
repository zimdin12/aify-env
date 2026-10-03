// Starting the code provider's one-shot client, and making sure it ends.
//
// A THIRD-PARTY SCRIPT, SO IT GETS A MINIMAL ENVIRONMENT. aify-env's own environment can carry other services'
// keys, and nothing that client needs is in it beyond the few variables a process needs to run and find git. So it
// is handed those, its own APG_* configuration, and git's two quiet settings, and nothing else.
//
// IT ENDS, WITH EVERYTHING IT STARTED. A child past its time, or one running when the plugin stops, is killed with
// its whole process tree: the client runs git, and killing only the node process leaves those running. A child that
// hangs must not stall every later pass.
//
// No shell: the script runs on this daemon's own node, by path, with no arguments.

import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";

/** How long one run of the client may take before it is killed. It is one-shot: claim, answer, post, exit. */
export const CHILD_TIMEOUT_MS = 5 * 60_000;

/** The variables a process needs to start and find git and a temp folder. Everything else in the parent stays there. */
const CARRIED = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "USERPROFILE", "HOME", "TEMP", "TMP"];

/** How much of the child's standard error is kept, for a doctor row, once the secrets are out of it. */
export const KEPT_ERROR_CHARS = 4096;

/** How much is collected before that: the last this many characters, so a chatty client cannot grow the daemon. */
export const RAW_ERROR_CHARS = 64 * 1024;

/** How long a run waits for the tree kill it started before it settles anyway and says so. */
export const KILL_WAIT_MS = 10_000;

/**
 * What the child said, fit to keep: the dashboard key replaced, and only then cut to its last `KEPT_ERROR_CHARS`. PURE.
 *
 * ⛔ REPLACE, THEN CUT. Cut first, and a key the cut splits is no longer the whole key: it is not replaced, and its
 * other half is kept (review of 8e7a638, P2-K1). The writes are joined before anything is replaced, so a key split
 * across two writes is still found. When the raw collection was itself cut, the line it cut into is dropped whole,
 * because its front is the only place a part of a key can still be.
 */
export function keptError(raw, { clipped, key }) {
  let text = String(raw);
  if (clipped) {
    const lineEnd = text.indexOf("\n");
    text = lineEnd === -1 ? "" : text.slice(lineEnd + 1);
  }
  if (typeof key === "string" && key !== "") text = text.split(key).join("<the dashboard key>");
  return text.slice(-KEPT_ERROR_CHARS);
}

/**
 * The child's whole environment: the carried variables, its configuration, and git's no-lock, no-prompt pair. PURE.
 *
 * ONE SPELLING PER NAME. On Windows `process.env` answers `PATH` and `Path` alike, and a child handed both is handed
 * two variables Windows treats as one, so the first spelling found is the one carried.
 */
export function childEnv(parentEnv, configuration) {
  const env = {};
  const carried = new Set();
  for (const name of CARRIED) {
    if (carried.has(name.toUpperCase()) || typeof parentEnv[name] !== "string") continue;
    env[name] = parentEnv[name];
    carried.add(name.toUpperCase());
  }
  return { ...env, ...configuration, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * taskkill's absolute path, from SystemRoot, or null. Never the bare name: Windows looks for a bare name in the
 * working directory before PATH, which is how a planted git.exe once ran inside this daemon (review of 0.8.1).
 */
export function taskkillPath(env = process.env) {
  const root = String(env.SystemRoot || env.SYSTEMROOT || "");
  return win32.isAbsolute(root) ? win32.join(root, "System32", "taskkill.exe") : null;
}

/**
 * Kill a process and everything it started, resolving once that is done and rejecting when it was not. On Windows
 * `taskkill /T` walks the tree; elsewhere the group is signalled. A Windows host with no SystemRoot has no taskkill
 * this will run by name, so only the process itself is killed there.
 *
 * ⛔ A FAILED KILL IS A REJECTION. Resolved whatever taskkill's callback carried, a refused or failed taskkill reached
 * the run as a tree confirmed ended (review of 17f6f48, S1-R3). Only "no such process" counts as ended.
 */
export function killTree(pid, { platform = process.platform, run = execFile, taskkill = taskkillPath(), signalProcess = (target, name) => process.kill(target, name) } = {}) {
  return new Promise((resolve, reject) => {
    if (platform === "win32" && taskkill !== null) {
      run(taskkill, ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
      return;
    }
    try {
      signalProcess(-pid, "SIGKILL");
    } catch {
      try {
        signalProcess(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          reject(error);
          return;
        }
      }
    }
    resolve();
  });
}

/** Why the tree is not known to be gone, from the failure of the kill that was to end it. */
const killFailed = (error) => `the client's process tree was not confirmed ended: ${error?.message || error}`;

/**
 * Run `node <script>` in `cwd` with exactly `env`, and resolve when it has ended, however it ended, and when any kill
 * it started has finished or been given up on. `key` is cut out of whatever it said before that is kept.
 *
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, stopped: boolean, error: string}>}
 */
export function runChild({ nodePath, script, cwd, env, key = "", timeoutMs = CHILD_TIMEOUT_MS, killWaitMs = KILL_WAIT_MS, signal, start = spawn, kill = killTree }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = start(nodePath, [script], { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, stopped: false, error: `could not start it: ${keptError(error?.message || error, { clipped: false, key })}` });
      return;
    }
    let stderr = "";
    let clipped = false;
    const collect = (text) => {
      stderr += text;
      if (stderr.length > RAW_ERROR_CHARS) {
        stderr = stderr.slice(-RAW_ERROR_CHARS);
        clipped = true;
      }
    };
    let timedOut = false;
    let stopped = false;
    // A spawn that fails (no such program, a working folder that is gone) still closes, with the error number as its
    // code (-4058 on Windows, measured): that is not an exit of the client, so it is reported as no exit at all.
    let started = false;
    let startError = "";
    child.on("spawn", () => { started = true; });
    child.stderr?.on("data", (chunk) => collect(String(chunk)));

    // ⛔ A RUN THAT STARTED A KILL OWNS IT, AND IS BOUNDED FROM THAT MOMENT. Settled when the client closed, a stop
    // "completed" while its tree kill was still running (review of 8e7a638, P2-S1). Then the kill was waited for only
    // from the close: a kill that failed before the close went unhandled (review of 17f6f48, S1-R1), and a client the
    // kill could not end, which never closes, held the plugin's stop for ever (S1-R2). So from the kill's start its
    // outcome is caught, and a deadline runs: the run settles once the client has closed and the kill has answered,
    // or at the deadline, saying which of the two it did not see. Expiry is never read as an end.
    let killing = false;
    let killSaid = null; // null while the kill is unanswered; then "" for done, or why the tree is not known to be gone
    let closed = null; // {code, killedBy} once the client has closed
    let deadline = null;
    let settled = false;
    const settle = (unconfirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!started) {
        resolve({ code: null, signal: null, timedOut: false, stopped, error: [keptError(startError, { clipped: false, key }) || "could not start it", unconfirmed].filter(Boolean).join("; ") });
        return;
      }
      const said = keptError(stderr, { clipped, key }).trim().split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "";
      resolve({ code: closed?.code ?? null, signal: closed?.killedBy ?? null, timedOut, stopped, error: [said, unconfirmed].filter(Boolean).join("; ") });
    };
    const settleIfDone = () => { if (closed !== null && (!killing || killSaid !== null)) settle(killSaid ?? ""); };
    const end = (why) => {
      if (why === "timeout") timedOut = true;
      else stopped = true;
      if (killing) return; // once: a timeout and then a stop are one kill of one tree
      killing = true;
      let attempt;
      try {
        attempt = Promise.resolve(kill(child.pid));
      } catch (error) {
        attempt = Promise.reject(error);
      }
      attempt.then(() => "", killFailed).then((said) => { killSaid = said; settleIfDone(); });
      deadline = setTimeout(() => {
        const within = `within ${killWaitMs / 1000} s`;
        const unanswered = killSaid === null ? `the client's process tree was not confirmed ended ${within}` : killSaid;
        settle([unanswered, closed === null ? `the client did not close ${within} of being killed` : ""].filter(Boolean).join("; "));
      }, killWaitMs);
    };
    const timer = setTimeout(() => end("timeout"), timeoutMs);
    timer.unref?.();
    const onAbort = () => end("stop");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (!started) startError = `could not start it: ${error?.message || error}`;
      else collect(`\n${error?.message || error}`);
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      closed = { code, killedBy };
      settleIfDone();
    });
  });
}
