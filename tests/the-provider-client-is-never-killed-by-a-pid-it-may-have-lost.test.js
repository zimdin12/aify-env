// A run kills its client by pid only while that pid is provably still its client.
//
// The bug (comms-tech-lead, on cc3999c's silent file death): a client that has exited but whose output is still held
// open, by something it started, does not close. A stop or a timeout then ran `taskkill /T /F /PID <pid>` on it. Once
// node has seen the exit it has let go of the process, so Windows may already have given that pid to another process
// on this host: a live agent, aify-env itself, a terminal. That kill, and its /T, would land there.
//
// Until the exit is seen, node holds the process open and the pid cannot be reused, so a kill then is safe. A fake child
// process: when it exits, when it closes, and whether the kill is called are the subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { killTree, runChild } from "../lib/plugins/aify-dashboard/provider-child.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  return child;
}

/** A run of a fake child, with every pid the kill was asked for. */
function running(options = {}) {
  const child = fakeChild();
  const stop = new AbortController();
  const kills = [];
  const run = runChild({ nodePath: "C:/node.exe", script: "C:/client.mjs", cwd: "C:/w", env: {}, signal: stop.signal, killWaitMs: 50, start: () => child, kill: async (pid) => { kills.push(pid); }, ...options });
  child.emit("spawn");
  return { child, stop, kills, run };
}

test("a stop after the client exited, its output still open, kills no pid and says why", async () => {
  const r = running();
  r.child.emit("exit", 0, null);
  r.stop.abort();
  const result = await r.run;
  assert.deepEqual(r.kills, [], "no pid was killed once the client had exited");
  assert.equal(result.stopped, true);
  assert.match(result.unconfirmed, /had exited before it was killed, so its process tree was not killed by pid/);
});

test("a timeout after the client exited, its output still open, kills no pid and says why", async () => {
  const r = running({ timeoutMs: 20 });
  r.child.emit("exit", 0, null);
  // The run's own timer does not hold the process open (it is unref'd), so this test does.
  const held = setInterval(() => {}, 1000);
  const result = await r.run.finally(() => clearInterval(held));
  assert.deepEqual(r.kills, []);
  assert.equal(result.timedOut, true);
  assert.match(result.unconfirmed, /had exited before it was killed/);
});

test("where only the client itself can be killed, it is killed through its own handle, not by pid", async () => {
  // comms-tech-lead, on cc3999c: a ChildProcess's own kill goes through node's handle and does nothing once it has
  // exited; a kill by its pid does not know whether the pid is still it. The group signal is refused here, so the
  // fallback to the process itself is what runs.
  const signalled = [];
  const handled = [];
  const own = { kill: (name) => { handled.push(name); return true; }, exitCode: null, signalCode: null };
  const refuse = Object.assign(new Error("not permitted"), { code: "EPERM" });
  await killTree(4242, { platform: "linux", own, signalProcess: (target, name) => { signalled.push(target); if (target < 0) throw refuse; } }).catch(() => {});
  assert.deepEqual(signalled, [-4242], "only the group was signalled by number");
  assert.deepEqual(handled, ["SIGKILL"], "the client itself was killed through its handle");
});

test("control: a stop while the client still runs kills its pid", async () => {
  // The same fake and the same stop, with no exit first: the kill this file says is withheld is still made here.
  const r = running();
  r.stop.abort();
  r.child.emit("close", null, "SIGKILL");
  const result = await r.run;
  assert.deepEqual(r.kills, [4242]);
  assert.equal(result.unconfirmed, "");
});
