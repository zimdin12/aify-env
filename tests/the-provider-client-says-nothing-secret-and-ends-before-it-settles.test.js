// What the code provider's client last said is kept with no part of the dashboard key in it, however the text was
// cut; and a run that killed the client settles only once the kill has finished, or has been given up on and said so.
// A fake child process: what it says, when it closes and how the kill goes are the subject.
//
// The bugs (review of 8e7a638):
// - P2-K1: stderr was cut to its last 4096 characters BEFORE the key was replaced, so a key split by the cut was no
//   longer the whole key, was not replaced, and its other half was shown in a doctor row.
// - P2-S1: the kill was started and forgotten, and the run settled when the client closed, so a stop "completed"
//   while the tree kill it had started was still running.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { KEPT_ERROR_CHARS, RAW_ERROR_CHARS, runChild } from "../lib/plugins/aify-dashboard/provider-child.mjs";

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

/** A stop whose kill completes only when `finish` is called, and the order things happened in. */
function stoppedWith(kill, killWaitMs) {
  const child = fakeChild();
  const stop = new AbortController();
  const events = [];
  const running = runChild({ nodePath: "C:/node.exe", script: "C:/client.mjs", cwd: "C:/w", env: {}, signal: stop.signal, start: () => child, kill: () => { events.push("kill-called"); return kill(events); }, killWaitMs })
    .then((result) => { events.push("run-settled"); return result; });
  child.emit("spawn");
  stop.abort();
  child.emit("close", null, "SIGKILL");
  events.push("child-closed");
  return { running, events };
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
