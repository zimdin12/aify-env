// A console stream that failed is opened again, after a pause, while its row is still there.
//
// THE DEFECT (v0.7 scan, F7). `syncProcesses` returned early whenever the selected id equalled the
// watched one, whatever the follower's state. A FAILED follower -- a daemon restart, a dropped
// connection, "the stream ended without an exit" -- therefore stayed failed for good: the pane read
// `unavailable: ...` until the operator knew to move off the row and back.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";

/** A session showing `a`'s pane, on a clock the test moves, counting followers opened. */
function watching(initialStatus) {
  let nowMs = 1_000;
  const opened = [];
  const s = new ConsoleSession({
    now: () => nowMs,
    makeFollower: (id) => {
      const follower = { id, status: initialStatus, start() {}, stop() { this.stopped = true; }, lines: () => [] };
      opened.push(follower);
      return follower;
    },
  });
  s.noteViewport({ columns: 160 });
  s.syncProcesses([{ id: "a" }]);
  s.handleInput("p");
  assert.equal(opened.length, 1, "the fixture opened no stream");
  return { s, opened, advance: (ms) => { nowMs += ms; } };
}

test("a FAILED stream is reopened once the pause has passed", () => {
  const { s, opened, advance } = watching("failed");
  advance(5_000);
  s.syncProcesses([{ id: "a" }]);
  assert.equal(opened.length, 2, "a failed stream was never retried");
  assert.equal(opened[0].stopped, true, "the failed follower was not closed before the new one opened");
});

test("it is not hammered: no retry inside the pause", () => {
  const { s, opened, advance } = watching("failed");
  for (let i = 0; i < 10; i += 1) s.syncProcesses([{ id: "a" }]);
  advance(100);
  s.syncProcesses([{ id: "a" }]);
  assert.equal(opened.length, 1);
});

test("CONTROL: an EXITED or GONE stream is final and is not reopened", () => {
  for (const status of ["exited", "gone", "streaming"]) {
    const { s, opened, advance } = watching(status);
    advance(60_000);
    s.syncProcesses([{ id: "a" }]);
    assert.equal(opened.length, 1, `a ${status} stream was reopened`);
  }
});
