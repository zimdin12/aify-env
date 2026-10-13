// A terminal's output is posted at most once per COALESCE_MS (lib/plugins/aify-comms/output-sender.mjs).
//
// Measured 2026-10-13: nine working agents posted ~34 times a second, one POST per pty chunk, and held the service at
// 20-35% of a core. Driven with a fake clock and fake timers, and a service that answers at once, which is the case
// that never coalesced before.

import assert from "node:assert/strict";
import test from "node:test";

import { COALESCE_MS, FLUSH_AT_CHARS, createOutputSender } from "../lib/plugins/aify-comms/output-sender.mjs";

function rig() {
  const clock = { ms: 10_000 };
  const timers = [];
  const posts = [];
  const sender = createOutputSender({
    post: async (terminalId, body) => { posts.push({ terminalId, output: body.output }); },
    now: () => clock.ms,
    setTimer: (fn, ms) => { const timer = { fn, at: clock.ms + ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.live = false; },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms) => {
    clock.ms += ms;
    for (const timer of timers.filter((t) => t.live && t.at <= clock.ms)) { timer.live = false; timer.fn(); }
    await settle();
  };
  return { sender, posts, clock, settle, advance };
}

test("A BURST INSIDE ONE WINDOW IS ONE POST, with every byte in the order it was produced", async () => {
  const { sender, posts, settle, advance } = rig();
  sender.send("t1", "a");
  await settle();
  for (const chunk of ["b", "c", "d"]) sender.send("t1", chunk);
  await settle();
  assert.equal(posts.length, 1, "the chunks inside the window were posted one by one");
  await advance(COALESCE_MS);
  assert.deepEqual(posts.map((p) => p.output), ["a", "bcd"]);
});

test("THE FIRST CHUNK OF A QUIET STREAM GOES AT ONCE, so a typed key echoes without waiting", async () => {
  const { sender, posts, clock, settle } = rig();
  sender.send("t1", "a");
  await settle();
  clock.ms += COALESCE_MS * 10;
  sender.send("t1", "x");
  await settle();
  assert.deepEqual(posts.map((p) => p.output), ["a", "x"]);
});

test("AN EXIT FLUSHES AT ONCE: drained does not wait out the window", async () => {
  const { sender, posts, settle } = rig();
  sender.send("t1", "a");
  await settle();
  sender.send("t1", "tail");
  assert.equal(await sender.drained("t1", 500), true);
  assert.deepEqual(posts.map((p) => p.output), ["a", "tail"], "the exit marker would have overtaken the tail");
});

test("A DETACH FLUSHES EVERY TERMINAL AT ONCE", async () => {
  const { sender, posts, settle } = rig();
  for (const id of ["t1", "t2"]) sender.send(id, `${id}-first`);
  await settle();
  for (const id of ["t1", "t2"]) sender.send(id, `${id}-tail`);
  assert.equal(await sender.flushAll(500), true);
  assert.deepEqual(posts.map((p) => p.output).sort(), ["t1-first", "t1-tail", "t2-first", "t2-tail"]);
});

test("A BURST PAST THE CAP GOES AT ONCE rather than at the end of its window", async () => {
  const { sender, posts, settle } = rig();
  sender.send("t1", "a");
  await settle();
  sender.send("t1", "x".repeat(FLUSH_AT_CHARS));
  await settle();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].output.length, FLUSH_AT_CHARS);
});
