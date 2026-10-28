// Each of the view's parts (0.9.8b) keeps the rule its own file states, asked of the part directly.
//
// The session and dashboard suites drive these parts through ConsoleSession and startDashboard, and the 0.9.8b
// differentials compared the whole against the code it replaced. What those cannot say is which part a rule lives in,
// and two of them could not see a rule at all: a second check further along hid it. Ctrl+L forgetting the frame
// (KeyActions) and a frame drawn after stop (RefreshLoop) both survived their mutants through the whole view. Asked of
// the part, they cannot hide.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { InputDecoder } from "../lib/console-session/input-decoder.mjs";
import { PaneFollower } from "../lib/console-session/pane-follower.mjs";
import { StartList } from "../lib/console-session/start-list.mjs";
import { Subjects } from "../lib/console-session/subjects.mjs";
import { FrameWriter } from "../lib/dashboard/frame-writer.mjs";
import { KeyActions } from "../lib/dashboard/key-actions.mjs";
import { RefreshLoop } from "../lib/dashboard/refresh-loop.mjs";
import { ViewRenderer, orderedSnapshot } from "../lib/dashboard/view-renderer.mjs";
import { ENTER_VIEW, LEAVE_VIEW } from "../lib/frame.mjs";
import { readLayout } from "../lib/tui-layout.mjs";
import { PASTE_END, PASTE_START } from "../lib/bracketed-paste.mjs";
import { STREAMING } from "../lib/output-follower.mjs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const rows = (...ids) => ids.map((id) => ({ id, label: id }));

test("StartList: opening again drops the last answer's rows and asks anew", () => {
  const list = new StartList();
  list.note([{ id: "a" }, null, { name: "no id" }, { id: "b" }], "", "aify-comms", [{ reason: "r" }]);
  assert.deepEqual(list.rows.map((r) => r.id), ["a", "b"], "a row with no id is not a row");
  assert.equal(list.asked, true);
  list.open();
  assert.deepEqual([list.rows, list.problem, list.skipped, list.asked, list.opening], [[], "", [], false, 1]);
  assert.equal(list.view({ query: "", at: 0 }).asked, false, "an unanswered list is drawn as asking, not as empty");
});

test("InputDecoder: a read of arrows is cut into keys only in a mode that takes keys one at a time", () => {
  const seen = [];
  let mode = "dashboard";
  const decoder = new InputDecoder({ key: (data) => seen.push(["key", data]), paste: (text) => seen.push(["paste", text]), mode: () => mode });
  decoder.chunk(`${DOWN}${DOWN}`);
  mode = "pty";
  decoder.chunk(`${DOWN}${DOWN}`);
  decoder.chunk(`${PASTE_START}two${PASTE_END}`);
  assert.deepEqual(seen, [["key", DOWN], ["key", DOWN], ["key", `${DOWN}${DOWN}`], ["paste", "two"]]);
});

test("PaneFollower: the same target keeps its stream; another closes the old before opening; no width is not drawable", () => {
  const log = [];
  const pane = new PaneFollower({ now: () => 0, retryMs: 2000,
    makeFollower: (id) => ({ id, status: "connecting", start() { log.push(["start", id]); }, stop() { log.push(["stop", id]); } }) });
  pane.follow("a");
  pane.follow("a");
  pane.follow("b");
  assert.deepEqual(log, [["start", "a"], ["stop", "a"], ["start", "b"]]);
  assert.equal(pane.canDraw(), false, "an unreported width must not be drawable");
  pane.noteColumns(120);
  pane.follower.status = STREAMING;
  pane.follower.paneProblem = () => "";
  assert.equal(pane.noteRendered(true), true);
  assert.equal(pane.inputIsLive(), true, "CONTROL: a streaming frame drawn wide enough is live");
  pane.follow("c");
  assert.equal(pane.inputIsLive(), false, "a frame of b is no evidence about c");
});

test("Subjects: a menu's subject is resolved by identity after the rows shift, and a gone one is refused", () => {
  const subjects = new Subjects();
  subjects.capture("menu-open", "bravo");
  assert.equal(subjects.takeActionTarget("stop", rows("charlie", "bravo"))?.id, "bravo");
  subjects.capture("menu-open", "bravo");
  assert.equal(subjects.takeActionTarget("stop", rows("alpha", "charlie")), null, "a gone subject is refused, not replaced");
  subjects.capture("picker-open", "alpha");
  assert.equal(subjects.capture("picker-accept", null), "alpha", "a search that matched nothing returns where it opened");
});

