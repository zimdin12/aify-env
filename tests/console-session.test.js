// Which process is being watched, and the stream that watches it.
//
// A FOLLOWER IS A CONNECTION. Most of these tests are about NOT churning one: the selection moving is
// the only thing that may open or close a stream, and a refresh returning the same list must leave it
// entirely alone. Getting that wrong on a busy host opens and abandons a connection per keypress.

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { STREAMING } from "../lib/output-follower.mjs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

/** A follower that records its own lifecycle instead of opening anything. */
function recordingFollower(log) {
  return (id) => {
    log.push(`start:${id}`);
    return {
      id,
      status: STREAMING,
      exit: null,
      start: async () => {},
      stop: () => log.push(`stop:${id}`),
      lines: () => [`output of ${id}`],
    };
  };
}

const procs = (...ids) => ids.map((id) => ({ id, label: `label-${id}` }));

const session = (log) => new ConsoleSession({ endpoint: "http://x", makeFollower: recordingFollower(log) });

// -- selection and follower lifecycle -------------------------------------------------------------

test("the first process list opens a follower for the selection", () => {
  const log = [];
  session(log).syncProcesses(procs("a", "b"));
  assert.deepEqual(log, ["start:a"]);
});

test("AN UNCHANGED LIST DOES NOT CHURN THE STREAM", () => {
  // The refresh runs every couple of seconds. Re-opening on each one would abandon a connection per
  // tick and lose the buffer with it.
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("a", "b"));
  assert.deepEqual(log, ["start:a"]);
});

test("a list that changes AROUND the selection still does not churn it", () => {
  // Another process appearing or leaving is the normal case. What matters is the process UNDER the
  // selection, not the shape of the list.
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("a", "b", "c"));
  s.syncProcesses(procs("a", "c"));
  assert.deepEqual(log, ["start:a"]);
});

test("moving the selection CLOSES the old stream before opening the new one", () => {
  // Leaving it open keeps a connection and a growing buffer alive for a process nobody is watching.
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a", "b"));
  s.handleInput(DOWN);
  assert.deepEqual(log, ["start:a", "stop:a", "start:b"]);
});

test("THE PROCESS UNDER THE SELECTION CHANGING re-points the follower", () => {
  // The index stayed at 0 and the process there is a different one. Keying on the index rather than
  // the id would leave the pane showing output from a process that is no longer there.
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("z", "b"));
  assert.deepEqual(log, ["start:a", "stop:a", "start:z"]);
});

test("an empty list closes the stream and selects nothing", () => {
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a"));
  s.syncProcesses([]);
  assert.deepEqual(log, ["start:a", "stop:a"]);
  assert.equal(s.selected, null);
  assert.equal(s.pane(), null);
});

test("the selection CLAMPS when the list shrinks under it, rather than resetting to the top", () => {
  // Resetting would send an operator back to the first row every time a process finished, which on a
  // busy host makes the view unusable.
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a", "b", "c"));
  s.handleInput(DOWN);
  s.handleInput(DOWN);
  assert.equal(s.selected.id, "c");
  s.syncProcesses(procs("a", "b"));
  assert.equal(s.selected.id, "b", "selection did not clamp to the new last row");
});

test("junk in place of a process list is survived, not thrown on", () => {
  const log = [];
  const s = session(log);
  for (const bad of [null, undefined, "processes", 42, {}]) {
    assert.doesNotThrow(() => s.syncProcesses(bad), `${String(bad)} threw`);
    assert.equal(s.selected, null);
  }
});

// -- input ---------------------------------------------------------------------------------------

test("moving up and down walks the list", () => {
  const s = session([]);
  s.syncProcesses(procs("a", "b", "c"));
  s.handleInput(DOWN);
  assert.equal(s.selected.id, "b");
  s.handleInput(UP);
  assert.equal(s.selected.id, "a");
});

test("quit and interrupt are reported SEPARATELY, not decided in here", () => {
  // A library that calls process.exit takes the decision away from the binary that owns the
  // lifecycle, which is the separation bin/aify-env-tui.mjs already keeps deliberately.
  //
  // And they are two facts, not one. The daemon renders this same view in the terminal it was
  // started from, where Ctrl+C means "stop the environment and take its managed processes with
  // it" -- while `q` there must mean nothing at all. Collapsing them here would force one answer
  // on both callers, and the expensive direction is a stray `q` reaping a live fleet.
  const s = session([]);
  s.syncProcesses(procs("a"));
  const ctrlC = s.handleInput(String.fromCharCode(3));
  assert.equal(ctrlC.interrupt, true);
  assert.equal(ctrlC.quit, false);
  const q = s.handleInput("q");
  assert.equal(q.quit, true);
  assert.equal(q.interrupt, false);
});

test("input meant for the process comes back as toPty, not written from in here", () => {
  const s = session([]);
  s.syncProcesses(procs("a"));
  s.handleInput(String.fromCharCode(13)); // attach
  const { toPty } = s.handleInput("ls -la");
  assert.equal(toPty, "ls -la");
});

// -- the pane ------------------------------------------------------------------------------------

test("the pane carries what the composer needs, including the follower's own status", () => {
  const s = session([]);
  s.syncProcesses(procs("a"));
  const pane = s.pane();
  assert.equal(pane.id, "a");
  assert.equal(pane.label, "label-a");
  assert.equal(pane.status, STREAMING);
  assert.deepEqual(pane.lines({ height: 5, width: 40 }), ["output of a"]);
});

test("the pane says whether input is going to the process", () => {
  // An operator typing into a pane needs to know whether the keys land there or move the selection.
  const s = session([]);
  s.syncProcesses(procs("a"));
  assert.equal(s.pane().attached, false);
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.pane().attached, true);
});

test("stop() closes the stream and is safe twice", () => {
  const log = [];
  const s = session(log);
  s.syncProcesses(procs("a"));
  s.stop();
  s.stop();
  assert.deepEqual(log, ["start:a", "stop:a"]);
});

test("a follower that throws on stop does not take the session down", () => {
  const s = new ConsoleSession({
    endpoint: "http://x",
    makeFollower: () => ({ status: STREAMING, exit: null, start: async () => {},
      stop: () => { throw new Error("already gone"); }, lines: () => [] }),
  });
  s.syncProcesses(procs("a"));
  assert.doesNotThrow(() => s.stop());
});

test("a follower whose start REJECTS does not reject into the render loop", async () => {
  // The usual reason to have this open is watching for something to come back, so a failed connection
  // must not take the screen down.
  const s = new ConsoleSession({
    endpoint: "http://x",
    makeFollower: () => ({ status: "failed", exit: null,
      start: async () => { throw new Error("refused"); }, stop: () => {}, lines: () => [] }),
  });
  assert.doesNotThrow(() => s.syncProcesses(procs("a")));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.pane().status, "failed");
});

console.log("console-session.test.js: all assertions passed");
