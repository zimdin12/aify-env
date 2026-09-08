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

//: Every action, because these tests exercise the whole menu. A real caller declares only what it
//: can perform -- `aify-env` cannot restart a managed agent -- and the default is attach alone.
const session = (log) => {
  const s = new ConsoleSession({
    endpoint: "http://x",
    makeFollower: recordingFollower(log),
    actions: ["attach", "restart", "stop"],
  });
  // A TERMINAL WIDE ENOUGH TO DRAW A PANE. Drawability now gates RESOURCES as well as input -- a pane
  // the compositor refuses to draw is one nobody is reading -- so a session that never reports a
  // viewport opens no stream at all. The tests that deliberately exercise a narrow or unreported
  // terminal set their own.
  s.noteViewport({ columns: 100 });
  return s;
};

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
  s.syncProcesses(procs("a"));
  s.handleInput(String.fromCharCode(13)); // attach
  s.notePaneRendered(true);   // attaching opens the follower, so the frame lands after it
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
  s.syncProcesses(procs("a"));
  s.notePaneRendered(true);   // a frame lands AFTER the follower opens
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
  s.syncProcesses(procs("a"));
  s.notePaneRendered(true);   // a frame lands AFTER the follower opens
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
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(String.fromCharCode(27) + "[B");   // down to bravo
  s.handleInput(String.fromCharCode(13));           // attach
  s.notePaneRendered(true);                        // ...and then a frame of bravo lands
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
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.notePaneRendered(true);   // a frame lands AFTER the follower opens
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
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput(String.fromCharCode(13));
  s.notePaneRendered(true);   // attaching opens the follower, so the frame lands after it
  assert.equal(s.focus.mode, "pty");
  assert.equal(s.selected.id, "alpha");

  s.syncProcesses(procs("bravo"));
  assert.equal(s.focus.mode, "dashboard", "the keyboard stayed inside a pane whose process is gone");
});

test("A PANE THE TERMINAL CANNOT DRAW OPENS NO STREAM EITHER", () => {
  // `paneHidden` says the operator does not want it; `canDrawPane` says the terminal cannot show it.
  // BOTH mean nobody is reading, and gating on the flag alone left a narrow terminal opening a
  // connection and filling a buffer for a pane the compositor refuses to draw. Measured at 79
  // columns, one under the minimum.
  const log = [];
  const s = session(log);
  s.noteViewport({ columns: 79 });
  s.syncProcesses(procs("alpha"));
  s.handleInput("p");
  assert.deepEqual(log, [], `a stream opened for an undrawable pane: ${log.join(", ")}`);
});

