// Stopping a process, and saying so only once it is gone.
//
// THE DEFECT (v0.7.1 review, E8). `runner.stop` resolves once it has released the registry entry and
// sent its kills; it does not look at what the kills achieved. So "stopped alpha" was said about a
// process that could still be running -- and, released from the list, it no longer showed anywhere.
//
// The pid is read BEFORE the stop, because the stop releases the entry that holds it, and checked
// after, for a bounded while: taskkill and a signal both take a moment to land.

import { defaultIsAlive } from "./reaper.mjs";

//: How long a killed process is given to be gone before the stop is reported as not having taken.
const SETTLE_MS = 1000;
const STEP_MS = 50;

/**
 * Stop `id` through `runner`, then check its pid.
 *
 * NEVER THROWS FOR A SURVIVOR: a process that outlived its kill is an answer, not an error. A pid
 * that cannot be checked is NOT claimed stopped -- a guard that passes when its evidence is missing
 * is decoration.
 *
 * @returns {Promise<{stopped: boolean, problem: string}>}
 */
export async function stopAndVerify(runner, id, { isAlive = defaultIsAlive, settleMs = SETTLE_MS, stepMs = STEP_MS } = {}) {
  const pid = runner.list?.().find((entry) => entry?.id === id)?.pid;
  await runner.stop(id);
  // NOTHING HELD UNDER THIS ID: stopping it is already true, which is the route's idempotence.
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: true, problem: "" };
  const deadline = Date.now() + Math.max(0, settleMs);
  for (;;) {
    let alive;
    try {
      alive = isAlive(pid);
    } catch (error) {
      if (Date.now() >= deadline) {
        return { stopped: false, problem: `pid ${pid} could not be checked after the kill: ${error?.code || error?.message || error}` };
      }
      alive = true;
    }
    if (!alive) return { stopped: true, problem: "" };
    if (Date.now() >= deadline) return { stopped: false, problem: `pid ${pid} is still running after the kill` };
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
