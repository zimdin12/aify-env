// The agents list draws the columns the operator asked for, `v` switches to the rest, and the switch is kept (0.9.6).
//
// THE OPERATOR'S ASK, 2026-10-28: drop the status text and the numeric id from the default view, put `out` right after
// the agent, hide id and pid but keep them for an extended view, hide service and io by default, and keep the choice
// where a restart preserves it. Which reading of the two drops was meant is asked on the dashboard
// (01M602WYZHBKGGD2SFA766V9MT); the default here is the reading stated there.
//
// AND THE FILE THE OPERATOR WROTE IS NEVER LOST TO A KEY (comms-tech-lead's review): a hand-edited ~/.aify/tui.json
// that cannot be used survives a `v` press byte for byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderDashboard } from "../lib/tui.mjs";
import { AGENT_COLUMNS, DEFAULT_AGENT_COLUMNS, agentColumns } from "../lib/tui-panes/agent-columns.mjs";
import { layoutFrom, readLayout, tuiLayoutPath, writeLayoutChange } from "../lib/tui-layout.mjs";
import { initialFocus, routeKey } from "../lib/keys.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const SNAPSHOT = {
  version: "0.9.6-dev", endpoint: "http://127.0.0.1:8802", nowMs: 1_000_000, terminals: { available: true },
  services: [], checks: [], history: { startedTotal: 1 }, traffic: {},
  processes: [{ id: "1f15df98-7d5e-4f24-92fe-51ddd4a3a24e-p1", pid: 4242, label: "worker", service: "aify-comms",
    terminal: true, uptimeMs: 600_000, title: "Claude Code", lastOutputAtMs: 999_000 }],
  agentRecords: { worker: { agentId: "worker", state: "working" } },
};
const KEYS = { enabled: true, canQuit: true };
const VIEW = { rows: SNAPSHOT.processes, selected: 0, mode: "dashboard", query: "", paneHidden: true };
const EXTENDED = layoutFrom(JSON.stringify({ extended: true }));
const headerOf = (lines) => lines.find((line) => /\bAGENT\b/.test(line)) ?? "";
const rowOf = (lines) => lines.find((line) => line.includes("worker")) ?? "";
const hintOf = (lines) => lines.find((line) => line.includes("quit")) ?? "";

test("the default view: the dot, the agent, out right after it, and title; `up` is in the extended set (0.9.7)", () => {
  const lines = renderDashboard(SNAPSHOT, { columns: 160, keys: KEYS, view: VIEW });
  // NO HEADER over the dot (0.9.7): it padded a one-character column to the six of "status".
  assert.match(headerOf(lines), /^\s+AGENT\s+OUT\s+TITLE$/);
  const row = rowOf(lines);
  assert.match(row, /^\s*❯\s+●\s+worker\s+●\s+Claude Code$/, "the cursor, the status dot alone, then agent, out and title");
  for (const hidden of ["a24e-p1", "4242", "aify-comms", "pty", "working", "10m"]) assert.ok(!row.includes(hidden), `the default row shows ${hidden}`);
  assert.doesNotMatch(hintOf(lines), /1-9 jump/, "a jump hint over rows that carry no numbers");
  assert.match(hintOf(lines), /v more columns/);
});