test("WIDENING OPENS IT AND NARROWING CLOSES IT, so the gate is not one-way", () => {
  // Without re-deriving on a viewport change, an operator who resized to FIX a too-narrow pane would
  // get one that stayed empty for ever -- the gate would refuse once and never reconsider.
  const log = [];
  const s = session(log);
  s.noteViewport({ columns: 79 });
  s.syncProcesses(procs("alpha"));
  s.handleInput("p");
  assert.deepEqual(log, []);

  s.noteViewport({ columns: 120 });
  assert.deepEqual(log, ["start:alpha"], "widening did not open the stream it had been refusing");

  s.noteViewport({ columns: 79 });
  assert.deepEqual(log, ["start:alpha", "stop:alpha"], "narrowing left the stream running");
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

test("A NEW FOLLOWER DOES NOT INHERIT THE OLD PANE'S READINESS", () => {
  // Review's witness: display alpha, switch to bravo, type -- and input reached bravo with no frame
  // of bravo ever drawn, because `paneRendered` was still true from alpha. An observation about one
  // process is not evidence about another.
  const s = session([]);
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput(String.fromCharCode(13));
  s.notePaneRendered(true);
  assert.equal(s.handleInput("to alpha").toPty, "to alpha", "precondition: alpha is typeable");

  s.handleInput(String.fromCharCode(29));   // Ctrl+], the one way back
  s.handleInput(DOWN_);                      // select bravo -- a new follower opens
  s.handleInput(String.fromCharCode(13));    // attach to it
  assert.equal(s.handleInput("to bravo").toPty, null,
    "input reached a process no frame of which had been drawn");

  s.notePaneRendered(true);
  assert.equal(s.handleInput("now").toPty, "now");
});

test("A RENDERED REFUSAL IS NOT A TERMINAL, so it takes no input either", () => {
  // A pane can be current, wide enough and STREAMING while what it shows is "waiting for the first
  // full repaint". Typing into that is typing at a screen the operator has explicitly been told they
  // are not seeing.
  const refusing = new ConsoleSession({
    endpoint: "http://x",
    makeFollower: () => ({
      status: "streaming", exit: null, start: async () => {}, stop: () => {}, lines: () => [],
      paneProblem: () => "waiting for the first full repaint",
    }),
  });
  refusing.noteViewport({ columns: 120 });
  refusing.syncProcesses(procs("alpha"));
  refusing.handleInput("p");
  refusing.handleInput(String.fromCharCode(13));
  refusing.notePaneRendered(true);
  assert.equal(refusing.handleInput("hello").toPty, null, "input reached a pane showing a notice");

  // POSITIVE CONTROL: the identical session with nothing to complain about DOES forward, so this is
  // not a guard that refuses everything.
  const showing = new ConsoleSession({
    endpoint: "http://x",
    makeFollower: () => ({
      status: "streaming", exit: null, start: async () => {}, stop: () => {}, lines: () => [],
      paneProblem: () => "",
    }),
  });
  showing.noteViewport({ columns: 120 });
  showing.syncProcesses(procs("alpha"));
  showing.handleInput("p");
  showing.handleInput(String.fromCharCode(13));
  showing.notePaneRendered(true);
  assert.equal(showing.handleInput("hello").toPty, "hello");
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
    s.syncProcesses(procs("alpha"));
    s.notePaneRendered(true);   // a frame lands AFTER the follower opens
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
  s.syncProcesses(procs("alpha"));
  s.handleInput(String.fromCharCode(13));
  s.notePaneRendered(true);   // attaching opens the follower, so the frame lands after it
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
  s.syncProcesses(procs("alpha"));
  assert.equal(s.handleInput(String.fromCharCode(13)).action, "attach");
  assert.equal(s.focus.mode, "pty");
  // ATTACHING OPENS THE FOLLOWER, which resets readiness -- so the frame is declared after it, in
  // exactly the order production produces: attach, draw, report, then type.
  s.notePaneRendered(true);
  assert.equal(s.handleInput("hello").toPty, "hello");
});

test("AN UNREPORTED VIEWPORT FAILS CLOSED, because a guard that passes on missing input is decoration", () => {
  // A caller that never says how wide it is cannot be shown to be drawable, and the failure mode of
  // guessing wrong is blind typing into a live agent. Refusing loudly is the recoverable direction:
  // a caller that forgets to report loses attach visibly, rather than gaining invisible input.
  // BUILT WITHOUT THE HELPER, which now reports a width of its own -- this test is precisely about a
  // caller that reports none.
  const s = new ConsoleSession({ endpoint: "http://x", makeFollower: recordingFollower([]) });
  s.syncProcesses(procs("alpha"));
  assert.equal(s.handleInput(String.fromCharCode(13)).action, "attach-refused");
  assert.equal(s.focus.mode, "dashboard");
});

// -- the actions menu hands work OUT ---------------------------------------------------------------

const ENTER = String.fromCharCode(13);

/**
 * Move the open menu onto `name` and choose it, or fail saying it was not on offer.
 *
 * BOUNDED, AND THAT IS THE POINT. These tests used `while (s.focus.menuAt !== 2)` loops, which HANG
 * rather than fail when the action is not reachable -- and the moment the menu's offer became
 * per-caller, they hung the whole suite instead of reporting anything. A test that cannot fail is
 * bad; one that hangs is worse, because it takes every other test with it.
 */
const chooseAction = (s, name, offered = ["attach", "restart", "stop"]) => {
  const want = offered.indexOf(name);
  assert.notEqual(want, -1, `${name} is not in the offer this test declared`);
  for (let step = 0; step < offered.length && s.focus.menuAt !== want; step += 1) s.handleInput(DOWN_);
  assert.equal(s.focus.menuAt, want, `could not reach ${name} in the menu`);
  return s.handleInput(ENTER);
};

const DOWN_ = String.fromCharCode(27) + "[B";

test("A DESTRUCTIVE ACTION REACHES THE CALLER ONLY AFTER A YES", () => {
  // The end of the safety chain. `keys.mjs` turns a destructive choice into a question; this proves
  // the caller -- the thing that would actually kill a worker -- is handed nothing until `y`.
  const s = shownSession([]);
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput(DOWN_);
  s.handleInput("m");

  const asked = chooseAction(s, "stop");
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
    s.syncProcesses(rows);
    s.notePaneRendered(true);   // a frame lands AFTER the follower opens
    s.handleInput(DOWN_);                                  // bravo
    s.handleInput("m");
    chooseAction(s, "stop");
    return s;
  };
  const three = () => procs("alpha", "bravo", "charlie");

  const removed = armed(three());
  removed.syncProcesses(procs("bravo", "charlie"));
  assert.equal(removed.handleInput("y").perform.process.id, "bravo",
    "a row above the target exiting moved the stop onto a different agent");

  const reordered = armed(three());
  // THE TARGET MUST ACTUALLY MOVE, and this permutation was chosen wrongly the first time: reversing
  // [alpha, bravo, charlie] leaves bravo at index 1, so the arm passed against code that read the
  // cursor. Review pointed that out. Asserted here rather than assumed, because a control that cannot
  // move the row proves nothing about following it.
  const after = procs("charlie", "alpha", "bravo");
  assert.notEqual(after.findIndex((row) => row.id === "bravo"), 1,
    "this permutation leaves the target at its old index, so the arm cannot fail");
  reordered.syncProcesses(after);
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
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.notePaneRendered(true);   // a frame lands AFTER the follower opens
  s.handleInput(DOWN_);
  s.handleInput("m");
  chooseAction(s, "stop");

  s.syncProcesses(procs("alpha", "charlie"));
  assert.equal(s.handleInput("y").perform, null, "the stop was redirected to a surviving agent");
});

test("NEGATIVE CONTROL: an unchanged list still stops the agent it named", () => {
  // Without this, refusing everything would satisfy both tests above and remove the feature.
  const s = shownSession([]);
  s.noteViewport({ columns: 120 });
  s.syncProcesses(procs("alpha", "bravo"));
  s.notePaneRendered(true);   // a frame lands AFTER the follower opens
  s.handleInput(DOWN_);
  s.handleInput("m");
  chooseAction(s, "stop");
  s.syncProcesses(procs("alpha", "bravo"));
  assert.equal(s.handleInput("y").perform.process.id, "bravo");
});

test("CANCELLING HANDS OUT NOTHING", () => {
  const s = shownSession([]);
  s.syncProcesses(procs("alpha", "bravo"));
  s.handleInput("m");
  chooseAction(s, "stop");
  const cancelled = s.handleInput("n");
  assert.equal(cancelled.perform, null);
  assert.equal(cancelled.action, "confirm-cancel");
  assert.equal(s.focus.mode, "dashboard");
});

test("A NON-DESTRUCTIVE CHOICE NEEDS NO YES, and attach is PERFORMED rather than handed out", () => {
  // It used to be reported as `chose:attach` for a caller to act on, and no caller knew how -- so the
  // menu's own default did nothing. The router carries it out itself, because it is the one action
  // that moves the keyboard and touches no process.
  const s = shownSession([]);
  s.syncProcesses(procs("alpha"));
  s.handleInput("m");
  const chosen = s.handleInput(ENTER);     // `attach` is the resting choice
  assert.equal(chosen.action, "attach", "attach was handed out instead of performed");
  assert.equal(chosen.perform, null, "attach reached an executor that does not know what it means");
  assert.equal(s.focus.mode, "pty");
  assert.equal(s.selected.id, "alpha");
});

test("THE PROCESS IS RESOLVED WHEN THE ACTION IS, not looked up later", () => {
  // Reading it afterwards would let the list move underneath -- the row-shift defect on the one path
  // that ends work. The handed-out object is the process itself, not an index to resolve later.
  const s = shownSession([]);
  s.syncProcesses(procs("alpha", "bravo", "charlie"));
  s.handleInput(DOWN_);
  s.handleInput("m");
  chooseAction(s, "stop");
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
  s.noteViewport({ columns: 100 });   // drawability gates resources, so a stream needs a terminal
  assert.doesNotThrow(() => s.syncProcesses(procs("a")));
  await new Promise((r) => setImmediate(r));
  s.handleInput("p");
  assert.equal(s.pane().status, "failed");
});

console.log("console-session.test.js: all assertions passed");
