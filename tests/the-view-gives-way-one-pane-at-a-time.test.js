// When the frame is taller than the terminal, the view gives up one thing at a time, least needed first (0.9.10).
//
// THE OPERATOR'S SCREEN, 2026-10-29: a 129x40 Herdr pane, seven agents running and twenty not. ROSTER's twenty rows
// made the frame 44 lines, and the fit compacted EVERY side pane at once: HEALTH lost its two FAIL rows, TRAFFIC and
// ROSTER went to one line each, and the view drew 15 of 40 rows. `c` then opened nothing, because the fit compacted the
// pane again on the next frame, and a pane squeezed that way looked exactly like one the operator had collapsed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fitDashboard, renderDashboard } from "../lib/tui.mjs";
import { COLLAPSED_MARK, NO_ROOM_MARK, PANE_KEYS } from "../lib/tui-panes/names.mjs";
import { layoutFrom, tuiLayoutPath } from "../lib/tui-layout.mjs";
import { startDashboard } from "../lib/dashboard.mjs";
import { GIVES_WAY } from "../lib/tui-panes/index.mjs";
import { KeyActions } from "../lib/dashboard/key-actions.mjs";
import { USAGE } from "../lib/usage.mjs";

const NOW_MS = 1_000_000_000;
const RUNNING = ["dashboard-manager", "dashboard-senior-dev", "env-senior-dev", "golf-manager", "golf-senior-dev", "pc-manager",
  "wrapper-senior-dev"];
const STOPPED = Array.from({ length: 20 }, (_, i) => `stopped-${String(i).padStart(2, "0")}`);
const SNAPSHOT = {
  version: "0.9.10-dev", endpoint: "http://127.0.0.1:64108", nowMs: NOW_MS, terminals: { available: true },
  services: [{ name: "aify-comms", state: "passed" }, { name: "aify-dashboard", state: "passed" }],
  checks: [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `check-${i}`, state: "passed" })),
    { id: "code-current", state: "failed", detail: "running build dd47b8d3, but the code on disk is 4dabf439" },
    { id: "credentials", state: "failed", detail: "1 stored credential(s) that no registry entry references" },
  ],
  processes: RUNNING.map((label, i) => ({ id: `p${i}`, pid: 100 + i, label, service: "aify-comms", terminal: true, uptimeMs: 60_000,
    title: "Claude Code" })),
  agentRecords: Object.fromEntries([
    ...RUNNING.map((agentId, i) => [agentId, { agentId, lifetime: `life-${i}`, state: "working", stateCause: "turn-open" }]),
    ...STOPPED.map((agentId) => [agentId, { agentId, lifetime: null, state: "available", stateCause: "startable" }]),
  ]),
  traffic: { requests: 5814, bytesOut: 49276622 },
};
const KEYS = { enabled: true, canQuit: true };
const VIEW = { rows: SNAPSHOT.processes, selected: 0, mode: "dashboard", query: "", paneHidden: true };
//: His ~/.aify/tui.json that day.
const HIS_LAYOUT = layoutFrom(JSON.stringify({ version: 1, extended: false, collapsed: ["services"], expanded: [] }));
const at = (rows, options = {}) => fitDashboard(SNAPSHOT, { columns: 129, keys: KEYS, view: VIEW, layout: HIS_LAYOUT, rows, ...options });
const FAILS = (lines) => lines.filter((line) => /^\s+FAIL\s/.test(line)).length;
const marked = (lines) => lines.filter((line) => line.startsWith(`${NO_ROOM_MARK} `)).map((line) => line.split(" ")[1].toLowerCase());

test("HIS SCREEN: at 129x40 the frame keeps HEALTH's FAIL rows and TRAFFIC whole, and ROSTER shows what fits", () => {
  const full = renderDashboard(SNAPSHOT, { columns: 129, keys: KEYS, view: VIEW, layout: HIS_LAYOUT });
  assert.ok(full.length > 40, `CONTROL: the whole frame (${full.length} lines) is taller than his 40 rows, as his was`);
  const { lines, noRoom } = at(40);
  assert.ok(lines.length <= 40, `${lines.length} lines on a 40-row pane`);
  assert.ok(lines.length >= 38, `the fit drew ${lines.length} of 40 rows: it gave up more than it had to`);
  assert.equal(FAILS(lines), 2, "HEALTH lost its FAIL rows");
  assert.ok(lines.some((line) => line.startsWith("TRAFFIC this environment's own io")), "TRAFFIC was squeezed to one line");
  assert.deepEqual([...noRoom], [], "a pane was drawn ▹ on a screen with room for it");
  const shown = lines.filter((line) => /^\s+stopped-\d\d\s/.test(line)).length;
  const more = Number(lines.map((line) => line.match(/^\s+\+(\d+) more/)?.[1]).find(Boolean) ?? 0);
  assert.ok(shown >= 10, `ROSTER showed ${shown} of 20 with room on screen`);
  assert.equal(shown + more, 20, `ROSTER shows ${shown} and counts ${more} more: not the 20`);
  assert.ok(lines.some((line) => line.includes("wrapper-senior-dev")), "a running agent lost its row");
  // THE BLANK LINES WENT FIRST: a stopped agent's row is worth more than a gap, a pane's own opening one included.
  assert.ok(more > 0, "CONTROL: ROSTER gave rows up");
  assert.deepEqual(lines.filter((line) => line.trim() === "").length, 0, "a blank line was kept while ROSTER gave rows up");
});

