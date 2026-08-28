// Stopping a process that is already gone touches nothing.
//
// OBSERVED ON THE OPERATOR'S MACHINE, 2026-08-27. The PC slept, both managed ptys died, and Ctrl-C
// left the daemon printing `[aify-env] SIGINT: stopping 2 managed process(es)` for HOURS -- with both
// pids already gone, verified from outside the process.
//
// WHY IT HUNG. `stop()` ran `child.kill()` unconditionally. Against a DEAD pid on Windows that forks
// node-pty's console-list helper, which ATTACHES TO THE CONSOLE of that pid; on a console left wedged
// by a sleep/resume the attach does not return. It blocks the event loop synchronously, so the
// `Promise.allSettled` in `createShutdown` never settles -- and `allSettled` guards against a
// rejection, not against a call that never returns. A JS timeout would not have helped either: with
// the loop blocked, nothing else runs. Not making the call is the only fix that works, and it is
// also the correct one, because there is nothing there to kill.
//
// THE ANALYSIS WAS ALREADY IN THE FILE, for a different caller. `#release`'s docstring works out in
// full why the REAPER must not reach `child.kill()` with a dead pid -- Windows may have recycled the
// number onto another agent -- and the reaper was taken off this path for exactly that reason.
// Nobody considered that SHUTDOWN also arrives here with dead pids, which is what a sleep produces.
//
// WHAT THIS FILE DOES NOT DO, stated rather than implied: it does not drive `stop()` against a real
// wedged ConPTY handle. Reproducing that needs a live pty and a suspended console, which is the
// thing the fix exists to avoid touching. The ordering is asserted on the source instead, and the
// liveness predicate is asserted behaviourally.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultIsAlive } from "../lib/reaper.mjs";
import { Runner } from "../lib/runner.mjs";

/** A pid that cannot be alive: far above any real one, and never spawned here. */
const DEAD_PID = 0x7ffffff0;

/**
 * `stop()`'s body with `//` comments stripped.
 *
 * The first version of the ordering assertions compared indexOf positions on the RAW source and
 * failed: the explanatory comment inside `stop()` mentions `child.kill()` while explaining why it
 * must not be reached, so the match landed on the prose forbidding the call rather than on the call.
 * An ordering check has to look at code.
 */
function stopCode() {
  const src = readFileSync(new URL("../lib/runner.mjs", import.meta.url), "utf8");
  // Sliced by LINES, not by a regex over the whole file. The regex version pinned the signature
  // (`async stop(id) {`) and stopped matching when the method gained an options parameter; the
  // obvious repair, `stop\([^)]*\)`, is worse -- the parameter's default is `() => {}`, so the
  // character class stops at ITS closing paren and the match fails a second time, silently looking
  // like the same fault. The method's opening line and its closing brace are both unambiguous.
  const lines = src.split("\n");
  const open = lines.findIndex((line) => line.startsWith("  async stop("));
  const close = open < 0 ? -1 : lines.indexOf("  }", open);
  assert.ok(open >= 0 && close > open, "positive control: stop() was not found in the source");
  const match = [lines.slice(open, close + 1).join("\n")];
  const code = match[0]
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(code.includes("child.kill()"), "positive control: the kill vanished from stop()");
  assert.ok(code.includes("killTree(pid)"), "positive control: the tree kill vanished from stop()");
  return code;
}

test("stop() checks liveness BEFORE either kill", () => {
  const code = stopCode();
  assert.match(
    code, /if \(!defaultIsAlive\(pid\)\) return;/,
    "stop() kills unconditionally again; against a dead ConPTY pid that can hang shutdown for hours",
  );
  const guard = code.indexOf("defaultIsAlive(pid)");
  assert.ok(guard >= 0);
  assert.ok(guard < code.indexOf("child.kill()"), "the check must precede child.kill()");
  assert.ok(guard < code.indexOf("killTree(pid)"), "the check must precede killTree()");
});

