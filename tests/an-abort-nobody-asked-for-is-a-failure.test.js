// An AbortError this follower did not cause is a failed connection, so the pane reconnects.
//
// THE DEFECT (v0.7.1 review, W13). `#fail` ignored every AbortError, on the reasoning that an abort
// is what `stop()` does. But the fetch layer raises the same error for a connection it abandoned
// itself, and then the status stayed `connecting` or `streaming` for good -- and a pane is reopened
// only from FAILED, so it never reconnected. Only an abort this follower asked for, by stopping, is
// not a failure; that case is tested beside the follower's other tests in output-follower.test.js.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { FAILED, OutputFollower } from "../lib/output-follower.mjs";

const LF = String.fromCharCode(10);
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

test("an AbortError from the request, with no stop, leaves the follower FAILED", async () => {
  const f = new OutputFollower({ endpoint: "http://x", id: "p", fetchImpl: async () => { throw abortError(); } });
  await f.start();
  assert.equal(f.status, FAILED);
});

test("an AbortError in the middle of the stream, with no stop, leaves the follower FAILED", async () => {
  const encoder = new TextEncoder();
  const f = new OutputFollower({
    endpoint: "http://x",
    id: "p",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      body: (async function* body() {
        yield encoder.encode(`data: ${JSON.stringify("working")}${LF}${LF}`);
        throw abortError();
      })(),
    }),
  });
  await f.start();
  assert.equal(f.status, FAILED, `the stream was abandoned and the follower says ${f.status}`);
});

test("the pane reconnects after an abort nobody asked for", async () => {
  let nowMs = 1_000;
  let asked = 0;
  const s = new ConsoleSession({
    endpoint: "http://x",
    now: () => nowMs,
    fetchImpl: async () => {
      asked += 1;
      throw abortError();
    },
  });
  s.noteViewport({ columns: 160 });
  s.syncProcesses([{ id: "a" }]);
  s.handleInput("p");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked, 1, "positive control: the pane never asked for the stream");
  nowMs += 5_000;
  s.syncProcesses([{ id: "a" }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(asked, 2, "the pane never asked again after the connection was abandoned");
});