test("FrameWriter: an unchanged frame writes nothing, a failed write is not cached, and the view is entered once", () => {
  const writes = [];
  let fail = false;
  const frames = new FrameWriter({ clearScreen: true, once: false, paneRepaintMs: 10, processEvents: null, onExit: () => {},
    write: (text) => { if (fail) throw new Error("gone"); writes.push(text); } });
  frames.show(["a", "b"]);
  assert.ok(writes[0].startsWith(ENTER_VIEW), "the first frame enters the view");
  frames.show(["a", "b"]);
  assert.equal(writes.length, 1, "an unchanged frame wrote something");
  fail = true;
  assert.throws(() => frames.show(["a", "c"]));
  fail = false;
  frames.show(["a", "c"]);
  assert.equal(writes.length, 2, "a frame that failed was cached as on screen, so its retry wrote nothing");
  frames.forget();
  frames.show(["a", "c"]);
  assert.equal(writes.length, 3, "a forgotten frame is written whole again");
  frames.leave();
  frames.leave();
  assert.deepEqual(writes.filter((w) => w === LEAVE_VIEW).length, 1, "the screen is given back once");
});

test("KeyActions: Ctrl+L asks for the frame to be forgotten, keys go to the selected agent, and quitting leaves", () => {
  const calls = [];
  const session = { selected: { id: "bravo" }, visible: () => rows("alpha", "bravo") };
  const keys = new KeyActions({ session, layout: { sort: "name" }, notices: null, repaint: () => {}, isStopped: () => false,
    onQuit: () => calls.push("quit"), onInput: (target, text) => calls.push(`${target.id}:${text}`) });
  assert.deepEqual(keys.act({ action: "repaint", toPty: null }), { leave: false, forgetFrame: true });
  assert.deepEqual(keys.act({ action: "move", toPty: null }), { leave: false, forgetFrame: false }, "CONTROL: a move forgets nothing");
  keys.act({ action: "pty-input", toPty: "x" });
  assert.deepEqual(keys.act({ action: "quit", quit: true, toPty: null }), { leave: true, forgetFrame: false });
  assert.deepEqual(calls, ["bravo:x", "quit"]);
});

test("RefreshLoop: a collection that lands after stop is not drawn, and a tick during a collection is skipped", async () => {
  const drawn = [];
  let release;
  const loop = new RefreshLoop({ intervalMs: 5, onSnapshot: (s) => drawn.push(s),
    collect: () => new Promise((resolve) => { release = resolve; }) });
  const first = loop.draw();
  loop.stop();
  release("late");
  await first;
  assert.deepEqual(drawn, [], "a frame was drawn after stop");
  let collections = 0;
  const busy = new RefreshLoop({ intervalMs: 5, onSnapshot: () => {}, collect: () => { collections += 1; return new Promise(() => {}); } });
  busy.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  busy.stop();
  assert.equal(collections, 1, "a tick started a second collection beside one still running");
});

test("ViewRenderer: rows are ordered on a copy, and a view with no keyboard draws no session", () => {
  const collected = { version: "0.9.8", endpoint: "http://127.0.0.1:8802", terminals: { available: true }, services: [],
    checks: [], history: { startedTotal: 2 }, processes: rows("charlie", "alpha"), agentRecords: {} };
  const ordered = orderedSnapshot(collected, "name");
  assert.deepEqual(ordered.processes.map((r) => r.id), ["alpha", "charlie"]);
  assert.deepEqual(collected.processes.map((r) => r.id), ["charlie", "alpha"], "the environment's own order was changed");
  const lines = new ViewRenderer({ color: false, endsWithHerdr: false, keys: { enabled: false, canQuit: false } })
    .lines(ordered, { session: null, layout: readLayout({ home: path.join(os.tmpdir(), "aify-no-such-home") }), outcome: "", columns: 100, rows: 24 });
  assert.ok(Array.isArray(lines) && lines.length > 0 && lines.some((line) => line.includes("alpha")), "the frame did not draw the rows");
});
