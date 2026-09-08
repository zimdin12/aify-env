// Which process is being watched, and the stream that watches it.
//
// A FOLLOWER IS A CONNECTION. Most of these tests are about NOT churning one: the selection moving is
// the only thing that may open or close a stream, and a refresh returning the same list must leave it
// entirely alone. Getting that wrong on a busy host opens and abandons a connection per keypress.

import assert from "node:assert/strict";
import test from "node:test";

import { dashboardColumns } from "../lib/console-view.mjs";
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

//: A session whose console is OPEN, on a terminal wide enough to draw it. The pane defaults to
//: HIDDEN and a hidden pane opens no follower, so every test about stream lifecycle needs one that
//: is actually showing -- otherwise it would be asserting on a feature that is switched off.
const shownSession = (log) => {
  const s = session(log);
  s.noteViewport({ columns: 100 });
  s.handleInput("p");
  return s;
};

// -- selection and follower lifecycle -------------------------------------------------------------

test("the first process list opens a follower for the selection", () => {
  const log = [];
  shownSession(log).syncProcesses(procs("a", "b"));
  assert.deepEqual(log, ["start:a"]);
});

test("AN UNCHANGED LIST DOES NOT CHURN THE STREAM", () => {
  // The refresh runs every couple of seconds. Re-opening on each one would abandon a connection per
  // tick and lose the buffer with it.
  const log = [];
  const s = shownSession(log);
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("a", "b"));
  assert.deepEqual(log, ["start:a"]);
});

test("a list that changes AROUND the selection still does not churn it", () => {
  // Another process appearing or leaving is the normal case. What matters is the process UNDER the
  // selection, not the shape of the list.
  const log = [];
  const s = shownSession(log);
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("a", "b", "c"));
  s.syncProcesses(procs("a", "c"));
  assert.deepEqual(log, ["start:a"]);
});

test("moving the selection CLOSES the old stream before opening the new one", () => {
  // Leaving it open keeps a connection and a growing buffer alive for a process nobody is watching.
  const log = [];
  const s = shownSession(log);
  s.syncProcesses(procs("a", "b"));
  s.handleInput(DOWN);
  assert.deepEqual(log, ["start:a", "stop:a", "start:b"]);
});

test("THE PROCESS UNDER THE SELECTION CHANGING re-points the follower", () => {
  // The index stayed at 0 and the process there is a different one. Keying on the index rather than
  // the id would leave the pane showing output from a process that is no longer there.
  const log = [];
  const s = shownSession(log);
  s.syncProcesses(procs("a", "b"));
  s.syncProcesses(procs("z", "b"));
  assert.deepEqual(log, ["start:a", "stop:a", "start:z"]);
});

test("an empty list closes the stream and selects nothing", () => {
  const log = [];
  const s = shownSession(log);
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
  s.noteViewport({ columns: 100 });   // this test attaches, so it needs a drawable terminal
  s.notePaneRendered(true);           // ...and a frame that actually reached the screen
  s.syncProcesses(procs("a"));
  s.handleInput(String.fromCharCode(13)); // attach
  const { toPty } = s.handleInput("ls -la");
  assert.equal(toPty, "ls -la");
});

// -- the pane ------------------------------------------------------------------------------------

test("the pane carries what the composer needs, including the follower's own status", () => {
  const s = session([]);
  s.syncProcesses(procs("a"));
  // THE PANE IS HIDDEN UNTIL ASKED FOR, so this presses the key an operator would. What is under
  // test here is what the pane CARRIES, not whether it is showing.
  s.handleInput("p");
  const pane = s.pane();
  assert.equal(pane.id, "a");
  assert.equal(pane.label, "label-a");
  assert.equal(pane.status, STREAMING);
  assert.deepEqual(pane.lines({ height: 5, width: 40 }), ["output of a"]);
});

test("the pane says whether input is going to the process", () => {
  // An operator typing into a pane needs to know whether the keys land there or move the selection.
  const s = session([]);
  s.noteViewport({ columns: 100 });   // this test attaches, so it needs a drawable terminal
  s.notePaneRendered(true);           // ...and a frame that actually reached the screen
  s.syncProcesses(procs("a"));
  s.handleInput("p");
  assert.equal(s.pane().attached, false);
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.pane().attached, true);
});

