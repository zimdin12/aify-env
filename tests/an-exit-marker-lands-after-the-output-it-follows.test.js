#!/usr/bin/env node
// The last thing a dead worker said must appear BEFORE the notice that it died.
//
// REPORTED BY REVIEW 2026-09-08 as an ordering defect, and it is the screen an operator opens a dead
// console to read. Output goes through the ordered sender, which queues and coalesces; the exit
// marker carries a STATUS and an EXIT CODE, which `sender.send` cannot express, so it went out
// through `api.terminalOutput` directly -- the instant the process ended, overtaking whatever the
// sender still held. The console then showed:
//
//   FIRST
//   [terminal exited]
//   FINAL-TAIL
//
// The tail was never lost, which is why this is an ordering finding rather than a loss one: a drain
// already in flight holds its own reference and finishes even after `forget`.
//
// DRIVEN THROUGH `runOneControl`, the public entry point, with a fake runner and a fake API whose
// POSTs can be held open. Testing the private listener directly would prove the listener and leave
// the wiring -- and this project has an incident on file for a green helper suite beside a call site
// that never reached it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createOutputSender } from "../lib/plugins/aify-comms/output-sender.mjs";
import { runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";

/** An API whose terminal POSTs record their order and can be made slow. */
function recordingApi({ holdMs = 0 } = {}) {
  const posts = [];
  let inFlight = 0;
  return {
    posts,
    async terminalOutput(terminalId, body) {
      const output = String(body?.output ?? "");
      // AN EMPTY OUTPUT IS `terminalStanding` ASKING, not a chunk. It has to answer "ended" or the
      // adoption branch -- the only path that attaches a listener without resolving a launcher --
      // refuses and this fixture measures nothing.
      if (!output) return { terminal: { status: "ended" } };
      // WHAT WAS STILL ON THE WIRE WHEN THIS ONE WAS ISSUED. Recording only the ORDER OF CALLS is
      // not enough: the service assigns `output_seq` in ARRIVAL order, so two requests in flight at
      // once have no order at all -- which is the whole reason an ordered sender exists. A mutant
      // that answered "drained" while a POST was still in flight passed an order-of-calls assertion
      // and would still let the marker race the tail on the wire.
      const record = { terminalId, output, status: body?.status ?? "", exitCode: body?.exitCode,
                       exitSignal: body?.exitSignal, at: posts.length, inFlightAtIssue: inFlight };
      posts.push(record);
      inFlight += 1;
      try {
        if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
      } finally {
        inFlight -= 1;
      }
      return { ok: true };
    },
    async launch() {
      // A REAL EXECUTABLE. The launcher is resolved BEFORE the adoption branch is reached, and a
      // name that does not resolve on this host refuses the control before any listener attaches --
      // which is a fixture failure that looks exactly like the feature not working.
      return { launch: { argv: [process.execPath, "-e", "0"], cwd: "/workspace", agentId: "a1" } };
    },
    async terminalControl() { return { ok: true }; },
  };
}

/** A runner that hands back the two callbacks so a test can drive output and exit itself. */
function fakeProcesses() {
  const seen = {};
  return {
    seen,
    subscribe(handle, onChunk, onExit) {
      seen.handle = handle;
      seen.onChunk = onChunk;
      seen.onExit = onExit;
      return () => {};
    },
    list: () => [],
  };
}

const TERMINAL = "term-exit-order";
const PREVIOUS = "term-previous";
const HANDLE = "proc-1";

/**
 * Attach the streaming listener through the ADOPTION branch of a real `start` control.
 *
 * ADOPTION IS THE CHEAPEST REAL PATH TO THE LISTENER. It re-points a process that is already running
 * at a new terminal, so it reaches `carryTerminal` before any launcher is resolved -- which is what
 * lets this drive the PUBLIC entry point rather than a private function. The alternative was to
 * export the listener and test it alone, and this project has an incident on file for a green helper
 * suite sitting beside a call site that never reached it.
 */
async function attach(api, sender) {
  const processes = fakeProcesses();
  const book = new Map([[PREVIOUS, HANDLE]]);
  const handles = {
    handleFor: (id) => book.get(id) || "",
    forget: (id) => book.delete(id),
    remember: (id, value) => book.set(id, value),
    otherTerminalsFor: () => [PREVIOUS],
    carriedBy: () => "",
    noteOutput: () => {},
  };
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: TERMINAL, action: "start" },
    api, processes, handles, sender, log: () => {}, withinRoots: () => true,
    resolveCandidates: () => [process.execPath],
    buildSpec: () => ({ service: "aify-comms", fileText: "", command: process.execPath, args: ["-e", "0"] }),
  });
  return { processes, handles, result };
}

