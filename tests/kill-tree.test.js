#!/usr/bin/env node
// Killing a process kills its CHILDREN too, or the requirement is not met.
//
// Found by cleaning up after my own orphan tests: two `sleep 120` processes were still running with
// dead parents. The reaper had killed the recorded pid -- the launcher -- and its grandchild carried
// on. A launcher is a bash script; the agent it starts is a child of it. Killing the wrapper and
// leaving the agent is the leak wearing a different hat.
//
// PLATFORM-SPLIT, injected. Windows has taskkill /T, which walks the tree itself. POSIX has process
// groups. Neither is expressible in the other's terms, so the DECISION is tested here and the syscall
// is the caller's.

import assert from "node:assert/strict";
import { test } from "node:test";

import { isSelfProtected, killTreePlan } from "../lib/kill-tree.mjs";

test("windows kills the whole tree, forcibly, in one call", () => {
  const plan = killTreePlan(4242, "win32");
  assert.equal(plan.command, "taskkill");
  assert.deepEqual(plan.args, ["/PID", "4242", "/T", "/F"]);
  assert.equal(plan.viaSignal, null, "windows has no signal path here");
});

test("posix targets the process GROUP first, then the process", () => {
  // The group is what catches the children. The direct pid is the fallback for a child that never
  // became a group leader, where killing the group would either fail or reach too far.
  const plan = killTreePlan(4242, "linux");
  assert.equal(plan.command, null, "posix needs no external command");
  assert.deepEqual(plan.viaSignal, [-4242, 4242]);
});

test("darwin behaves like linux", () => {
  assert.deepEqual(killTreePlan(7, "darwin").viaSignal, [-7, 7]);
});

test("a pid that is not a positive integer plans nothing", () => {
  // Fails closed. A negative or zero pid handed to kill() is a process-GROUP wildcard on POSIX, and
  // `kill(0)` reaches every process the user owns. That is not a mistake to make once.
  for (const bad of [0, -1, null, undefined, NaN, "4242", 1.5]) {
    const plan = killTreePlan(bad, "linux");
    assert.equal(plan.command, null);
    assert.equal(plan.viaSignal, null, `pid ${String(bad)} produced a kill plan`);
  }
});

test("the same guard holds on windows", () => {
  assert.equal(killTreePlan(0, "win32").command, null);
  assert.equal(killTreePlan(-1, "win32").command, null);
});

// killTree itself, with both syscalls injected so nothing real is ever signalled.

import { killTree, runToCompletion } from "../lib/kill-tree.mjs";

test("windows runs taskkill and reports that it tried", async () => {
  const calls = [];
  const ok = await killTree(4242, { platform: "win32", run: (c, a) => { calls.push([c, a]); return {}; } });
  assert.equal(ok, true);
  assert.deepEqual(calls, [["taskkill", ["/PID", "4242", "/T", "/F"]]]);
});

test("posix signals the group and then the process", async () => {
  const sent = [];
  const ok = await killTree(4242, { platform: "linux", kill: (t) => sent.push(t) });
  assert.equal(ok, true);
  assert.deepEqual(sent, [-4242, 4242]);
});

test("a group that is not ours does not stop the direct kill", async () => {
  // The common POSIX case: the child never became a group leader, so -pid fails and pid must still be
  // tried. Reporting failure after the first throw would leave the process running.
  const sent = [];
  const ok = await killTree(7, { platform: "linux", kill: (t) => { if (t < 0) throw new Error("ESRCH"); sent.push(t); } });
  assert.equal(ok, true);
  assert.deepEqual(sent, [7]);
});

test("nothing is signalled for a pid that failed the guard", async () => {
  let touched = false;
  assert.equal(await killTree(0, { platform: "linux", kill: () => { touched = true; } }), false);
  assert.equal(touched, false, "a zero pid reached kill(), which signals the whole process group");
});

test("a throwing runner is reported, not propagated", async () => {
  assert.equal(await killTree(1, { platform: "win32", run: () => { throw new Error("no taskkill"); } }), false);
});

test("a runner that REJECTS is reported, not propagated", async () => {
  // New shape, and it arrives with the async runner: before this the only way to fail was to throw
  // synchronously. A rejected promise escaping here would take down a teardown, which is the one
  // path that must not be able to fail loudly.
  assert.equal(
    await killTree(1, { platform: "win32", run: () => Promise.reject(new Error("taskkill died")) }),
    false,
  );
});

// ---------------------------------------------------------------------------------------------
// SELF-PROTECTION, added 2026-08-26. Not a new idea: aify-comms carries the same guard on the same
// syscall, with the incident written beside it -- "a STALE/RECYCLED DB pid could taskkill the bridge,
// the operator's own shell, or a sibling agent's worker TREE on Windows". aify-env had none.
//
// Every pid reaching killTree comes from this environment's own registry, so in the normal case it is
// a child and this changes nothing. But a pid is a NUMBER, and on a host spawning agents continuously
// Windows recycles numbers: `/T` on the wrong one takes a whole tree that was never ours.
// ---------------------------------------------------------------------------------------------