test("THE PANE IS HIDDEN UNTIL ASKED FOR, so the agent list gets the whole screen", () => {
  // The operator's complaint, in one assertion: "as you can see right side does not show much and I
  // cannot see all my agents in a list". `dashboard.mjs` derives the dashboard's width from
  // `Boolean(console_?.pane())` and passes the same call's result as the pane, so a null here both
  // drops the console and widens the list. One answer, not two that can disagree.
  const s = session([]);
  s.syncProcesses(procs("a"));
  assert.equal(s.pane(), null, "the pane was showing before anyone asked for it");
  assert.equal(dashboardColumns(120, Boolean(s.pane())), 120, "the list did not get the full width");

  s.handleInput("p");
  assert.notEqual(s.pane(), null, "`p` did not open the pane");
  assert.equal(dashboardColumns(120, Boolean(s.pane())), 60, "the split did not happen");
});

test("attaching opens the pane even when it was hidden", () => {
  // Otherwise Enter puts the keyboard inside a process whose output is not on screen.
  const s = session([]);
  s.noteViewport({ columns: 100 });   // this test attaches, so it needs a drawable terminal
  s.notePaneRendered(true);           // ...and a frame that actually reached the screen
  s.syncProcesses(procs("a"));
  assert.equal(s.pane(), null);
  s.handleInput(String.fromCharCode(13));
  const pane = s.pane();
  assert.notEqual(pane, null, "attached with the pane still hidden -- input would be blind");
  assert.equal(pane.attached, true);
});

test("ATTACHMENT FOLLOWS THE PROCESS WHEN A ROW ABOVE IT DISAPPEARS", () => {
  // P1, found by comms-senior-dev 2026-09-08. The existing guard only fires when the WATCHED process
  // is gone. Remove a DIFFERENT one and the watched process still exists, so `pty` mode stays on --
  // while `selected` is an INDEX, and every row below the removal has just shifted up by one.
  //
  // Attach to bravo in [alpha, bravo, charlie], remove alpha, and index 1 now means charlie. The
  // operator is looking at a pane they opened on bravo and typing into charlie's live PTY. Nothing on
  // screen announces it. Testing only the removal of the ATTACHED process misses this whole class.
  const log = [];
  const s = session(log);
  s.noteViewport({ columns: 100 });   // this test attaches, so it needs a drawable terminal
  s.notePaneRendered(true);           // ...and a frame that actually reached the screen
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(String.fromCharCode(27) + "[B");   // down to bravo
  s.handleInput(String.fromCharCode(13));           // attach
  assert.equal(s.selected.id, "bravo", "precondition: attached to bravo");
  assert.equal(s.focus.mode, "pty");

  s.syncProcesses(procs("bravo", "charlie"));

  assert.equal(s.focus.mode, "pty", "the attachment was dropped even though bravo is still running");
  assert.equal(s.selected.id, "bravo",
    `typing would go to ${s.selected?.id} -- the keyboard followed the ROW, not the process`);
  const { toPty } = s.handleInput("hello");
  assert.equal(toPty, "hello");
  assert.equal(s.watchedId, "bravo", "the follower moved to a process the operator did not choose");
});

test("attachment survives a REORDER, not just a removal", () => {
  // Same defect, no removal at all: the daemon lists processes in whatever order it holds them, and
  // an index means a different process the moment two swap.
  const s = session([]);
  s.noteViewport({ columns: 100 });   // this test attaches, so it needs a drawable terminal
  s.notePaneRendered(true);           // ...and a frame that actually reached the screen
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(String.fromCharCode(27) + "[B");
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.selected.id, "bravo");

  // bravo MUST change index, or this test passes on a broken implementation. It did: my first
  // permutation left bravo at index 1 and proved nothing.
  s.syncProcesses(procs("bravo", "charlie", "alpha"));
  assert.equal(s.selected.id, "bravo", "the selection followed position through a reorder");
});

test("but when the ATTACHED process itself goes, the keyboard fails CLOSED", () => {
  // The control for the two above: re-pointing by identity is impossible when the identity is gone,
  // so the keyboard goes back to the dashboard where a keystroke moves a cursor instead of reaching
  // a process. A fix for the shift case that kept pty mode alive here would be worse than the bug.
  const s = session([]);
  s.noteViewport({ columns: 100 });   // this test attaches, so it needs a drawable terminal
  s.notePaneRendered(true);           // ...and a frame that actually reached the screen
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.focus.mode, "pty");
  assert.equal(s.selected.id, "alpha");

  s.syncProcesses(procs("bravo"));
  assert.equal(s.focus.mode, "dashboard", "the keyboard stayed inside a pane whose process is gone");
});

