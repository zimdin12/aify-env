// A paste into the view is one unit, whichever way the terminal's reads split it.
//
// THE DEFECT (v0.7.1 review, T06 and E9). A paste was inert on the list only while each read held
// more than a lone command key: a read that was exactly `\r` attached the keyboard, and a read made
// only of `j`, `k` and arrows moved the selection. Where a terminal splits a paste is not ours to
// choose, so "inert" was a property of luck.
//
// BRACKETED PASTE ENDS THE GUESSING. The view turns it on (`CSI ?2004h`) while it owns the terminal,
// so the terminal wraps every paste in `CSI 200~` ... `CSI 201~`. Everything between the two is one
// pasted unit: never a key on the list, the menu, the start list or a confirmation; text in the find
// box; and, in an attached pane, handed to the agent whole -- with the markers when the agent asked
// for bracketed paste itself, as a terminal would, and without them when it did not.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { ConsoleSession } from "../lib/console-session.mjs";
import { PASTE_END, PASTE_START, PASTE_QUIET_MS, PasteReader } from "../lib/bracketed-paste.mjs";
import { ENTER_VIEW, LEAVE_VIEW } from "../lib/frame.mjs";
import { startDashboard } from "../lib/dashboard.mjs";
import { STREAMING } from "../lib/output-follower.mjs";

const ESC = String.fromCharCode(27);
const DETACH = String.fromCharCode(29);
const CTRL_C = String.fromCharCode(3);
//: Every key the list, the menu and the start list act on, so any of them leaking out shows.
const PAYLOAD = `jj\r${ESC}[Bq2msk\ry${CTRL_C}g`;
const PASTE = `${PASTE_START}${PAYLOAD}${PASTE_END}`;
const PROCS = [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }, { id: "p3", label: "charlie" }];

/** Every way to cut `text` into two reads, and into three. */
function* splits(text) {
  for (let i = 1; i < text.length; i += 1) {
    yield [text.slice(0, i), text.slice(i)];
    for (let j = i + 1; j < text.length; j += 1) yield [text.slice(0, i), text.slice(i, j), text.slice(j)];
  }
  yield [...text];
}

function session({ agentWantsPasteMarkers = true } = {}) {
  const s = new ConsoleSession({
    makeFollower: (id) => ({
      id,
      status: STREAMING,
      screen: { bracketedPaste: agentWantsPasteMarkers, rows: () => [] },
      start: async () => {},
      stop() {},
      paneProblem: () => "",
      lines: () => [],
    }),
    actions: ["attach", "stop"],
  });
  s.noteViewport({ columns: 160 });
  s.syncProcesses(PROCS);
  return s;
}

/** Feed the reads, then let anything held back go, as the view's timer does. */
function feed(s, reads) {
  const results = [];
  for (const read of reads) results.push(...s.handleChunk(read));
  results.push(...s.flushInput());
  return results;
}

const acted = (results) => results.filter((r) => r.action || r.quit || r.interrupt || r.toPty || r.perform || r.startAgent);

test("on the list, a paste split anywhere moves nothing, attaches nothing and quits nothing", () => {
  for (const reads of splits(PASTE)) {
    const s = session();
    const results = feed(s, reads);
    assert.deepEqual(acted(results), [], `split ${JSON.stringify(reads)} acted: ${JSON.stringify(acted(results))}`);
    assert.equal(s.focus.mode, "dashboard", `split ${JSON.stringify(reads)} left the list`);
    assert.equal(s.focus.selected, 0, `split ${JSON.stringify(reads)} moved the selection`);
  }
});

test("CONTROL: the same keys typed, not pasted, do act", () => {
  const s = session();
  const results = feed(s, ["j"]);
  assert.equal(results[0].action, "move");
  assert.equal(s.focus.selected, 1);
});

test("in the menu and the start list, a paste split anywhere chooses nothing", () => {
  for (const reads of splits(PASTE)) {
    const menu = session();
    menu.handleInput("m");
    assert.deepEqual(acted(feed(menu, reads)), [], `the menu acted on split ${JSON.stringify(reads)}`);
    assert.equal(menu.focus.mode, "menu");
    assert.equal(menu.focus.menuAt, 0);

    const start = session();
    start.handleInput("s");
    start.noteStartable([{ id: "a1" }, { id: "a2" }]);
    assert.deepEqual(acted(feed(start, reads)), [], `the start list acted on split ${JSON.stringify(reads)}`);
    assert.equal(start.focus.mode, "start");
    assert.equal(start.focus.startAt, 0);
  }
});

test("a stop confirmation is not answered by a pasted y", () => {
  const s = session();
  for (const key of ["m", `${ESC}[B`, "\r"]) s.handleInput(key);
  assert.equal(s.focus.mode, "confirm", "positive control: the prompt did not open");
  const results = feed(s, [`${PASTE_START}y${PASTE_END}`]);
  assert.deepEqual(acted(results), []);
  assert.equal(s.focus.mode, "confirm");
});

/** A session attached to alpha, with a frame of it drawn, so keys reach the agent. */
function attached(options) {
  const s = session(options);
  s.handleInput("\r");
  s.notePaneRendered(true);
  assert.equal(s.focus.mode, "pty", "positive control: the fixture did not attach");
  return s;
}

const forwarded = (results) => results.map((r) => r.toPty ?? "").join("");

