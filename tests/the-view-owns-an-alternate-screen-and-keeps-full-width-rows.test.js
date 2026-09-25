// The live view draws on an alternate screen with the cursor hidden, and never erases the last
// column of a row that fills the terminal.
//
// THE DEFECT (v0.7 scan, F13). The first frame erased the operator's visible screen instead of
// switching to an alternate one, the cursor stayed visible and swept across every repainted row at up
// to twelve frames a second, and every full-width heading rule was followed by erase-to-end-of-line.
// On xterm-style terminals an erase in the pending-wrap state erases the cell in the last column, so
// the rule lost its final glyph. That terminal behaviour is ASSUMED, not observed on this host; what
// this pins is that such a row is never followed by an erase it does not need.

import assert from "node:assert/strict";
import test from "node:test";

import { ERASE_LINE, ENTER_VIEW, LEAVE_VIEW, frameUpdate } from "../lib/frame.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const ESC = String.fromCharCode(27);

test("a row as wide as or wider than the one it replaces is not followed by an erase", () => {
  const bytes = frameUpdate(["short", "same"], ["a much longer row", "SAME"]);
  assert.equal(bytes.includes(ERASE_LINE), false, JSON.stringify(bytes));
});

test("CONTROL: a row SHORTER than the one it replaces is still erased after its text", () => {
  const bytes = frameUpdate(["a much longer row"], ["short"]);
  assert.ok(bytes.indexOf("short") < bytes.indexOf(ERASE_LINE), JSON.stringify(bytes));
});

test("the first frame clears the screen once and erases no row after it", () => {
  const bytes = frameUpdate([], ["─".repeat(80), "row"]);
  assert.equal(bytes.includes(ERASE_LINE), false, JSON.stringify(bytes.slice(0, 40)));
});

const quietFetch = async () => ({ ok: true, status: 200, json: async () => ({ processes: [] }) });

test("the live view enters an alternate screen with the cursor hidden, and leaves it on stop", async () => {
  const written = [];
  const view = await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
    write: (text) => written.push(text), clearScreen: true, intervalMs: 60_000,
    fetchImpl: quietFetch, readFile: () => { throw new Error("none"); },
  });
  assert.ok(written[0].startsWith(ENTER_VIEW), `the view did not enter its own screen: ${JSON.stringify(written[0].slice(0, 30))}`);
  assert.ok(ENTER_VIEW.includes(`${ESC}[?1049h`) && ENTER_VIEW.includes(`${ESC}[?25l`));
  view.stop();
  assert.equal(written.at(-1), LEAVE_VIEW, "stop() did not give the screen and the cursor back");
  assert.ok(LEAVE_VIEW.includes(`${ESC}[?1049l`) && LEAVE_VIEW.includes(`${ESC}[?25h`));
  view.stop();
  assert.equal(written.filter((w) => w === LEAVE_VIEW).length, 1, "a second stop wrote the leave again");
});

test("CONTROL: a single --once frame stays on the operator's screen", async () => {
  const written = [];
  await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
    write: (text) => written.push(text), clearScreen: true, once: true,
    fetchImpl: quietFetch, readFile: () => { throw new Error("none"); },
  });
  assert.equal(written.join("").includes(`${ESC}[?1049h`), false, "a one-shot render hid itself on exit");
});