// -- the hidden pane costs nothing ---------------------------------------------------------------

test("A HIDDEN PANE OPENS NO FOLLOWER, because a stream nobody is reading is pure cost", () => {
  // The operator asked for the console "only when shown". `pane()` returning null gated the DRAWING
  // and nothing gated the RESOURCES: review reported it and I measured it -- with the pane hidden,
  // `pane()` was null while `syncProcesses` opened a follower and set `watchedId`. On a host with
  // agents streaming continuously that is an HTTP connection and a growing ring buffer for a pane
  // that is not on screen.
  const log = [];
  const s = session(log);
  s.noteViewport({ columns: 100 });
  s.syncProcesses(procs("alpha", "bravo"));
  assert.deepEqual(log, [], `a hidden pane opened ${log.join(", ")}`);
  assert.equal(s.watchedId, null);
});

test("SHOWING IT opens one, and hiding it again closes it", () => {
  // The positive control for the test above: a gate that never opened a follower at all would
  // satisfy it and silently remove the console.
  const log = [];
  const s = session(log);
  s.noteViewport({ columns: 100 });
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput("p");
  assert.deepEqual(log, ["start:alpha"], "showing the pane did not open a stream");
  s.handleInput("p");
  assert.deepEqual(log, ["start:alpha", "stop:alpha"], "hiding the pane left the stream running");
  assert.equal(s.watchedId, null);
});

test("moving the selection while hidden still opens nothing", () => {
  // Arrow keys keep working with the console closed -- the list is the point of the view -- and each
  // move would otherwise open and close a stream for a pane nobody can see.
  const log = [];
  const s = session(log);
  s.noteViewport({ columns: 100 });
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(String.fromCharCode(27) + "[B");
  s.handleInput(String.fromCharCode(27) + "[B");
  assert.deepEqual(log, [], `moving while hidden opened ${log.join(", ")}`);
  s.handleInput("p");
  assert.deepEqual(log, ["start:charlie"], "showing the pane opened the wrong process");
});

// -- blind input ---------------------------------------------------------------------------------
//
// R8, and review's rerun found it live: at 79 columns `composeConsole` drops the pane entirely while
// `routeKey` goes on forwarding every keystroke to the process. The operator types into an agent with
// NO SCREEN ON THEM. That is the same defect as the P1 above wearing different clothes -- input
// reaching a process the operator is not looking at -- and it is why `paneHidden` alone cannot be the
// gate: the compositor can refuse to draw a pane the session thinks is showing.

test("A TOO-NARROW TERMINAL REFUSES THE ATTACH rather than typing blind", () => {
  // 79 is one column under the pane's minimum, which is the exact width review reproduced at.
  const s = session([]);
  s.noteViewport({ columns: 79 });
  s.syncProcesses(procs("alpha"));
  const { action } = s.handleInput(String.fromCharCode(13));
  assert.notEqual(s.focus.mode, "pty",
    "attached on a terminal too narrow to draw the pane -- every keystroke would go somewhere unseen");
  assert.equal(action, "attach-refused");
  const { toPty } = s.handleInput("rm -rf /");
  assert.equal(toPty, null, "input was forwarded to a process with no screen on it");
});

test("RESIZING BELOW THE MINIMUM detaches an attachment that was legitimate", () => {
  // The operator attaches on a wide terminal and then narrows the window. Nothing about the session
  // changed; the compositor simply stopped drawing the pane. Input must stop with it.
  const s = session([]);
  s.noteViewport({ columns: 120 });
  s.syncProcesses(procs("alpha"));
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.focus.mode, "pty", "precondition: attached on a wide terminal");

  s.noteViewport({ columns: 79 });
  assert.equal(s.focus.mode, "dashboard", "the keyboard stayed in a pane the compositor is not drawing");
  assert.equal(s.handleInput("hello").toPty, null);
});

test("NOTHING IS FORWARDED UNTIL A PANE FRAME ACTUALLY RENDERED", () => {
  // `canDrawPane` proves the layout would PERMIT a pane. It cannot prove one was drawn, and review
  // reproduced the difference: input forwarded while the follower was still connecting, after a 503
  // or a 404, after the process exited, and into a one-row screen carrying only a header. In every
  // one of those the operator is typing at something they cannot read.
  //
  // READINESS IS AN OBSERVATION, NOT A PREDICTION -- the whole correction in one line.
  const s = session([]);
  s.noteViewport({ columns: 120 });
  s.syncProcesses(procs("alpha"));
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.focus.mode, "pty", "attach is gated on width, so it may proceed optimistically");
  assert.equal(s.handleInput("secret").toPty, null,
    "a keystroke reached the process before any frame had rendered");

  s.notePaneRendered(true);
  assert.equal(s.handleInput("now").toPty, "now", "input never became live");
});