test("each blocking call is ANNOUNCED before it is made", () => {
  // THE MUTATION THAT SURVIVED, and how it survived. `shutdown.test.js` asserts that the teardown
  // prints a phase before the call -- but it drives a FAKE runner that calls `phase()` itself, so it
  // proves the shutdown prints what it is told and nothing about this method's ordering. Moving the
  // announcement after `child.kill()` in the real `stop()` left that suite green.
  //
  // The ordering is the entire value. `child.kill()` is node-pty's ConPTY kill and can block the
  // event loop; when it does, nothing after it ever runs. A phase announced afterwards is announced
  // never, for exactly the case it exists to report.
  //
  // Asserted on the source for the same reason the rest of this file is: reproducing a wedged ConPTY
  // needs a live pty and a suspended console, which is the thing the fix exists to avoid touching.
  const code = stopCode();
  const announced = code.indexOf('phase("console-kill")');
  const called = code.indexOf("child.kill()");
  assert.ok(announced >= 0, "stop() no longer announces the console kill; a wedge there reports nothing");
  assert.ok(
    announced < called,
    "the console kill is announced AFTER it is made. That call can block the event loop, so the "
      + "line after it never runs -- the announcement has to already be on screen",
  );
  const tree = code.indexOf('phase("tree-kill")');
  assert.ok(tree > called, "the tree-kill phase must follow the console kill it comes after");
});

test("the predicate that gates it can say BOTH answers", () => {
  // ANTI-VACUITY, and the failure mode that would matter most. A predicate stuck on false would
  // satisfy the ordering test above and leave every managed process running on shutdown -- the
  // orphan window the whole shutdown rule exists to close. One stuck on true restores the hang.
  assert.equal(defaultIsAlive(process.pid), true, "this very process reads as dead");
  assert.equal(defaultIsAlive(DEAD_PID), false, "an unspawned pid reads as alive");
});

test("stopping an id the runner never had is a no-op, not a throw", async () => {
  // `createShutdown` maps stop() over every owned entry. A throw on an unknown id would land in
  // allSettled and be swallowed, but the same call is made by the reaper on a schedule.
  const runner = new Runner({});
  await runner.stop("no-such-id");
  assert.deepEqual(runner.list(), []);
});

test("the shutdown WAITS for the stops, but not for ever", () => {
  // WHAT THIS USED TO SAY, and why it changed. It asserted a bare `await Promise.allSettled(...)`
  // on the grounds that removing the wait would cost "the guarantee that processes are gone before
  // the daemon exits, which is the operator's stated rule". The wait is still here and the rule is
  // still the goal. What changed is the recognition that an UNBOUNDED wait never delivered it.
  //
  // The operator hit the hang twice. Ctrl+C printed three `stopping pN` lines and then nothing, and
  // both times they killed the terminal -- which leaves the processes running AND the owned record
  // stale, the worst of both. So the real choice was never "wait or abandon". It was:
  //
  //   hang for ever  -> operator kills the terminal -> processes alive, record stale, nobody reaps
  //   exit on a deadline -> processes alive, record KEPT, the next instance reaps them
  //
  // The second honours the rule by a different route, which is why the timeout path deliberately
  // does NOT clear the owned file. `shutdown.test.js` drives that behaviour; this asserts the shape
  // survives, because the shape is what the incident turned on.
  const src = readFileSync(new URL("../lib/shutdown.mjs", import.meta.url), "utf8");
  assert.match(src, /await Promise\.race\(\[Promise\.allSettled\(/, "shutdown no longer waits for the stops");
  assert.match(src, /STOP_DEADLINE_MS/, "the wait is unbounded again, which is the hang");
  assert.match(
    src, /allSettled, not all/,
    "the reason the wait exists is no longer written down beside it",
  );
  assert.match(
    src, /NOT AT ALL when some did not confirm/,
    "the timeout path may not clear the owned record: that record is the only way a later instance "
      + "can find a process this one failed to stop",
  );
});
