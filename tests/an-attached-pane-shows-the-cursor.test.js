// An attached pane shows where the agent's cursor is.
//
// THE DEFECT (v0.7 scan, F11). The pane is rebuilt from cells and never drew the emulator's cursor,
// while the terminal's own cursor is parked below the frame. For a runtime that relies on the
// hardware cursor for its input line, the operator typed into a pane with no visible caret.
//
// ONLY A VISIBLE CURSOR IS DRAWN. A runtime that hides it (`ESC[?25l`) and paints its own -- Claude
// Code does -- would otherwise get a second, stray block wherever its hidden cursor happens to sit.

import assert from "node:assert/strict";
import test from "node:test";

import { ScreenEmulator } from "../lib/screen-emulator.mjs";
import { composeConsole } from "../lib/console-view.mjs";

const ESC = String.fromCharCode(27);
//: An SGR that turns inverse on, whatever else it sets (xterm emits `ESC[0;7;39;49m`).
const INVERSE_ON = new RegExp(`${ESC}\\[(?:[0-9;]*;)?7(?:;[0-9;]*)?m`);
const hasCaret = (row) => INVERSE_ON.test(row);

async function screenWithCursorOn(b) {
  const e = await ScreenEmulator.create({ cols: 20, rows: 3 });
  assert.ok(e, "@xterm/headless is not installed, so this cannot run");
  await e.write(`ab${ESC}[1;2H`);   // "ab", cursor back on the b
  return e;
}

test("the cell under a visible cursor is drawn inverse when the cursor is asked for", async () => {
  const e = await screenWithCursorOn();
  const [row] = e.rows({ color: true, cursor: true });
  assert.ok(new RegExp(`${INVERSE_ON.source}b`).test(row), `no caret on the cursor cell: ${JSON.stringify(row)}`);
  e.dispose();
});

test("CONTROL: without being asked, no caret is drawn", async () => {
  const e = await screenWithCursorOn();
  assert.equal(hasCaret(e.rows({ color: true })[0]), false);
  e.dispose();
});

test("a HIDDEN cursor is not drawn, and showing it again brings it back", async () => {
  const e = await screenWithCursorOn();
  await e.write(`${ESC}[?25l`);
  assert.equal(hasCaret(e.rows({ color: true, cursor: true })[0]), false, "a hidden cursor was drawn");
  await e.write(`${ESC}[?25h`);
  assert.ok(hasCaret(e.rows({ color: true, cursor: true })[0]), "a re-shown cursor was not drawn");
  e.dispose();
});

test("the console asks for the cursor only when the keyboard is attached", () => {
  const asked = [];
  const pane = (attached) => ({
    id: "a", label: "alpha", status: "streaming", attached,
    lines: (opts) => { asked.push(opts.cursor); return []; },
  });
  composeConsole({ dashboardLines: [], pane: pane(true), columns: 120, rows: 20, color: true });
  composeConsole({ dashboardLines: [], pane: pane(false), columns: 120, rows: 20, color: true });
  assert.deepEqual(asked, [true, false]);
});