test("A STREAM THAT IS NOT LIVE TAKES NO INPUT, however well the pane renders", () => {
  // A pane showing "connecting", an exit notice or a failure is a RENDERED frame and still not a
  // place to type: the keys go nowhere and the screen does not move, which is indistinguishable from
  // a frozen view.
  for (const status of ["connecting", "exited", "failed"]) {
    const s = new ConsoleSession({
      endpoint: "http://x",
      makeFollower: () => ({ status, exit: null, start: async () => {}, stop: () => {}, lines: () => [] }),
    });
    s.noteViewport({ columns: 120 });
    s.notePaneRendered(true);
    s.syncProcesses(procs("alpha"));
    s.handleInput("p");
    s.handleInput(String.fromCharCode(13));
    assert.equal(s.handleInput("hello").toPty, null, `input was forwarded to a ${status} stream`);
  }
});

test("A FRAME THAT STOPS RENDERING REVOKES THE ATTACHMENT", () => {
  // The operator did not detach; the screen simply stopped carrying their agent. A failed display
  // write leaves no attached-pane frame, and input must stop with it rather than keep flowing.
  const s = shownSession([]);
  s.noteViewport({ columns: 120 });
  s.notePaneRendered(true);
  s.syncProcesses(procs("alpha"));
  s.handleInput(String.fromCharCode(13));
  assert.equal(s.focus.mode, "pty");

  s.notePaneRendered(false);
  assert.equal(s.focus.mode, "dashboard", "the keyboard stayed inside a pane that stopped rendering");
  assert.equal(s.handleInput("hello").toPty, null);
});

test("POSITIVE CONTROL: a wide enough terminal still attaches and forwards", () => {
  // Without this, a guard that refused everything would satisfy both tests above and silently remove
  // the feature.
  const s = session([]);
  s.noteViewport({ columns: 100 });
  s.notePaneRendered(true);
  s.syncProcesses(procs("alpha"));
  assert.equal(s.handleInput(String.fromCharCode(13)).action, "attach");
  assert.equal(s.focus.mode, "pty");
  assert.equal(s.handleInput("hello").toPty, "hello");
});

test("AN UNREPORTED VIEWPORT FAILS CLOSED, because a guard that passes on missing input is decoration", () => {
  // A caller that never says how wide it is cannot be shown to be drawable, and the failure mode of
  // guessing wrong is blind typing into a live agent. Refusing loudly is the recoverable direction:
  // a caller that forgets to report loses attach visibly, rather than gaining invisible input.
  const s = session([]);
  s.syncProcesses(procs("alpha"));
  assert.equal(s.handleInput(String.fromCharCode(13)).action, "attach-refused");
  assert.equal(s.focus.mode, "dashboard");
});

// -- the actions menu hands work OUT ---------------------------------------------------------------

const ENTER = String.fromCharCode(13);
const DOWN_ = String.fromCharCode(27) + "[B";

test("A DESTRUCTIVE ACTION REACHES THE CALLER ONLY AFTER A YES", () => {
  // The end of the safety chain. `keys.mjs` turns a destructive choice into a question; this proves
  // the caller -- the thing that would actually kill a worker -- is handed nothing until `y`.
  const s = shownSession([]);
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput(DOWN_);
  s.handleInput("m");
  while (s.focus.menuAt !== 2) s.handleInput(DOWN_);   // to `stop`

  const asked = s.handleInput(ENTER);
  assert.equal(asked.perform, null, "the caller was handed a stop before it was confirmed");
  assert.equal(asked.action, "confirm:stop");

  const done = s.handleInput("y");
  assert.equal(done.perform.action, "stop");
  assert.equal(done.perform.process.id, "bravo", "the action named the wrong agent");
});

