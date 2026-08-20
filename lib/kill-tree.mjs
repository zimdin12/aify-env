// Ending a process AND everything it started.
//
// A launcher is a script; the agent is a child of it. Killing the launcher and leaving the agent is
// the leak this environment exists to prevent, wearing a different hat -- found by cleaning up after
// the orphan tests and discovering `sleep` processes with dead parents still running.
//
// THE DECISION IS SEPARATE FROM THE SYSCALL, so the dangerous part is testable without killing
// anything. Windows walks the tree with taskkill; POSIX uses process groups. Neither is expressible in
// the other's terms, which is why this is a plan rather than a clever one-liner.

import { spawnSync } from "node:child_process";

/**
 * What ending this pid's tree requires on a given platform.
 *
 * FAILS CLOSED on a pid that is not a positive integer, and that guard is not decoration: on POSIX
 * `kill(0, sig)` signals every process in the caller's group and a negative pid is a group wildcard.
 * A stray zero from a process that never started would be catastrophic exactly once.
 *
 * @returns {{command: string|null, args: string[], viaSignal: number[]|null}}
 */
export function killTreePlan(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { command: null, args: [], viaSignal: null };
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
export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill } = {}) {
  const plan = killTreePlan(pid, platform);
  if (plan.command) {
    try {
      run(plan.command, plan.args, { windowsHide: true, timeout: 10_000 });
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
