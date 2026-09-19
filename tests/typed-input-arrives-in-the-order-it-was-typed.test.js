#!/usr/bin/env node
// Keystrokes must reach the process in the order they were typed, however slow the daemon is.
//
// THE OPERATOR'S REPORT, 2026-09-19: "when i write and it catches up then text is scrambled (letters
// in wrong place)", in Herdr panes, under load from subagents, and never on a quiet machine. In a
// pane the agent runs behind `aify-env attach`, and that client sent every stdin chunk as its own
// fire-and-forget POST. Independent HTTP requests have no ordering guarantee, so two in flight at
// once can be handled in either order. On an idle host each finished before the next key was
// pressed; the order was luck, and load removed the luck.
//
// THE CONTROL IS THE OLD BEHAVIOUR, in the same run: the same keys, the same delays, sent the way
// the client used to send them. It must scramble, or this test proves nothing -- a test that passes
// against both the bug and the fix measures the harness, not the code.
//
// THE DELAYS ARE ADVERSARIAL BUT REAL IN KIND: a busy daemon answers a later call sooner. Descending
// delays are the cheapest way to make that deterministic, so this fails on order rather than on luck.

import assert from "node:assert/strict";
import { test } from "node:test";

import { InputSender } from "../lib/input-sender.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A daemon that answers later calls sooner, recording what it was handed, in arrival order. */
function slowDaemon(delaysMs) {
  const arrived = [];
  let call = 0;
  return {
    arrived,
    async send(data) {
      const delay = delaysMs[Math.min(call, delaysMs.length - 1)];
      call += 1;
      await wait(delay);
      arrived.push(data);
    },
  };
}

test("typed keys arrive in order even when each send is slower than the next keystroke", async () => {
  const daemon = slowDaemon([40, 30, 20, 10, 1]);
  const sender = new InputSender(daemon.send);
  for (const key of "hello") sender.write(key);
  await sender.drained();
  assert.equal(daemon.arrived.join(""), "hello");
});

test("CONTROL: sending each key as its own unordered request DOES scramble, same delays", async () => {
  const daemon = slowDaemon([40, 30, 20, 10, 1]);
  // The old client, exactly: one fire-and-forget call per chunk, nothing awaited.
  for (const key of "hello") void daemon.send(key);
  await wait(80);
  assert.notEqual(daemon.arrived.join(""), "hello",
    "the control did not reproduce the defect, so the test above proves nothing");
});

test("keys typed while a request is out are coalesced into the next one, in order", async () => {
  const daemon = slowDaemon([20, 1]);
  const sender = new InputSender(daemon.send);
  sender.write("a");          // goes out alone
  sender.write("b");          // queued behind it
  sender.write("c");          // joins b
  await sender.drained();
  assert.deepEqual(daemon.arrived, ["a", "bc"]);
  assert.equal(sender.sent, 2, "fast typing must cost one request per round trip, not one per key");
});

test("a paste of many bytes is one request, and its bytes keep their order", async () => {
  const daemon = slowDaemon([1]);
  const sender = new InputSender(daemon.send);
  const paste = "x".repeat(4096) + "END";
  sender.write(paste);
  await sender.drained();
  assert.deepEqual(daemon.arrived, [paste]);
});

test("a failed send is dropped, never retried, and the next keys still arrive in order", async () => {
  // A retry would land those bytes AFTER whatever was typed next, which is the defect this fixes.
  const arrived = [];
  let call = 0;
  const sender = new InputSender(async (data) => {
    call += 1;
    if (call === 1) throw new Error("connection reset");
    arrived.push(data);
  });
  sender.write("a");
  await sender.drained();
  sender.write("b");
  sender.write("c");
  await sender.drained();
  // Order is the claim, not the request count: whether b and c share a request depends on whether
  // the first was still out when c was typed, which is timing. What must never vary is the order.
  assert.equal(arrived.join(""), "bc");
  assert.equal(sender.failed, 1);
});

test("writing nothing sends nothing", async () => {
  let calls = 0;
  const sender = new InputSender(async () => { calls += 1; });
  sender.write("");
  await sender.drained();
  assert.equal(calls, 0);
  assert.equal(sender.busy, false);
});

test("drained() resolves for a sender that was never written to", async () => {
  await new InputSender(async () => {}).drained();
});
