// Every pane can be collapsed to its heading and expanded again, from the pane menu, and the choice is kept (0.9.6).
//
// THE OPERATOR'S ASK, 2026-10-28: "every pane (agents, notices, health, services, ...) can be expanded and collapsed".
// `c` opens the pane menu; a pane's letter switches it; Ctrl+] closes. Collapsed is kept in ~/.aify/tui.json under the
// same rule as `v`: a hand-edited file that cannot be used is never rewritten.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderDashboard, width } from "../lib/tui.mjs";
import { PANES } from "../lib/tui-panes/index.mjs";
import { PANE_KEYS } from "../lib/tui-panes/names.mjs";
import { layoutFrom, readLayout, tuiLayoutPath } from "../lib/tui-layout.mjs";
import { DETACH, initialFocus, reconcileFocus, routeKey } from "../lib/keys.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const SNAPSHOT = {
  version: "0.9.6-dev", endpoint: "http://127.0.0.1:8802", nowMs: 1_000_000, terminals: { available: true },
  services: [{ name: "aify-comms", state: "passed", endpoint: "http://127.0.0.1:8800", detail: "healthy" }],
  checks: [{ id: "a", state: "passed" }, { id: "b", state: "failed", detail: "broke" }],
  processes: [{ id: "x-p1", pid: 1, label: "worker", service: "aify-comms", terminal: true, uptimeMs: 60_000, title: "busy" }],
  history: { recentExits: [{ id: "x-p0", label: "gone", atMs: 990_000, exitCode: 0 }] },
  notices: [{ atMs: 999_000, count: 1, text: "said once" }],
  traffic: { requests: 7, bytesOut: 8 },
};
const KEYS = { enabled: true, canQuit: true };
const view = (mode = "dashboard") => ({ rows: SNAPSHOT.processes, selected: 0, mode, query: "", paneHidden: true });
const collapsedLayout = (names) => layoutFrom(JSON.stringify({ collapsed: names }));

test("the router's pane letters and the view's panes are the same list, in the same order", () => {
  assert.deepEqual(Object.keys(PANE_KEYS), PANES.map((pane) => pane.name));
  assert.equal(new Set(Object.values(PANE_KEYS)).size, PANES.length, "two panes share a letter");
});

test("collapsed, a pane is its heading alone, marked ▸, keeping its summary and fitting the width", () => {
  const all = Object.keys(PANE_KEYS).filter((name) => name !== "agents");
  for (const columns of [60, 100]) {
    const open = renderDashboard(SNAPSHOT, { columns }).join("\n");
    const lines = renderDashboard(SNAPSHOT, { columns, layout: collapsedLayout(all) });
    assert.match(open, /said once/, "the control: the notice is drawn when NOTICES is open");
    const text = lines.join("\n");
    for (const gone of ["said once", "broke", "1 requests handled", "exited cleanly"]) assert.doesNotMatch(text, new RegExp(gone));
    for (const head of ["SERVICES", "HEALTH", "RECENT EXITS", "NOTICES", "TRAFFIC"]) {
      const line = lines.find((l) => l.includes(head));
      assert.match(line ?? "", new RegExp(`^▸ ${head}`), `${head} is not drawn collapsed: ${line}`);
      assert.ok(width(line) <= columns && !line.endsWith("…"), `${head}'s heading was clipped at ${columns}`);
    }
    assert.match(lines.find((l) => l.includes("HEALTH")), /1 failed/, "a collapsed HEALTH still says what is wrong");
  }
});

test("a collapsed AGENTS loses its table and keeps how to get it back: the hint line and the menus", () => {
  const lines = renderDashboard(SNAPSHOT, { columns: 140, keys: KEYS, view: view(), layout: collapsedLayout(["agents"]) });
  assert.match(lines.find((l) => l.includes("PROCESSES")) ?? "", /^▸ PROCESSES/);
  assert.ok(!lines.some((l) => l.includes("worker")), "the table was drawn though AGENTS is collapsed");
  assert.ok(lines.some((l) => /c panes/.test(l)), "the hint line that leads back went with the table");
});