test("A SHORT TERMINAL (24 rows) fits, keeps every running agent and HEALTH's FAIL rows, and says what has no room", () => {
  const { lines, noRoom } = at(24);
  assert.ok(lines.length <= 24, `${lines.length} lines on a 24-row terminal`);
  for (const agent of RUNNING) assert.ok(lines.some((line) => line.includes(agent)), `${agent} lost its row`);
  assert.equal(FAILS(lines), 2, "HEALTH's FAIL rows went at 24 rows");
  for (const pane of ["health", "roster", "traffic"]) {
    assert.equal(marked(lines).includes(pane), noRoom.has(pane), `${pane}: its ▹ mark and the fit disagree`);
  }
});

test("WIDE AND SHORT: panes give way in their order, so HEALTH's FAIL rows never go before TRAFFIC, at any height", () => {
  const full = renderDashboard(SNAPSHOT, { columns: 129, keys: KEYS, view: VIEW, layout: HIS_LAYOUT }).length;
  let last = Infinity;
  let sawEach = new Set();
  let trafficAlone = false;
  for (let rows = full; rows >= 12; rows -= 1) {
    const { lines, noRoom } = at(rows);
    const given = [...noRoom];
    assert.deepEqual(given, GIVES_WAY.slice(0, given.length), `at ${rows} rows the panes gave way out of order: ${given}`);
    if (FAILS(lines) < 2) assert.ok(given.includes("traffic"), `at ${rows} rows HEALTH's FAIL rows went before TRAFFIC`);
    // MONOTONIC: a shorter terminal never gives back a pane a taller one took.
    assert.ok(last === Infinity || given.length >= last, `at ${rows} rows fewer panes gave way than one row taller`);
    last = given.length;
    sawEach = new Set([...sawEach, ...given]);
    trafficAlone ||= given.length === 1 && given[0] === "traffic";
  }
  // ONE AT A TIME: some height gives up TRAFFIC and nothing else, where the fit before 0.9.10 gave up every pane at once.
  assert.ok(trafficAlone, "no height gave way with TRAFFIC alone: the panes went together");
  assert.ok(sawEach.has("health") && sawEach.has("traffic"), "CONTROL: heights short enough for both to give way were tried");
});

test("A PANE COLLAPSED BY THE OPERATOR KEEPS ▸, a pane with no room is ▹, and the help says which is which", () => {
  assert.notEqual(COLLAPSED_MARK, NO_ROOM_MARK);
  const { lines } = at(14);
  assert.ok(lines.some((line) => line.startsWith(`${COLLAPSED_MARK} SERVICES`)), "the operator's collapsed SERVICES lost its ▸");
  assert.ok(lines.some((line) => line.startsWith(`${NO_ROOM_MARK} `)), "CONTROL: at 14 rows something has no room");
  assert.ok(!lines.some((line) => line.startsWith(`${NO_ROOM_MARK} SERVICES`)), "a collapsed pane was marked as having no room");
  assert.ok(USAGE.includes(`${COLLAPSED_MARK}  a pane you collapsed`) && USAGE.includes(`${NO_ROOM_MARK}  a pane with no room`),
    "the help does not say what the two marks mean");
});

test("`c` ON A PANE WITH NO ROOM says why and changes nothing; on any other pane it still collapses it", () => {
  const reports = [];
  const writes = [];
  let noRoom = new Set(["health"]);
  const keys = new KeyActions({ session: null, layout: HIS_LAYOUT, notices: { add: (text) => reports.push(text) }, repaint: () => {},
    isStopped: () => false, noRoom: () => noRoom, writeLayout: (layout) => { writes.push(layout); return { written: true }; } });
  keys.act({ action: "collapse:health", toPty: null });
  assert.deepEqual(writes, [], "a pane with no room was flipped: it would collapse, the opposite of what was asked");
  assert.match(reports.at(-1) ?? "", /HEALTH has no room on this screen: collapse another pane/);
  assert.equal(keys.layout.collapsed.has("health"), false);
  keys.act({ action: "collapse:traffic", toPty: null });
  assert.equal(writes.length, 1, "CONTROL: a pane with room is collapsed and kept");
  assert.equal(keys.layout.collapsed.has("traffic"), true);
  noRoom = new Set();
  keys.act({ action: "collapse:health", toPty: null });
  assert.equal(keys.layout.collapsed.has("health"), true, "once there is room, `c` collapses HEALTH as before");
});

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

test("THROUGH THE VIEW: on a short screen the pane menu marks a pane ▹, and its letter says why instead of flipping it", async () => {
  // A temporary home, because a `c` that flipped the pane would write ~/.aify/tui.json under it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-no-room-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const input = new FakeInput();
  const written = [];
  const notices = [];
  let stop = () => {};
  try {
    ({ stop } = await startDashboard({
      endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json", clearScreen: false, intervalMs: 60_000,
      columns: 129, rows: 12, input, write: (text) => written.push(text),
      notices: { add: (text) => notices.push(text), recent: () => [] },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ processes: SNAPSHOT.processes }) }),
      readFile: () => { throw new Error("no registry"); },
    }));
    await new Promise((r) => setImmediate(r));
    const squeezed = written.join("").split("\n").map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
      .find((line) => line.startsWith(`${NO_ROOM_MARK} `));
    assert.ok(squeezed, "CONTROL: at 12 rows some pane has no room");
    const pane = squeezed.split(" ")[1].toLowerCase();
    for (const key of ["c", PANE_KEYS[pane]]) {
      input.emit("data", key);
      await new Promise((r) => setImmediate(r));
    }
    assert.match(notices.join("\n"), new RegExp(`${pane.toUpperCase()} has no room on this screen`), `c on ▹ ${pane} said nothing`);
    assert.equal(fs.existsSync(tuiLayoutPath(home)), false, `c on ▹ ${pane} flipped it and wrote the layout`);
    assert.match(written.join(""), new RegExp(`${NO_ROOM_MARK} ${pane}.*no room on this screen`), "the pane menu does not say it has no room");
  } finally {
    stop();
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