test("attached, a paste split anywhere reaches the agent whole, markers and all, when it asked for them", () => {
  const withDetachByte = `${PASTE_START}a${DETACH}b\rc${PASTE_END}`;
  for (const paste of [PASTE, withDetachByte]) {
    for (const reads of splits(paste)) {
      const s = attached();
      const results = feed(s, reads);
      assert.equal(forwarded(results), paste, `split ${JSON.stringify(reads)} reached the agent changed`);
      assert.equal(results.filter((r) => r.toPty).length, 1, `split ${JSON.stringify(reads)} arrived in pieces`);
      assert.equal(s.focus.mode, "pty", `split ${JSON.stringify(reads)} detached the keyboard`);
    }
  }
});

test("attached to an agent that never asked for bracketed paste, it gets the text without the markers", () => {
  for (const reads of splits(PASTE)) {
    assert.equal(forwarded(feed(attached({ agentWantsPasteMarkers: false }), reads)), PAYLOAD,
      `split ${JSON.stringify(reads)}`);
  }
});

test("CONTROL: typing around a paste still types, and the detach key alone still detaches", () => {
  const s = attached();
  const results = feed(s, [`x${PASTE_START}p${PASTE_END}y`]);
  assert.equal(forwarded(results), `x${PASTE_START}p${PASTE_END}y`);
  assert.equal(feed(s, [DETACH])[0].action, "detach");
});

test("in find, a paste is text for the filter, never Enter or Ctrl+]", () => {
  for (const reads of splits(`${PASTE_START}br\r${DETACH}av${PASTE_END}`)) {
    const s = session();
    s.handleInput("g");
    feed(s, reads);
    assert.equal(s.focus.mode, "picker", `split ${JSON.stringify(reads)} left find`);
    assert.equal(s.focus.query, "brav", `split ${JSON.stringify(reads)}`);
  }
});

test("the view turns bracketed paste on while it owns the terminal, and off with the screen", () => {
  assert.ok(ENTER_VIEW.includes(`${ESC}[?2004h`));
  assert.ok(LEAVE_VIEW.includes(`${ESC}[?2004l`));
});

test("a paste whose end never arrives is closed once the terminal goes quiet, as one unit", async (t) => {
  class FakeInput extends EventEmitter {
    setRawMode() { return this; }
    resume() { return this; }
    pause() { return this; }
  }
  const input = new FakeInput();
  const frames = [];
  const view = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: (text) => frames.push(text),
    clearScreen: false,
    intervalMs: 60_000,
    columns: 120,
    rows: 40,
    input,
    fetchImpl: async () => ({ ok: true, status: 200, body: null, json: async () => ({ processes: PROCS }) }),
    readFile: () => { throw new Error("no registry"); },
  });
  t.after(view.stop);
  input.emit("data", "g");
  input.emit("data", `${PASTE_START}charl`);
  assert.match(frames.at(-1), /find ▌/, "positive control: find is not open");
  await new Promise((resolve) => setTimeout(resolve, PASTE_QUIET_MS + 150));
  assert.match(frames.at(-1), /find charl▌/, "the unfinished paste was never delivered");
  // And the keyboard is not stuck inside a paste: the next key is a key.
  input.emit("data", DETACH);
  assert.doesNotMatch(frames.at(-1), /find \S*▌/, "the keyboard is still inside the paste");
});

test("an end marker arriving after its paste was closed is dropped, not typed at the agent", () => {
  const s = attached();
  s.handleChunk(`${PASTE_START}abc`);
  assert.equal(forwarded(s.flushInput()), `${PASTE_START}abc${PASTE_END}`, "positive control: the quiet close");
  assert.equal(forwarded(feed(s, [`${PASTE_END}`])), "", "the late end marker reached the agent");
});

test("the agent's own bracketed-paste mode is read off its emulated screen", async () => {
  const { ScreenEmulator } = await import("../lib/screen-emulator.mjs");
  const screen = await ScreenEmulator.create({ cols: 20, rows: 4 });
  assert.ok(screen, "@xterm/headless is not installed, so this cannot be checked");
  assert.equal(screen.bracketedPaste, false, "CONTROL: a fresh screen reports it on");
  await screen.write(`${ESC}[?2004h`);
  assert.equal(screen.bracketedPaste, true);
  await screen.write(`${ESC}[?2004l`);
  assert.equal(screen.bracketedPaste, false);
  screen.dispose();
});

test("a held tail that turns out not to be a marker is typed, in order, however it ends", () => {
  // The reader holds `ESC [ 2` in case it is the start of a paste. An arrow key finishing it, or
  // quiet, must hand it back as typing -- a lone ESC typed into an attached pane included.
  const reader = new PasteReader();
  assert.deepEqual(reader.read(`a${ESC}[2`), [{ paste: false, text: "a" }]);
  assert.deepEqual(reader.read("~b"), [{ paste: false, text: `${ESC}[2~b` }], "the Insert key was not typed");
  assert.deepEqual(reader.read(ESC), []);
  assert.ok(reader.waitMs > 0 && reader.waitMs < PASTE_QUIET_MS, "a held ESC waits as long as a lost paste");
  assert.deepEqual(reader.flush(), [{ paste: false, text: ESC }]);
  assert.equal(reader.waitMs, null);
});

test("attached, a lone ESC reaches the agent once the terminal has gone quiet", () => {
  const s = attached();
  assert.deepEqual(s.handleChunk(ESC).map((r) => r.toPty).filter(Boolean), [], "positive control: it was held");
  assert.equal(forwarded(s.flushInput()), ESC);
});
