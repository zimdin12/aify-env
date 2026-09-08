#!/usr/bin/env node
// Terminal output reaches the service in the order the process produced it.
//
// EXTERNAL REVIEW, Round 8 M3. Every pty chunk fired its own `void api.terminalOutput(...)`, with no
// ordering and no bound. The service assigns `output_seq` in ARRIVAL order, and its own comment says
// what follows: concurrent POSTs reorder against seq and the console is scrambled. Two chunks in
// flight is enough to do it, and a working agent produces far more than two.
//
// THE TEST HAS TO MAKE THE SECOND POST FINISH FIRST, or it proves nothing. A fake that resolves
// immediately serialises by accident -- every POST completes before the next chunk arrives -- and the
// old code would have passed. So the first POST is held open while later chunks are sent, which is
// exactly what a slow network does and what the operator's host does under load.
//
// AND BOUNDED, because ordering alone would trade a scrambled console for unbounded memory: a service
// that stops answering must cost one buffer per terminal, not a growing list of pending POSTs.

import assert from "node:assert/strict";
import test from "node:test";

import { createOutputSender, MAX_PENDING_CHARS } from "../lib/plugins/aify-comms/output-sender.mjs";

/** A `post` whose calls can be released individually, so a later one can be made to finish first. */
function controllablePost() {
  const calls = [];
  const gates = [];
  const post = (terminalId, body) => {
    calls.push({ terminalId, body });
    return new Promise((resolve, reject) => { gates.push({ resolve, reject }); });
  };
  return { post, calls, gates };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("THE CHUNKS ARRIVE IN ORDER even when the first POST is slow", async () => {
  const { post, calls, gates } = controllablePost();
  const sender = createOutputSender({ post, status: "attached" });

  sender.send("t1", "one");
  await settle();
  assert.equal(calls.length, 1, "the first chunk was not sent immediately");

  // Three more arrive while the first is still in flight -- the case the old code got wrong.
  sender.send("t1", "two");
  sender.send("t1", "three");
  sender.send("t1", "four");
  await settle();
  assert.equal(calls.length, 1,
    "a second POST went out while the first was in flight. The service assigns output_seq on "
    + "ARRIVAL, so two in flight is a console that can scramble.");

  gates[0].resolve({});
  await settle();
  await settle();
  assert.equal(calls.length, 2, "the queued output was not sent once the first POST settled");
  assert.equal(calls[0].body.output, "one");
  assert.equal(calls[1].body.output, "twothreefour",
    "the waiting chunks were not sent in the order they were produced");
});

test("a failed POST does not stop the next chunk", async () => {
  // This sits under a pty listener with nobody above it to hand an error to. Dropping the stream
  // because the service blinked would turn a transient outage into a dead console.
  const { post, calls, gates } = controllablePost();
  const logs = [];
  const sender = createOutputSender({ post, log: (m) => logs.push(String(m)) });

  sender.send("t1", "first");
  await settle();
  gates[0].reject(new Error("connection reset"));
  await settle();
  await settle();

  sender.send("t1", "second");
  await settle();
  assert.equal(calls.length, 2, "a failed POST stopped the stream");
  assert.ok(logs.some((l) => /not delivered/.test(l)), `the failure was silent: ${JSON.stringify(logs)}`);
});

test("TWO TERMINALS DO NOT BLOCK EACH OTHER", async () => {
  // Ordering is a per-STREAM property. Serialising globally would let one slow console stall every
  // other agent on the host, which is a worse failure than the one being fixed.
  const { post, calls, gates } = controllablePost();
  const sender = createOutputSender({ post });

  sender.send("t1", "a");
  await settle();
  sender.send("t2", "b");
  await settle();
  assert.equal(calls.length, 2,
    "the second terminal waited for the first terminal's POST. Two consoles have no ordering "
    + "relationship, and making one wait for the other is a stall, not a fix.");
  gates.forEach((g) => g.resolve({}));
});

test("PENDING OUTPUT IS BOUNDED, and the OLDEST is what goes", async () => {
  // Ordering without a bound trades a scrambled console for unbounded memory: a service that stops
  // answering would hold everything a busy agent ever printed.
  //
  // The oldest goes because a console is read from the BOTTOM. Keeping the head and dropping the
  // tail would preserve exactly the part nobody is looking at -- and every classifier in this system
  // reads the recent screen.
  const { post, calls, gates } = controllablePost();
  const logs = [];
  const sender = createOutputSender({ post, log: (m) => logs.push(String(m)) });

  sender.send("t1", "first");           // goes out immediately, holds the stream open
  await settle();
  sender.send("t1", "X".repeat(MAX_PENDING_CHARS));
  sender.send("t1", "THE-NEWEST-BYTES");
  const pending = sender.pendingFor("t1");
  assert.ok(pending.pending <= MAX_PENDING_CHARS,
    `pending grew to ${pending.pending}, past the ${MAX_PENDING_CHARS} bound`);

  gates[0].resolve({});
  await settle();
  await settle();
  assert.ok(calls[1].body.output.endsWith("THE-NEWEST-BYTES"),
    "the newest output was dropped instead of the oldest; the visible screen is the part that matters");
  assert.ok(logs.some((l) => /dropped \d+ character/.test(l)),
    `a console with a hole in it must SAY so: ${JSON.stringify(logs)}`);
});

test("a forgotten terminal stops holding memory", async () => {
  const { post, gates } = controllablePost();
  const sender = createOutputSender({ post });
  sender.send("t1", "hello");
  await settle();
  gates[0].resolve({});
  await settle();
  sender.forget("t1");
  assert.equal(sender.pendingFor("t1"), null, "a dead terminal is still tracked");
});

test("A BURST OF CHUNKS BECOMES TWO POSTS, however big the burst is", async () => {
  // THE RATIO IS THE POINT, and this file tested every other property of the sender without it.
  // "One in flight per terminal, the rest coalesced" bounds aify-env's traffic against a service
  // that is SINGLE-WORKER BY DESIGN: the post count follows how fast the service answers, not how
  // fast the agent talks. A sender that queued one job per chunk would pass every other test here.
  const { post, calls, gates } = controllablePost();
  const sender = createOutputSender({ post, status: "attached" });

  const BURST = 500;
  sender.send("t1", "first");
  await settle();
  assert.equal(calls.length, 1, "the first chunk did not go out on its own");

  for (let i = 0; i < BURST; i += 1) sender.send("t1", `c${i} `);
  await settle();
  assert.equal(calls.length, 1,
    `${BURST} chunks arriving during one in-flight POST produced ${calls.length} POSTs; two in `
    + "flight is enough to scramble the console, because the service assigns seq on ARRIVAL");

  gates[0].resolve({});
  await settle();
  await settle();

  // ONE more POST, carrying the whole burst. Not 500, and not one per chunk.
  assert.equal(calls.length, 2,
    `${BURST} coalesced chunks became ${calls.length - 1} POST(s) instead of exactly one`);
  const carried = calls[1].body.output;
  assert.ok(carried.startsWith("c0 "), "the burst did not start where it was produced");
  assert.ok(carried.endsWith(`c${BURST - 1} `), "the burst lost its tail");
  assert.equal(carried.length, [...Array(BURST).keys()].reduce((n, i) => n + `c${i} `.length, 0),
    "the coalesced body is not the concatenation of every chunk in the burst");
});

test("AND A SERVICE THAT ANSWERS INSTANTLY DOES NOT COALESCE", async () => {
  // NEGATIVE CONTROL for the ratio. A sender that ALWAYS batched would satisfy the test above while
  // adding latency to every chunk on an idle console. The count has to follow the service's speed.
  const calls = [];
  const sender = createOutputSender({
    post: (terminalId, body) => { calls.push(body.output); return Promise.resolve({}); },
    status: "attached",
  });

  for (let i = 0; i < 5; i += 1) {
    sender.send("t1", `c${i}`);
    await settle();
    await settle();
  }
  assert.equal(calls.length, 5,
    `five chunks against an instant service became ${calls.length} POST(s); coalescing is supposed `
    + "to be what a SLOW service costs, not a delay every console pays");
});

test("A THROWING log() IS CONTAINED — a caller's logger cannot strand output or reject unhandled", async () => {
  // THE MODULE SAYS THIS AND NOTHING TESTED IT. `output-sender.mjs` keeps TWO drain mechanisms -- the
  // `while (state.pending)` loop and a post-settle re-drain hook -- and its own comment records that
  // either alone passes every other test here, measured. It keeps the hook as a net under one case
  // the loop cannot cover: an exception escaping the `while`, whose only source today is `log()`,
  // which is a CALLER'S function this module has no business assuming about.
  //
  // A claim in a comment is not a guarantee. This is that case, driven: `log()` throws on the drop
  // notice, and the output queued behind it still has to arrive. Without the hook the `while` exits
  // through the exception with `pending` unsent, and the console silently stops.
  //
  // WHAT THIS TEST IS, AND WHAT IT IS NOT. It is a LOGGER-CONTAINMENT test. An earlier version of
  // this comment claimed deleting the re-drain hook would turn it red, which is false: review
  // deleted only the hook and all eight tests passed, and the module's own comment already says
  // either mechanism alone covers every scenario here. The hook's necessity is not what this pins,
  // and inventing machinery to make that claim true would be building a test around a sentence
  // rather than around a behaviour.
  //
  // What it DOES pin, and what the mutation shows: reverting the drop notice to a direct `log()`
  // makes exactly this test fail with an unhandledRejection while the other seven pass.
  const { post, calls, gates } = controllablePost();
  let threw = 0;
  const sender = createOutputSender({
    post,
    log: () => { threw += 1; throw new Error("a caller's logger blew up"); },
  });

  // Overflow the buffer so the NEXT drain reports dropped characters -- that report is the only call
  // to `log()` on the success path, so it is how a caller's throw gets inside the loop.
  sender.send("t1", "x");                       // starts the first POST, which we hold open
  await settle();
  sender.send("t1", "y".repeat(MAX_PENDING_CHARS + 10));
  await settle();

  gates[0].resolve({ ok: true });                // the drain resumes, hits the drop notice, throws
  await settle();
  await settle();

  assert.equal(threw, 1, "the drop notice must have been attempted, or this tests nothing");
  assert.ok(calls.length >= 2,
    `the output queued behind the throwing log() was never posted: ${calls.length} call(s)`);
  const delivered = calls.slice(1).map((call) => call.body.output).join("");
  assert.ok(delivered.includes("y"), "the pending chunk was dropped when the logger threw");
});
