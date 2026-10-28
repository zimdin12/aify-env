// The agents table lists its rows by name, or what needs looking at first; `o` switches and the choice is kept (0.9.7).
//
// THE OPERATOR'S ASK, 2026-10-28: "both, configurable", by name by default. Attention order is derived from the
// palette and the turn, not listed, and a reorder never moves the cursor to another agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROW_SORTS, attentionRank, sortRows } from "../lib/tui-panes/row-order.mjs";
import { layoutFrom, readLayout } from "../lib/tui-layout.mjs";
import { initialFocus, routeKey } from "../lib/keys.mjs";
import { ConsoleSession } from "../lib/console-session.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const rows = (...labels) => labels.map((label, i) => ({ id: `x-p${i + 1}`, label }));
const labels = (list) => list.map((row) => row.label);
const RECORDS = {
  zulu: { state: "idle", turn: { open: false } },
  alpha: { state: "working", turn: { open: true } },
  mike: { state: "blocked", stateCause: "folder-trust" },
  bravo: { state: "confused" },
  kilo: { state: "working", turn: { open: true } },
};

test("by name is the default, from no file and from an unknown order", () => {
  const list = rows("zulu", "alpha", "mike", "bravo", "kilo", "echo");
  assert.deepEqual(labels(sortRows(list, RECORDS, undefined)), ["alpha", "bravo", "echo", "kilo", "mike", "zulu"]);
  assert.deepEqual(labels(sortRows(list, RECORDS, "nonsense")), ["alpha", "bravo", "echo", "kilo", "mike", "zulu"]);
  assert.equal(layoutFrom(null).sort, "name");
  assert.deepEqual(labels(list), ["zulu", "alpha", "mike", "bravo", "kilo", "echo"], "the snapshot's own list was sorted in place");
});

test("attention: what needs looking at, then working, then the rest, then the unreported; by name within each", () => {
  const list = rows("zulu", "alpha", "mike", "bravo", "kilo", "echo");
  // bravo's word is one the palette does not know, so it needs looking at with no list naming it.
  assert.deepEqual(labels(sortRows(list, RECORDS, "attention")), ["bravo", "mike", "alpha", "kilo", "zulu", "echo"]);
  assert.deepEqual([attentionRank(RECORDS.mike), attentionRank(RECORDS.alpha), attentionRank(RECORDS.zulu), attentionRank(undefined)], [0, 1, 2, 3]);
});

test("the layout file keeps `sort`, and names only an order that exists", () => {
  assert.equal(layoutFrom(JSON.stringify({ sort: "attention" })).sort, "attention");
  const wrong = layoutFrom(JSON.stringify({ sort: "loudest" }));
  assert.equal(wrong.sort, "name");
  assert.deepEqual(wrong.problems, [`sort names "loudest", which is not a row order (orders: ${Object.keys(ROW_SORTS).join(", ")})`]);
});

test("`o` asks for the next order on the list, and is a letter in find", () => {
  assert.equal(routeKey("o", initialFocus(3)).action, "sort-toggle");
  const finding = routeKey("g", initialFocus(3)).state;
  assert.notEqual(routeKey("o", finding).action, "sort-toggle", "find swallowed `o` as a command");
});

test("A REORDER NEVER MOVES THE CURSOR to another agent", () => {
  const s = new ConsoleSession({ makeFollower: () => ({ start() {}, stop() {}, status: "open", exit: null, lines: () => [] }) });
  s.noteViewport({ columns: 100 });
  const list = rows("alpha", "bravo", "charlie");
  s.syncProcesses(list);
  s.handleInput(`${String.fromCharCode(27)}[B`);
  assert.equal(s.selected?.label, "bravo", "the control: the cursor is on bravo");
  // BRAVO MOVES: a reversal would leave the middle row where it was, and this would pass on an index.
  s.syncProcesses([list[1], list[2], list[0]]);
  assert.equal(s.selected?.label, "bravo", "the cursor moved to the agent that took bravo's place");
  assert.equal(s.focus.selected, 0);
  s.syncProcesses([list[0], list[2]]);
  assert.equal(s.focus.selected, 0, "an agent that is gone leaves the cursor where it was, clamped, as before");
});

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

test("THROUGH THE VIEW: rows by name, `o` to attention and back, each kept in tui.json", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-sort-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const processes = rows("zulu", "alpha", "mike").map((row) => ({ ...row, terminal: true, title: "t" }));
  const agents = [{ agentId: "zulu", state: "idle", lifetime: "l1" }, { agentId: "alpha", state: "idle", lifetime: "l2" },
    { agentId: "mike", state: "blocked", stateCause: "folder-trust", lifetime: "l3" }];
  const input = new FakeInput();
  const written = [];
  let stop;
  try {
    ({ stop } = await startDashboard({
      endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json", clearScreen: false, intervalMs: 60_000,
      columns: 160, rows: 60, input, write: (text) => written.push(text), notices: { add() {}, recent: () => [] },
      fetchImpl: async (url) => ({ ok: true, status: 200,
        json: async () => (String(url).endsWith("/agents/state") ? { agents, complete: true } : { processes }) }),
      readFile: () => { throw new Error("no registry"); },
    }));
    await new Promise((r) => setImmediate(r));
    const order = () => {
      const frame = written.at(-1);
      return ["alpha", "mike", "zulu"].map((name) => [name, frame.indexOf(name)]).sort((a, b) => a[1] - b[1]).map(([name]) => name);
    };
    assert.deepEqual(order(), ["alpha", "mike", "zulu"], "not by name at start");
    input.emit("data", "o");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order(), ["mike", "alpha", "zulu"], "`o` did not put the blocked agent first");
    assert.equal(readLayout({ home }).sort, "attention", "the order was not kept");
    input.emit("data", "o");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order(), ["alpha", "mike", "zulu"]);
    assert.equal(readLayout({ home }).sort, "name");
  } finally {
    stop?.();
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
