// "stopped X" is said only once X's process is gone.
//
// THE DEFECT (v0.7.1 review, E8). NOTICES said "stopped alpha" whenever `runner.stop` resolved. But
// `stop` releases the registry entry first and does not look at what the kill achieved, so a process
// that survived its kill left the list AND was reported stopped: the one place the operator could have
// learned it was still running said the opposite. Both tiers now check the pid after the kill, and a
// survivor is reported as a failed stop with its pid.

import assert from "node:assert/strict";
import test from "node:test";

import { stopAndVerify } from "../lib/verified-stop.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { startDaemonView } from "../lib/daemon-view.mjs";
import { performClientAction } from "../lib/client-actions.mjs";
import { actionOutcomeNotice } from "../lib/action-outcome.mjs";

const ALPHA = { id: "p1", pid: 4242, label: "alpha" };

/** A runner holding alpha, whose stop resolves whatever happened to the process. */
function runner() {
  const stopped = [];
  return {
    stopped,
    list: () => [{ ...ALPHA }],
    stop: async (id) => { stopped.push(id); },
  };
}

const survives = () => true;
const dies = () => false;

test("a process still alive after the kill is not stopped, and the answer names its pid", async () => {
  const r = runner();
  const result = await stopAndVerify(r, "p1", { isAlive: survives, settleMs: 50, stepMs: 10 });
  assert.deepEqual(r.stopped, ["p1"], "positive control: the stop was never asked for");
  assert.equal(result.stopped, false);
  assert.match(result.problem, /4242.*still running/);
});

test("a process that dies within the settle time is stopped", async () => {
  let checks = 0;
  const result = await stopAndVerify(runner(), "p1", { isAlive: () => ++checks < 3, settleMs: 500, stepMs: 5 });
  assert.equal(result.stopped, true);
});

test("an id this environment does not hold is stopped already, as the route has always said", async () => {
  const r = runner();
  assert.equal((await stopAndVerify(r, "never", { isAlive: survives })).stopped, true);
  assert.deepEqual(r.stopped, ["never"], "the idempotent stop was not still asked for");
});

test("a pid that cannot be checked is not claimed stopped", async () => {
  const unreadable = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  const result = await stopAndVerify(runner(), "p1", { isAlive: unreadable, settleMs: 20, stepMs: 5 });
  assert.equal(result.stopped, false);
});

test("the daemon's view reports a survivor as a failed stop", async () => {
  const calls = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r",
    stdout: { isTTY: true, columns: 120, rows: 40 }, stdin: { isTTY: true },
    runner: runner(),
    isAlive: survives,
    start: async (options) => { calls.push(options); return { stop: () => {} }; },
  });
  const outcome = await calls[0].onAction({ action: "stop", process: ALPHA });
  assert.equal(outcome.ok, false, `a surviving process was reported ${JSON.stringify(outcome)}`);
  assert.match(actionOutcomeNotice({ action: "stop", process: ALPHA }, outcome), /stop of alpha failed: .*4242/);
});

test("CONTROL: the daemon's view still reports a stop that took", async () => {
  const calls = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r",
    stdout: { isTTY: true, columns: 120, rows: 40 }, stdin: { isTTY: true },
    runner: runner(),
    isAlive: dies,
    start: async (options) => { calls.push(options); return { stop: () => {} }; },
  });
  assert.deepEqual(await calls[0].onAction({ action: "stop", process: ALPHA }), { ok: true, problem: "" });
});

test("DELETE /processes/:id answers 500 with the reason when the process survived", async () => {
  const res = await handleRequest({ method: "DELETE", path: "/processes/p1" }, { runner: runner(), isAlive: survives });
  assert.equal(res.status, 500);
  assert.equal(res.body.stopped, false);
  assert.match(res.body.problem, /4242/);
});

test("aify-env tui reports the daemon's reason for a stop that did not take", async () => {
  const fetchImpl = async () => ({
    ok: false, status: 500,
    json: async () => ({ stopped: false, problem: "pid 4242 is still running after the kill" }),
  });
  const outcome = await performClientAction({ action: "stop", process: ALPHA }, { endpoint: "http://x", fetchImpl });
  assert.equal(actionOutcomeNotice({ action: "stop", process: ALPHA }, outcome),
    "stop of alpha failed: pid 4242 is still running after the kill");
});
