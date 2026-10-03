// What the code provider's client last said is kept with no part of the dashboard key in it, however the text was
// cut; and a run that killed the client settles only once the kill has finished, or has been given up on and said so.
// A fake child process: what it says, when it closes and how the kill goes are the subject.
//
// The bugs (review of 8e7a638):
// - P2-K1: stderr was cut to its last 4096 characters BEFORE the key was replaced, so a key split by the cut was no
//   longer the whole key, was not replaced, and its other half was shown in a doctor row.
// - P2-S1: the kill was started and forgotten, and the run settled when the client closed, so a stop "completed"
//   while the tree kill it had started was still running.
// The bugs (review of 17f6f48), in how that wait was owned:
// - S1-R1: only the close attached a handler to the kill, so a kill that failed before the client closed went unhandled.
// - S1-R2: the bound started at the close, so a client the kill could not end, which never closes, never settled.
// - S1-R3: the tree kill resolved from taskkill's callback whatever it carried, so a failed taskkill read as done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { KEPT_ERROR_CHARS, RAW_ERROR_CHARS, killTree, runChild } from "../lib/plugins/aify-dashboard/provider-child.mjs";

const KEY = "0123456789abcdef".repeat(4);
const MARK = "<the dashboard key>";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  return child;
}

/** Run the fake child: it says each of `chunks`, then exits 1. */
async function saying(chunks) {
  const child = fakeChild();
  const running = runChild({ nodePath: "C:/node.exe", script: "C:/client.mjs", cwd: "C:/w", env: {}, key: KEY, start: () => child, kill: async () => {} });
  child.emit("spawn");
  for (const chunk of chunks) child.stderr.emit("data", chunk);
  child.emit("close", 1, null);
  return running;
}

/** No run of eight or more of the key's characters, anywhere: a fragment that long is no accident. */
function leaksNoKey(text) {
  for (let at = 0; at + 8 <= KEY.length; at += 1) assert.ok(!text.includes(KEY.slice(at, at + 8)), `a fragment of the key at ${at}: ${text.slice(0, 120)}`);
}

test("a key the kept tail would cut in two is replaced before anything is cut", async () => {
  // The review's own shape: the key, then enough after it that keeping the last part cuts the key.
  const result = await saying([`${KEY}${"x".repeat(KEPT_ERROR_CHARS - 32)}`]);
  leaksNoKey(result.error);
  // And a key that is cut by nothing is still replaced, with the mark saying so.
  const whole = await saying([`${KEY} is not accepted\n`]);
  assert.equal(whole.error, `${MARK} is not accepted`);
});

test("a key split across two writes is still the key", async () => {
  const result = await saying([`refused: ${KEY.slice(0, 20)}`, `${KEY.slice(20)} was not accepted\n`]);
  assert.equal(result.error, `refused: ${MARK} was not accepted`);
});

test("past the raw cap, the line the cap cut into is dropped whole, so no part of a key survives at its front", async () => {
  // Only the last line of the last KEPT_ERROR_CHARS is shown, and the raw cap keeps far more than that, so a key the
  // cap cuts into reaches what is shown only when the whole keys after it shrink the text as they are replaced. That
  // takes a long key: one of 512 characters, cut 6 into, then 127 more of it and nothing after, on one line.
  const longKey = Array.from({ length: 32 }, (_, i) => `${i}`.padStart(2, "0") + "k".repeat(14)).join("");
  const child = fakeChild();
  const running = runChild({ nodePath: "C:/node.exe", script: "C:/client.mjs", cwd: "C:/w", env: {}, key: longKey, start: () => child, kill: async () => {} });
  child.emit("spawn");
  const said = `${longKey.repeat(128)}!!!!!!`;
  assert.ok(said.slice(-RAW_ERROR_CHARS).startsWith(longKey.slice(6)), "the fixture: the raw tail starts inside the first key");
  child.stderr.emit("data", said);
  child.emit("close", 1, null);
  const result = await running;
  for (let at = 0; at + 16 <= longKey.length; at += 16) assert.ok(!result.error.includes(longKey.slice(at, at + 16)), `a part of the key at ${at}`);
  assert.equal(result.error, "", "the only line was the one the cap cut into");
});

/**
 * A stopped run with the kill `kill` makes, and the order things happened in. The client closes at once, after
 * `closeAfterMs`, or, with `closeAfterMs: null`, never: a child the kill could not end.
 */
function stoppedWith(kill, killWaitMs, { closeAfterMs = 0 } = {}) {
  const child = fakeChild();
  const stop = new AbortController();
  const events = [];
  const state = { settled: false };
  const running = runChild({ nodePath: "C:/node.exe", script: "C:/client.mjs", cwd: "C:/w", env: {}, signal: stop.signal, start: () => child, kill: () => { events.push("kill-called"); return kill(events); }, killWaitMs })
    .then((result) => { state.settled = true; events.push("run-settled"); return result; });
  child.emit("spawn");
  stop.abort();
  const close = () => { child.emit("close", null, "SIGKILL"); events.push("child-closed"); };
  if (closeAfterMs === 0) close();
  else if (closeAfterMs !== null) setTimeout(close, closeAfterMs);
  return { running, events, state, close };
}

/** Every promise rejection nobody was handling when it happened, while `body` runs. */
async function unhandledDuring(body) {
  const seen = [];
  const note = (reason) => seen.push(String(reason?.message ?? reason));
  process.on("unhandledRejection", note);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off("unhandledRejection", note);
  }
  return seen;
}

test("a stopped run settles only after the tree kill it started has finished", async () => {
  const s = stoppedWith((events) => new Promise((resolve) => setTimeout(() => { events.push("kill-finished"); resolve(); }, 50)), 5_000);
  const result = await s.running;
  assert.equal(result.stopped, true);
  assert.deepEqual(s.events, ["kill-called", "child-closed", "kill-finished", "run-settled"]);
  assert.equal(result.error, "", "a kill that finished leaves nothing to say");
});

