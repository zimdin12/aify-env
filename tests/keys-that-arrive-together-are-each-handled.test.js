// Keys that arrive in one read are each handled, outside the pane.
//
// THE DEFECT (v0.7 scan, F14). Routing compared a whole chunk against one key (`chunk === DOWN`), so a
// held arrow or a quick `jj` that arrived as one read on a busy daemon did nothing at all. keys.mjs
// already says that coalescing is ordinary on this daemon, and the picker handled it; the dashboard,
// the menu and the start list did not.
//
// THE SAFETY RULE IS KEPT: a confirmation is answered only by a chunk that is exactly `y`. So when a
// chunk's keys lead INTO a confirmation, the rest of that chunk is dropped rather than read as the
// answer -- a paste must never be able to say yes.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { splitKeys } from "../lib/keys.mjs";
import { ConsoleSession } from "../lib/console-session.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;

test("a chunk is split into keys: escape sequences whole, everything else one character at a time", () => {
  assert.deepEqual(splitKeys(`${DOWN}${DOWN}`), [DOWN, DOWN]);
  assert.deepEqual(splitKeys("jj"), ["j", "j"]);
  assert.deepEqual(splitKeys(`a${ESC}[C`), ["a", `${ESC}[C`]);
  assert.deepEqual(splitKeys(`${ESC}OA${ESC}[1;5B`), [`${ESC}OA`, `${ESC}[1;5B`]);
  assert.deepEqual(splitKeys("é😀"), ["é", "😀"], "a character was split into code units");
  assert.deepEqual(splitKeys(ESC), [ESC], "a bare escape is a key");
});

const session = (rows = 4) => {
  const s = new ConsoleSession({
    makeFollower: () => ({ start() {}, stop() {}, lines: () => [] }),
    actions: ["attach", "stop"],
  });
  s.syncProcesses(Array.from({ length: rows }, (_, i) => ({ id: `p${i}`, label: `agent-${i}` })));
  return s;
};

test("two arrows in one read move the selection twice", () => {
  const s = session();
  s.handleChunk(`${DOWN}${DOWN}`);
  assert.equal(s.focus.selected, 2);
});

test("`jj` in one read moves twice, on the dashboard and in the menu", () => {
  const s = session();
  s.handleChunk("jj");
  assert.equal(s.focus.selected, 2);
  s.handleChunk("m");
  s.handleChunk("j");
  assert.equal(s.focus.menuAt, 1);
});

test("A CHUNK THAT LEADS INTO A CONFIRMATION CANNOT ANSWER IT", () => {
  // `m`, down to `stop`, Enter, then `y` -- all in one read. The prompt opens; the `y` is dropped.
  const s = session();
  const results = s.handleChunk(`m${DOWN}\ry`);
  assert.equal(s.focus.mode, "confirm", "the prompt did not open");
  assert.ok(results.every((r) => !r.perform), "a pasted y confirmed a stop");
  // CONTROL: a y typed on its own does confirm.
  assert.equal(s.handleChunk("y")[0].perform?.action, "stop");
});

test("CONTROL: in a confirmation a multi-key chunk still cancels, and the picker takes text whole", () => {
  const s = session();
  s.handleChunk("m");
  s.handleChunk(DOWN);
  s.handleChunk("\r");
  assert.equal(s.focus.mode, "confirm");
  assert.equal(s.handleChunk("yy")[0].action, "confirm-cancel");
  s.handleChunk("gage");
  assert.equal(s.focus.mode, "picker");
  assert.equal(s.focus.query, "age", "the rest of the chunk did not reach the search");
});

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

test("THROUGH THE VIEW: a coalesced read moves the cursor on screen", async () => {
  const input = new FakeInput();
  const written = [];
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
    write: (text) => written.push(text), clearScreen: false, intervalMs: 60_000,
    columns: 120, rows: 40, input,
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }, { id: "p3", label: "charlie" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  input.emit("data", "jj");
  stop();
  assert.match(written.at(-1), /❯3/, "the cursor did not reach the third row");
});