test("this environment's own pid is never tree-killed", () => {
  assert.equal(isSelfProtected(process.pid), true);
  const plan = killTreePlan(process.pid, "win32");
  assert.equal(plan.command, null, "taskkill /T was planned against this very process");
  assert.equal(plan.refused, "self-protected");
});

test("the parent is protected too, because ending it ends this environment", () => {
  assert.equal(isSelfProtected(process.ppid), true);
  assert.equal(killTreePlan(process.ppid, "linux").viaSignal, null);
});

test("0 and 1 are refused on every platform", () => {
  // 0 is "my whole process group" on POSIX and 1 is init. Neither is a mistake worth making once.
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(killTreePlan(0, platform).command, null, platform);
    assert.equal(killTreePlan(1, platform).command, null, platform);
    assert.equal(killTreePlan(1, platform).viaSignal, null, platform);
  }
});

test("an ordinary child pid is still planned normally", () => {
  // The control. A guard that refused everything would pass every test above and stop the environment
  // cleaning up after itself -- a leak instead of a cross-kill.
  assert.equal(isSelfProtected(999999, 4242, 4243), false);
  assert.equal(killTreePlan(999999, "win32").command, "taskkill");
  assert.deepEqual(killTreePlan(999999, "linux").viaSignal, [-999999, 999999]);
});

test("killTree carries out nothing for a protected pid", async () => {
  // The plan is the decision; this proves the decision is honoured rather than recomputed.
  const calls = [];
  const attempted = await killTree(process.pid, {
    platform: "win32",
    run: (...args) => { calls.push(args); },
    kill: (...args) => { calls.push(args); },
  });
  assert.equal(attempted, false);
  assert.deepEqual(calls, [], "a syscall was issued against a self-protected pid");
});


// ---------------------------------------------------------------------------------------------
// THE RUNNER, and the property the whole change is for.
//
// `killTree` used `spawnSync`, which BLOCKS THE EVENT LOOP for the duration of the taskkill -- up to
// its own 10s timeout, per process. That is what defeated the shutdown deadline: the timer was armed
// and could not run, so a four-agent teardown could sit for tens of seconds printing nothing, and the
// operator killed the terminal instead of waiting. They reported it three times.
//
// MEASURED 2026-08-28: `spawnSync('taskkill', ['/PID','999999','/T','/F'])` against a pid that does
// not exist took 238, 289, 303, 294 and 255 ms. That is the FLOOR -- the call killing nothing -- so
// four processes cost at least 1.1 seconds of blocked loop before any real work began.

test("the kill does not hold the event loop", async () => {
  // THE REGRESSION TEST FOR THE WHOLE FIX, written so it could not pass under the old code: with a
  // blocking runner the timer below cannot fire before the await returns, so `ticked` reads false.
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 1);
  await killTree(4242, {
    platform: "win32",
    // A runner that takes a while, as a real taskkill does.
    run: () => new Promise((resolve) => setTimeout(resolve, 25)),
  });
  clearTimeout(timer);
  assert.ok(ticked, "a timer armed before the kill had not fired after it: the loop was held, and a "
    + "shutdown deadline armed the same way could not fire either");
});

test("a command that cannot be spawned is reported, not thrown", async () => {
  const result = await runToCompletion("taskkill", [], {
    spawnFn: () => { throw new Error("ENOENT"); },
  });
  assert.equal(result, false);
});

test("a kill that never finishes is abandoned, and the child is killed", async () => {
  // The bound has to be real: an unbounded wait would move the hang rather than remove it.
  let killed = false;
  const child = {
    once: () => {},
    kill: () => { killed = true; },
  };
  const result = await runToCompletion("taskkill", [], { timeoutMs: 5, spawnFn: () => child });
  assert.equal(result, false, "a wait that timed out must not report success");
  assert.ok(killed, "the abandoned taskkill was left running");
});

test("a kill that finishes resolves as attempted", async () => {
  const handlers = {};
  const child = { once: (event, fn) => { handlers[event] = fn; }, kill: () => {} };
  const pending = runToCompletion("taskkill", [], { timeoutMs: 1000, spawnFn: () => child });
  handlers.close();
  assert.equal(await pending, true);
});

test("a spawn error resolves rather than rejecting", async () => {
  // Every caller is cleaning up. A cleanup path that can fail loudly turns a leaked process into a
  // crashed environment -- this module's stated rule, and the async runner is a new way to break it.
  const handlers = {};
  const child = { once: (event, fn) => { handlers[event] = fn; }, kill: () => {} };
  const pending = runToCompletion("taskkill", [], { timeoutMs: 1000, spawnFn: () => child });
  handlers.error(new Error("spawn failed"));
  assert.equal(await pending, false);
});

test("the first outcome wins: a close after a timeout does not resolve twice", async () => {
  const handlers = {};
  const child = { once: (event, fn) => { handlers[event] = fn; }, kill: () => {} };
  const pending = runToCompletion("taskkill", [], { timeoutMs: 5, spawnFn: () => child });
  assert.equal(await pending, false);
  // Late, as a real child's close would be after being killed. Resolving again is a no-op, but a
  // handler that assumed it had not run yet would clear a timer that no longer exists.
  handlers.close();
  assert.equal(await pending, false);
});