test("a kill that never finishes is given up on in bounded time, and the run says the tree was not confirmed ended", { timeout: 10_000 }, async () => {
  const s = stoppedWith(() => new Promise(() => {}), 100);
  const started = Date.now();
  const result = await s.running;
  assert.ok(Date.now() - started < 2_000, "bounded");
  assert.equal(result.stopped, true);
  assert.match(result.error, /the client's process tree was not confirmed ended within 0\.1 s/);
});

test("a kill that fails is said, not swallowed, whether it fails later or at once", async () => {
  const later = stoppedWith(() => Promise.reject(new Error("taskkill exited 128")), 5_000);
  assert.match((await later.running).error, /the client's process tree was not confirmed ended: taskkill exited 128/);
  // At once: thrown where it is started, inside the timer or the stop, where an exception would escape the run.
  const atOnce = stoppedWith(() => { throw new Error("no taskkill here"); }, 5_000);
  assert.match((await atOnce.running).error, /the client's process tree was not confirmed ended: no taskkill here/);
});

test("a kill that fails before the client closes is said, and its failure never goes unhandled", async () => {
  // The bug (review of 17f6f48, S1-R1): the failed kill was stored, and only the close handler attached anything to
  // it, so a kill that failed before the client closed was an unhandled rejection: one that crashes the daemon.
  for (const [how, kill] of [["rejected", () => Promise.reject(new Error("taskkill exited 128"))], ["thrown", () => { throw new Error("no taskkill here"); }]]) {
    let result;
    const seen = await unhandledDuring(async () => { result = await stoppedWith(kill, 5_000, { closeAfterMs: 30 }).running; });
    assert.deepEqual(seen, [], `${how}: nothing unhandled`);
    assert.match(result.error, /the client's process tree was not confirmed ended: (taskkill exited 128|no taskkill here)/, how);
  }
});

test("a stopped client that never closes still settles within the bound, saying what is not confirmed", { timeout: 10_000 }, async () => {
  // The bug (review of 17f6f48, S1-R2): the bound started only when the client closed, so a client the kill could
  // not end left the plugin's stop waiting for ever.
  const unanswered = stoppedWith(() => new Promise(() => {}), 100, { closeAfterMs: null });
  const first = await Promise.race([unanswered.running, new Promise((resolve) => setTimeout(() => resolve("pending"), 1_000))]);
  assert.notEqual(first, "pending", "settled with no close");
  assert.equal(first.stopped, true);
  assert.match(first.error, /the client's process tree was not confirmed ended within 0\.1 s/);
  // And a kill that answered with the client still not closed: the kill's word is not the client's end.
  const answered = stoppedWith(async () => {}, 100, { closeAfterMs: null });
  const second = await Promise.race([answered.running, new Promise((resolve) => setTimeout(() => resolve("pending"), 1_000))]);
  assert.notEqual(second, "pending", "settled with no close");
  assert.match(second.error, /the client did not close within 0\.1 s of being killed/);
  assert.doesNotMatch(second.error, /not confirmed ended/, "the kill did answer");
});

test("a client that closes soon after its kill answered is waited for, not reported missing", async () => {
  // The control for the bound above: the kill answering first is the ordinary order on Windows, where the client's
  // close follows taskkill's exit.
  const s = stoppedWith(async () => {}, 5_000, { closeAfterMs: 30 });
  const result = await s.running;
  assert.equal(result.error, "");
  assert.deepEqual(s.events, ["kill-called", "child-closed", "run-settled"]);
});

test("a taskkill that fails rejects, with its reason, and one that succeeds resolves", async () => {
  // The bug (review of 17f6f48, S1-R3): the tree kill resolved from taskkill's callback whatever it carried, so a
  // refused or failed taskkill reached the run as a tree confirmed ended.
  const failing = (file, args, options, done) => done(Object.assign(new Error("taskkill exited 128"), { code: 128 }), "", "ERROR: refused");
  await assert.rejects(killTree(4242, { platform: "win32", taskkill: "C:\\Windows\\System32\\taskkill.exe", run: failing }), /taskkill exited 128/);
  await killTree(4242, { platform: "win32", taskkill: "C:\\Windows\\System32\\taskkill.exe", run: (file, args, options, done) => done(null, "", "") });
});

test("a signal that could not be sent rejects; a process already gone does not", async () => {
  // The same defect where there is no taskkill: every failure to signal was read as "already gone".
  const refusing = () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); };
  await assert.rejects(killTree(4242, { platform: "linux", signalProcess: refusing }), /EPERM/);
  const gone = () => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); };
  await killTree(4242, { platform: "linux", signalProcess: gone });
  const sent = [];
  await killTree(4242, { platform: "linux", signalProcess: (target) => { if (target < 0) gone(); sent.push(target); } });
  assert.deepEqual(sent, [4242], "no group: the process itself");
});

test("a run past its time and then stopped kills its tree once", async () => {
  // A timeout and a stop are two reasons to end one tree: killed twice, the second taskkill aims at a pid that may
  // already belong to another process.
  const child = fakeChild();
  const stop = new AbortController();
  let kills = 0;
  const running = runChild({ nodePath: "C:/node.exe", script: "C:/client.mjs", cwd: "C:/w", env: {}, signal: stop.signal, timeoutMs: 10, start: () => child, kill: async () => { kills += 1; } });
  child.emit("spawn");
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop.abort();
  child.emit("close", null, "SIGKILL");
  const result = await running;
  assert.equal(kills, 1);
  assert.equal(result.timedOut, true);
});