test("the extended view: numbered rows, the status word, id, pid, service and io, and the jump hint", () => {
  const lines = renderDashboard(SNAPSHOT, { columns: 200, keys: KEYS, view: VIEW, layout: EXTENDED });
  assert.match(headerOf(lines), /^\s+#\s+STATUS\s+AGENT\s+OUT\s+ID\s+PID\s+SERVICE\s+IO\s+UP\s+TITLE$/);
  assert.match(rowOf(lines), /^\s*❯1\s+● working\s+worker\s+●\s+a24e-p1\s+4242\s+aify-comms\s+pty\s+10m\s+Claude Code$/);
  assert.match(hintOf(lines), /1-9 jump/);
  assert.match(hintOf(lines), /v fewer columns/);
});

test("no keyboard, no cursor and no numbers: a piped view has nothing to point or jump with", () => {
  // THE ROW, NOT THE HEADER: the cursor's header is blank, and since 0.9.7 so is the dot's, so a header cannot show
  // whether a cursor column was drawn. A keyless row starts at its dot.
  for (const [layout, start] of [[null, /^\s*●\s+worker/], [EXTENDED, /^\s*● working\s+worker/]]) {
    const row = rowOf(renderDashboard(SNAPSHOT, { columns: 200, layout }));
    assert.match(row, start, `a keyless view drew a cursor or number column: ${row}`);
  }
  assert.deepEqual(agentColumns(["cursor", "#", "agent"], { enabled: false }).map((c) => c.name), ["agent"]);
});

test("the file may set either list, by the registry's names; a list naming no agent is refused", () => {
  const custom = layoutFrom(JSON.stringify({ columns: { agents: { normal: ["agent", "pid", "title"] } } }));
  assert.deepEqual(custom.problems, []);
  assert.match(headerOf(renderDashboard(SNAPSHOT, { columns: 160, layout: custom })), /^\s+AGENT\s+PID\s+TITLE$/);
  const wrong = layoutFrom(JSON.stringify({ columns: { agents: { normal: ["agent", "pdi"], extended: ["pid"] } } }));
  assert.deepEqual(wrong.columns.normal, ["agent"]);
  assert.deepEqual(wrong.columns.extended, [...DEFAULT_AGENT_COLUMNS.extended]);
  assert.match(wrong.problems.join("; "), /columns\.agents\.normal names "pdi", which is not a column/);
  assert.match(wrong.problems.join("; "), /columns\.agents\.extended has no agent column/);
  assert.deepEqual(layoutFrom(JSON.stringify({ extended: "yes" })).problems, ["extended is not true or false"]);
  // Every default name is one the registry draws.
  for (const name of [...DEFAULT_AGENT_COLUMNS.normal, ...DEFAULT_AGENT_COLUMNS.extended]) {
    assert.ok(AGENT_COLUMNS.some((column) => column.name === name), name);
  }
});

test("`v` is the switch on the list, and only there: a letter in a search, a key for an attached agent", () => {
  assert.equal(routeKey("v", { ...initialFocus(2) }).action, "columns-toggle");
  assert.equal(routeKey("v", { ...initialFocus(2) }).state.mode, "dashboard");
  assert.notEqual(routeKey("v", { ...initialFocus(2), mode: "picker" }).action, "columns-toggle");
  assert.equal(routeKey("v", { ...initialFocus(2), mode: "pty", paneHidden: false }).toPty, "v");
});

function scratchHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-columns-"));
  return { home, file: tuiLayoutPath(home), done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("writeLayoutChange: creates a missing file, keeps what a clean one says, and never rewrites a broken one", () => {
  const h = scratchHome();
  try {
    assert.deepEqual(writeLayoutChange({ extended: true }, { home: h.home }), { written: true, problem: "" });
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file, "utf8")), { version: 1, extended: true });
    fs.writeFileSync(h.file, JSON.stringify({ version: 1, hidden: ["traffic"], extended: true }));
    assert.equal(writeLayoutChange({ extended: false }, { home: h.home }).written, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file, "utf8")), { version: 1, hidden: ["traffic"], extended: false },
      "a toggle lost what the operator had written");
    for (const broken of ['{"hidden": ["trafic"], "extended": true', '{"hidden": ["trafic"]}', "[]"]) {
      fs.writeFileSync(h.file, broken);
      const refused = writeLayoutChange({ extended: false }, { home: h.home });
      assert.equal(refused.written, false, broken);
      assert.match(refused.problem, /not rewritten/);
      assert.equal(fs.readFileSync(h.file, "utf8"), broken, `a hand-edited file was overwritten: ${broken}`);
    }
    const locked = writeLayoutChange({ extended: true }, { home: h.home, readFile: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } });
    assert.deepEqual([locked.written, /could not be read \(EACCES\)/.test(locked.problem)], [false, true]);
  } finally {
    h.done();
  }
});

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

/** A live view over one agent, reading and writing tui.json under this process's home (each test file is its own process). */
async function liveView(home) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const input = new FakeInput();
  const written = [];
  const notices = [];
  try {
    const { stop } = await startDashboard({
      endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json", clearScreen: false, intervalMs: 60_000,
      columns: 200, rows: 40, input, write: (text) => written.push(text),
      notices: { add: (text) => notices.push(text), recent: () => [] },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ processes: SNAPSHOT.processes }) }),
      readFile: () => { throw new Error("no registry"); },
    });
    return { input, written, notices, stop, restore: () => Object.assign(process.env, saved) };
  } catch (error) {
    Object.assign(process.env, saved);
    throw error;
  }
}

test("THROUGH THE VIEW: `v` switches the columns at once and keeps the choice for the next view", async () => {
  const h = scratchHome();
  let view;
  try {
    view = await liveView(h.home);
    await new Promise((r) => setImmediate(r));
    assert.doesNotMatch(view.written.join(""), /PID/, "the control: the first frame is the default view");
    view.input.emit("data", "v");
    await new Promise((r) => setImmediate(r));
    assert.match(view.written.at(-1), /PID/, "`v` did not switch the columns on screen");
    assert.deepEqual(readLayout({ home: h.home }).extended, true, "the switch was not kept");
    view.stop();
  } finally {
    view?.restore();
    h.done();
  }
});

test("THROUGH THE VIEW: a broken hand-edited file survives `v` byte for byte, and the view says why", async () => {
  const h = scratchHome();
  let view;
  const broken = '{"version": 1, "hidden": ["trafic"]}\n';
  try {
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, broken);
    view = await liveView(h.home);
    await new Promise((r) => setImmediate(r));
    view.input.emit("data", "v");
    await new Promise((r) => setImmediate(r));
    assert.match(view.written.at(-1), /PID/, "the switch still applies to this view");
    assert.equal(fs.readFileSync(h.file, "utf8"), broken, "the hand-edited file was rewritten");
    assert.ok(view.notices.some((text) => /not rewritten/.test(text)), `nothing said why: ${JSON.stringify(view.notices)}`);
    view.stop();
  } finally {
    view?.restore();
    h.done();
  }
});

test("THE README'S tui.json EXAMPLE is a file the view takes whole, and its columns are the defaults it says they are", () => {
  // It said so in 0.9.6 and went stale in 0.9.7, when `up` left the default set: found by reading, not by a test.
  const readme = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "README.md"), "utf8");
  const example = readme.split("### Its layout")[1]?.split("```json\n")[1]?.split("```")[0];
  assert.ok(example, "the README has no tui.json example under \"### Its layout\"");
  const parsed = layoutFrom(example);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.columns, { normal: [...DEFAULT_AGENT_COLUMNS.normal], extended: [...DEFAULT_AGENT_COLUMNS.extended] });
});