test("THE EXIT MARKER WAITS FOR THE OUTPUT ALREADY QUEUED", async () => {
  // The first POST is held open, so the second chunk is QUEUED in the sender when the process exits
  // -- which is the window the marker used to jump.
  const api = recordingApi({ holdMs: 40 });
  const sender = createOutputSender({ post: (id, body) => api.terminalOutput(id, body), status: "attached" });
  const { processes } = await attach(api, sender);
  assert.equal(typeof processes.seen.onChunk, "function",
    "the control did not attach a listener, so this test is measuring nothing");

  processes.seen.onChunk("FIRST");
  processes.seen.onChunk("FINAL-TAIL");
  processes.seen.onExit(0, null);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const outputs = api.posts.map((post) => post.output);
  const exitAt = outputs.findIndex((text) => text.includes("[terminal exited]"));
  const tailAt = outputs.findIndex((text) => text.includes("FINAL-TAIL"));
  assert.ok(exitAt >= 0, `no exit marker was posted: ${JSON.stringify(outputs)}`);
  assert.ok(tailAt >= 0, `the final tail was never posted: ${JSON.stringify(outputs)}`);
  assert.ok(tailAt < exitAt,
    `the exit marker overtook the output it follows: ${JSON.stringify(outputs)}`);
  // AND NOTHING WAS STILL ON THE WIRE WHEN IT WENT. Two requests in flight at once reach the
  // service in whatever order the network gives them, and the service numbers them on arrival --
  // so "issued second" is not "arrives second" unless the first has finished.
  assert.equal(api.posts[exitAt].inFlightAtIssue, 0,
    `the exit marker was issued while ${api.posts[exitAt].inFlightAtIssue} output POST(s) were `
    + "still in flight, so their arrival order at the service is not decided");
});

test("AND IT STILL CARRIES THE STATUS AND THE EXIT CODE", async () => {
  // POSITIVE CONTROL for the assertion above: an ordering test passes trivially if the marker stops
  // being the marker. The fields are the reason it cannot go through the ordered sender at all.
  const api = recordingApi();
  const sender = createOutputSender({ post: (id, body) => api.terminalOutput(id, body), status: "attached" });
  const { processes } = await attach(api, sender);
  processes.seen.onExit(3, "SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 200));
  const marker = api.posts.find((post) => post.output.includes("[terminal exited]"));
  assert.ok(marker, "no exit marker was posted");
  assert.equal(marker.status, "stopped");
  assert.equal(marker.exitCode, 3);
  assert.equal(marker.exitSignal, "SIGTERM");
});

test("AND THE SENDER RELEASES THE DEAD TERMINAL", async () => {
  // `sender.forget` MOVED when the wait went in -- it used to run the instant the process exited,
  // and now runs after the queue has drained, so that the wait has something to wait for. Moving a
  // release is how one gets dropped: nothing here asserted it happened, and a mutant that deleted
  // it outright survived the first battery. Each abandoned stream holds up to 256 KB.
  const api = recordingApi();
  const sender = createOutputSender({ post: (id, body) => api.terminalOutput(id, body), status: "attached" });
  const { processes } = await attach(api, sender);
  processes.seen.onChunk("SOMETHING");
  processes.seen.onExit(0, null);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sender.pendingFor(TERMINAL), null,
    "the sender is still tracking a terminal whose process has exited");
});

test("A SERVICE THAT STOPS ANSWERING DOES NOT HOLD THE MARKER FOR EVER", async () => {
  // NEGATIVE CONTROL for the wait. A bound that never expires is a console that never says the
  // worker died, which is worse than saying it in the wrong order.
  const api = recordingApi({ holdMs: 5000 });
  const sender = createOutputSender({ post: (id, body) => api.terminalOutput(id, body), status: "attached" });
  const { processes } = await attach(api, sender);
  processes.seen.onChunk("STUCK");
  processes.seen.onExit(0, null);

  const started = Date.now();
  const deadline = started + 4000;
  while (Date.now() < deadline) {
    if (api.posts.some((post) => post.output.includes("[terminal exited]"))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const waited = Date.now() - started;
  assert.ok(api.posts.some((post) => post.output.includes("[terminal exited]")),
    `the exit marker never arrived while a POST was stuck; waited ${waited}ms`);
});
