// Ending a process AND everything it started.
//
// A launcher is a script; the agent is a child of it. Killing the launcher and leaving the agent is
// the leak this environment exists to prevent, wearing a different hat -- found by cleaning up after
// the orphan tests and discovering `sleep` processes with dead parents still running.
//
// THE DECISION IS SEPARATE FROM THE SYSCALL, so the dangerous part is testable without killing
// anything. Windows walks the tree with taskkill; POSIX uses process groups. Neither is expressible in
// the other's terms, which is why this is a plan rather than a clever one-liner.

import { spawn } from "node:child_process";

//: How long one taskkill gets before it is abandoned.
//:
//: It was 10 seconds and it ran under `spawnSync`, which means it BLOCKED THE EVENT LOOP for up to
//: ten seconds per process. That is what defeated the shutdown deadline: a timer cannot fire while
//: the loop is blocked, so a four-agent teardown could sit for forty seconds with nothing printed,
//: and the operator -- reasonably -- killed the terminal instead of waiting.
//:
//: MEASURED 2026-08-28 on the operator's machine: `spawnSync('taskkill', ['/PID','999999','/T','/F'])`
//: against a pid that DOES NOT EXIST took 238-303 ms, five runs. That is the floor -- the call doing
//: nothing at all -- so a four-process shutdown paid at least 1.1 SECONDS of blocked loop before any
//: real work happened.
const KILL_TIMEOUT_MS = 10_000;

/**
 * What ending this pid's tree requires on a given platform.
 *
 * FAILS CLOSED on a pid that is not a positive integer, and that guard is not decoration: on POSIX
 * `kill(0, sig)` signals every process in the caller's group and a negative pid is a group wildcard.
 * A stray zero from a process that never started would be catastrophic exactly once.
 *
 * @returns {{command: string|null, args: string[], viaSignal: number[]|null}}
 */
/**
 * Is this pid one we must never tree-kill?
 *
 * Self and parent, because ending either takes this environment down and everything it hosts with it.
 * 0 and 1 because on POSIX 0 means "my whole process group" and 1 is init; neither is a mistake worth
 * making once. Injectable so a test can ask the question without being about the machine it runs on.
 */
export function isSelfProtected(pid, self = process.pid, parent = process.ppid) {
  return pid === self || pid === parent || pid === 0 || pid === 1;
}


export function killTreePlan(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { command: null, args: [], viaSignal: null };
  }
  // SELF-PROTECT, and it is the sibling repo's guard rather than a new idea. aify-comms carries the
  // same one on the same syscall, with the incident written beside it: "a STALE/RECYCLED DB pid could
  // taskkill the bridge, the operator's own shell, or a sibling agent's worker TREE on Windows". Every
  // pid reaching here comes from this environment's own registry, so in the normal case it is a child
  // and this changes nothing -- but the pid is a NUMBER, and on a host spawning agents continuously
  // Windows recycles numbers. `/T` on the wrong one takes a whole tree that was never ours.
  if (isSelfProtected(pid)) {
    return { command: null, args: [], viaSignal: null, refused: "self-protected" };
  }
  if (platform === "win32") {
    // /T is the tree, /F is forcible. One call, and it does not need us to know the shape.
    return { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"], viaSignal: null };
  }
  // The GROUP first -- that is what reaches the children -- then the process itself, for a child that
  // never became a group leader and whose group therefore is not ours to end.
  return { command: null, args: [], viaSignal: [-pid, pid] };
}

/**
 * Carry out the plan, best effort.
 *
 * Never throws: every caller is cleaning up, and a cleanup path that can fail loudly turns a leaked
 * process into a crashed environment. Returns whether anything was attempted, so a caller can report.
 */
export async function killTree(
  pid,
  { platform = process.platform, run = runToCompletion, kill = process.kill, timeoutMs = KILL_TIMEOUT_MS } = {},
) {
  const plan = killTreePlan(pid, platform);
  if (plan.command) {
    try {
      // AWAITED, NOT BLOCKED. `await` on a value is a no-op, so an injected synchronous runner still
      // works; what changes is that the default one no longer holds the loop while Windows works.
      await run(plan.command, plan.args, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  if (!plan.viaSignal) return false;
  let any = false;
  for (const target of plan.viaSignal) {
    try {
      kill(target);
      any = true;
    } catch {
      // A group that is not ours, or a process already gone. The next target may still land.
    }
  }
  return any;
}

/**
 * Run a command to completion WITHOUT holding the event loop, and give up after `timeoutMs`.
 *
 * The abandonment is the point. `spawnSync`'s own `timeout` also bounded the call, but it bounded it
 * while nothing else could run -- so the bound was invisible: no timer fired, no line printed, and
 * from outside it was indistinguishable from a hang. Here the wait is a promise, so whatever armed a
 * deadline keeps its turn of the loop and can act on it.
 *
 * NEVER REJECTS ON THE PROCESS FAILING. Every caller is cleaning up, and taskkill exits non-zero for
 * ordinary reasons -- the pid was already gone, most often. `killTree` reports whether it ATTEMPTED,
 * which is all a cleanup path can honestly claim.
 */
export function runToCompletion(command, args, { timeoutMs = KILL_TIMEOUT_MS, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { windowsHide: true, stdio: "ignore" });
    } catch {
      // No such command. Nothing to wait for and nothing to report beyond the attempt.
      resolve(false);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // The killer needed killing. Best effort: if this throws there is nothing further to try, and
      // the caller is already being told the attempt did not complete.
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    // NOT unref'd, and it was at first. An unref'd timer is not a wait: if nothing else holds the
    // loop, node drains and this promise NEVER SETTLES, so an `await` on it hangs -- which is the
    // failure being fixed, reintroduced by the fix. The suite said so immediately, with four tests
    // reporting `cancelledByParent: Promise resolution is still pending but the event loop has
    // already resolved`.
    //
    // Holding the loop costs at most `timeoutMs`, a bound this function already accepts, and every
    // path through `finish` clears it. In real use the spawned child holds the loop anyway.
    child.once("error", () => finish(false));
    child.once("close", () => finish(true));
  });
}