test("A CONFIRMED STOP FOLLOWS THE AGENT IT WAS OPENED ON, not the cursor", () => {
  // THE ROW-SHIFT DEFECT FOR THE THIRD TIME THIS SESSION, and this one was EXPOSED BY MY OWN FIX:
  // preserving `confirming` across a refresh kept the OPERATION and left the SUBJECT to be
  // re-derived from `selected` at `y` time. Measured before the fix -- confirm stop for bravo, let
  // alpha exit, press y, and charlie is stopped.
  //
  // The list refreshes every two seconds. Between choosing and confirming, it moves.
  const armed = (rows) => {
    const s = shownSession([]);
    s.noteViewport({ columns: 120 });
    s.notePaneRendered(true);
    s.syncProcesses(rows);
    s.handleInput(DOWN_);                                  // bravo
    s.handleInput("m");
    while (s.focus.menuAt !== 2) s.handleInput(DOWN_);      // stop
    s.handleInput(ENTER);
    return s;
  };
  const three = () => procs("alpha", "bravo", "charlie");

  const removed = armed(three());
  removed.syncProcesses(procs("bravo", "charlie"));
  assert.equal(removed.handleInput("y").perform.process.id, "bravo",
    "a row above the target exiting moved the stop onto a different agent");

  const reordered = armed(three());
  reordered.syncProcesses(procs("charlie", "bravo", "alpha"));
  assert.equal(reordered.handleInput("y").perform.process.id, "bravo",
    "a reorder moved the stop onto a different agent");

  const inserted = armed(three());
  inserted.syncProcesses(procs("delta", "alpha", "bravo", "charlie"));
  assert.equal(inserted.handleInput("y").perform.process.id, "bravo",
    "a new agent appearing above the target moved the stop");
});

test("IF THE TARGET ITSELF IS GONE, THE ACTION IS REFUSED rather than redirected", () => {
  // A process that exited while its own stop was being confirmed does not need stopping, and the row
  // that took its place did not consent to anything. Refusing is the only answer that is not somebody
  // else's work ending.
  const s = shownSession([]);
  s.noteViewport({ columns: 120 });
  s.notePaneRendered(true);
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(DOWN_);
  s.handleInput("m");
  while (s.focus.menuAt !== 2) s.handleInput(DOWN_);
  s.handleInput(ENTER);

  s.syncProcesses(procs("alpha", "charlie"));
  assert.equal(s.handleInput("y").perform, null, "the stop was redirected to a surviving agent");
});

test("NEGATIVE CONTROL: an unchanged list still stops the agent it named", () => {
  // Without this, refusing everything would satisfy both tests above and remove the feature.
  const s = shownSession([]);
  s.noteViewport({ columns: 120 });
  s.notePaneRendered(true);
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput(DOWN_);
  s.handleInput("m");
  while (s.focus.menuAt !== 2) s.handleInput(DOWN_);
  s.handleInput(ENTER);
  s.syncProcesses(procs("alpha", "bravo"));
  assert.equal(s.handleInput("y").perform.process.id, "bravo");
});

test("CANCELLING HANDS OUT NOTHING", () => {
  const s = shownSession([]);
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput("m");
  while (s.focus.menuAt !== 2) s.handleInput(DOWN_);
  s.handleInput(ENTER);
  const cancelled = s.handleInput("n");
  assert.equal(cancelled.perform, null);
  assert.equal(cancelled.action, "confirm-cancel");
  assert.equal(s.focus.mode, "dashboard");
});

test("A NON-DESTRUCTIVE CHOICE NEEDS NO YES, so the guard is not refusing everything", () => {
  const s = shownSession([]);
  s.syncProcesses(procs("alpha"));
  s.handleInput("m");
  const chosen = s.handleInput(ENTER);     // `attach` is the resting choice
  assert.equal(chosen.perform.action, "attach");
  assert.equal(chosen.perform.process.id, "alpha");
});

test("THE PROCESS IS RESOLVED WHEN THE ACTION IS, not looked up later", () => {
  // Reading it afterwards would let the list move underneath -- the row-shift defect on the one path
  // that ends work. The handed-out object is the process itself, not an index to resolve later.
  const s = shownSession([]);
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(DOWN_);
  s.handleInput("m");
  while (s.focus.menuAt !== 2) s.handleInput(DOWN_);
  s.handleInput(ENTER);
  const done = s.handleInput("y");
  assert.equal(done.perform.process.id, "bravo");
  assert.equal(done.perform.process.label, "label-bravo", "an id was handed over without its row");
});

test("stop() closes the stream and is safe twice", () => {
  const log = [];
  const s = shownSession(log);
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
  s.handleInput("p");
  assert.equal(s.pane().status, "failed");
});

console.log("console-session.test.js: all assertions passed");