test("`c` opens the pane menu; a letter switches its pane; nothing else gets through; Ctrl+] closes", () => {
  const open = routeKey("c", initialFocus(1));
  assert.deepEqual([open.state.mode, open.action], ["panes", "panes-open"]);
  for (const [name, letter] of Object.entries(PANE_KEYS)) {
    const { state, action } = routeKey(letter, open.state);
    assert.deepEqual([state.mode, action], ["panes", `collapse:${name}`], letter);
  }
  for (const swallowed of ["q", "g", "m", "1", "\r"]) assert.equal(routeKey(swallowed, open.state).action, null, swallowed);
  assert.deepEqual([routeKey(DETACH, open.state).state.mode, routeKey(DETACH, open.state).action], ["dashboard", "panes-close"]);
  assert.equal(reconcileFocus(open.state, 0).mode, "panes", "an idle host's pane menu closed on the next refresh");
  assert.equal(reconcileFocus(open.state, 3).mode, "panes");
});

test("the pane menu lists every pane on screen with its state, and offers no hidden one", () => {
  const layout = layoutFrom(JSON.stringify({ collapsed: ["health"], hidden: ["traffic"] }));
  const lines = renderDashboard(SNAPSHOT, { columns: 120, keys: KEYS, view: view("panes"), layout });
  const rows = lines.filter((l) => /^ {4}\S [▾▸] /.test(l)).map((l) => l.trim());
  assert.deepEqual(rows, ["s ▾ services", "h ▸ health  collapsed", "a ▾ agents", "x ▾ exits", "n ▾ notices"]);
  assert.ok(lines.some((l) => /letter collapses or expands that pane/.test(l)));
  assert.deepEqual(layoutFrom(JSON.stringify({ collapsed: ["helth"] })).problems,
    ['collapsed names "helth", which is not a pane (panes: services, health, agents, exits, notices, traffic)']);
});

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

async function liveView(home) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const input = new FakeInput();
  const written = [];
  const notices = [];
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json", clearScreen: false, intervalMs: 60_000,
    columns: 160, rows: 60, input, write: (text) => written.push(text),
    notices: { add: (text) => notices.push(text), recent: () => [] },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ processes: SNAPSHOT.processes }) }),
    readFile: () => { throw new Error("no registry"); },
  });
  const press = async (keys) => {
    for (const key of keys) {
      input.emit("data", key);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { written, notices, press, stop, restore: () => Object.assign(process.env, saved) };
}

test("THROUGH THE VIEW: c, then h, collapses HEALTH at once and keeps it; h again expands it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-collapse-"));
  let live;
  try {
    live = await liveView(home);
    await new Promise((r) => setImmediate(r));
    assert.doesNotMatch(live.written.join(""), /▸ HEALTH/, "the control: HEALTH starts open");
    await live.press(["c", "h"]);
    assert.match(live.written.at(-1), /▸ HEALTH/, "h did not collapse HEALTH on screen");
    assert.deepEqual([...readLayout({ home }).collapsed], ["health"], "the collapse was not kept");
    await live.press(["h", DETACH]);
    assert.deepEqual([...readLayout({ home }).collapsed], [], "expanding was not kept");
    live.stop();
  } finally {
    live?.restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("THROUGH THE VIEW: a broken hand-edited file survives a collapse byte for byte, and the view says why", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-collapse-"));
  const broken = '{"collapsed": "health"}\n';
  let live;
  try {
    fs.mkdirSync(path.join(home, ".aify"));
    fs.writeFileSync(tuiLayoutPath(home), broken);
    live = await liveView(home);
    await live.press(["c", "h"]);
    assert.match(live.written.at(-1), /▸ HEALTH/, "the collapse still applies to this view");
    assert.equal(fs.readFileSync(tuiLayoutPath(home), "utf8"), broken, "the hand-edited file was rewritten");
    assert.ok(live.notices.some((text) => /not rewritten/.test(text)), JSON.stringify(live.notices));
    live.stop();
  } finally {
    live?.restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
