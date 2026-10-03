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

/** How much of the child's standard error is kept, for a doctor row. Its output is not logged. */
const KEPT_ERROR_BYTES = 4096;

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
 * Kill a process and everything it started. On Windows `taskkill /T` walks the tree; elsewhere the group is
 * signalled. A Windows host with no SystemRoot has no taskkill this will run by name, so only the process itself is
 * killed there.
 */
export function killTree(pid, { platform = process.platform, run = execFile, taskkill = taskkillPath() } = {}) {
  return new Promise((resolve) => {
    if (platform === "win32" && taskkill !== null) {
      run(taskkill, ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    resolve();
  });
}

/**
 * Run `node <script>` in `cwd` with exactly `env`, and resolve when it has ended, however it ended.
 *
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, stopped: boolean, error: string}>}
 */
export function runChild({ nodePath, script, cwd, env, timeoutMs = CHILD_TIMEOUT_MS, signal, start = spawn, kill = killTree }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = start(nodePath, [script], { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, stopped: false, error: `could not start it: ${error?.message || error}` });
      return;
    }
    let stderr = "";
    let timedOut = false;
    let stopped = false;
    // A spawn that fails (no such program, a working folder that is gone) still closes, with the error number as its
    // code (-4058 on Windows, measured): that is not an exit of the client, so it is reported as no exit at all.
    let started = false;
    let startError = "";
    child.on("spawn", () => { started = true; });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-KEPT_ERROR_BYTES); });
    const end = (why) => { if (why === "timeout") timedOut = true; else stopped = true; void kill(child.pid); };
    const timer = setTimeout(() => end("timeout"), timeoutMs);
    timer.unref?.();
    const onAbort = () => end("stop");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (!started) startError = `could not start it: ${error?.message || error}`;
      else stderr = `${stderr}\n${error?.message || error}`.slice(-KEPT_ERROR_BYTES);
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!started) {
        resolve({ code: null, signal: null, timedOut: false, stopped, error: startError || "could not start it" });
        return;
      }
      const said = stderr.trim().split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "";
      resolve({ code, signal: killedBy, timedOut, stopped, error: said });
    });
  });
}
