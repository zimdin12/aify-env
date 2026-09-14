#!/usr/bin/env node
// Inside `herdr-aify env`, every worker already has its own Herdr space, so the view's console and
// attach are a second, worse way to reach the same agent.
//
// The operator, 2026-09-14: "if aify-env is ran inside herdr ... disable p show console and enter
// attach from when it is inside herdr, they are kind of pointless in that case."
//
// THE SIGNAL IS THE PANE OPENER, NOT `HERDR_ENV`. A daemon started from an ordinary Herdr pane has
// `HERDR_ENV` too, but opens no spaces -- there the console and attach are still the only way in.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ConsoleSession } from "../lib/console-session.mjs";
import { startDaemonView } from "../lib/daemon-view.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const tty = () => ({ isTTY: true, columns: 120, rows: 40 });

async function viewOptions(extra) {
  const calls = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r", stdout: tty(), stdin: tty(),
    start: async (options) => { calls.push(options); return { stop() {} }; }, ...extra,
  });
  return calls[0];
}

test("A DAEMON THAT OPENS SPACES offers no attach and no console", async () => {
  const options = await viewOptions({ herdrSpaces: true });
  assert.deepEqual(options.actions, ["stop"]);
  assert.equal(options.withoutConsole, true);
  // POSITIVE CONTROL: an ordinary daemon keeps both.
  const ordinary = await viewOptions({});
  assert.deepEqual(ordinary.actions, ["attach", "stop"]);
  assert.ok(!ordinary.withoutConsole);
});

test("THE DAEMON PASSES WHETHER IT OPENS SPACES, read rather than run because importing it starts one", () => {
  const source = readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  assert.match(source, /startDaemonView\(\{[\s\S]*?herdrSpaces: Boolean\(paneOpener\)/);
});

function session(extra = {}) {
  const followers = [];
  const s = new ConsoleSession({ makeFollower: (id) => { followers.push(id); return { stop() {}, lines: () => [] }; }, ...extra });
  s.noteViewport({ columns: 120 });
  s.syncProcesses([{ id: "p1", label: "alpha", terminal: true }]);
  return { s, followers };
}

test("`p` AND ENTER DO NOTHING without a console, and no stream is opened", () => {
  const { s, followers } = session({ withoutConsole: true });
  s.handleInput("p");
  assert.equal(s.focus.paneHidden, true, "p showed a console");
  const entered = s.handleInput("\r");
  assert.equal(s.focus.mode, "dashboard", "Enter attached");
  assert.equal(entered.action, null);
  assert.deepEqual(followers, [], "a console stream was opened");
  // POSITIVE CONTROL: with a console, `p` shows it and opens its stream.
  const normal = session();
  normal.s.handleInput("p");
  assert.equal(normal.s.focus.paneHidden, false);
  assert.deepEqual(normal.followers, ["p1"]);
});

test("THE HINTS DO NOT OFFER what the keys will not do", () => {
  const render = (withoutConsole) => renderDashboard({
    version: "0", build: "b", endpoint: "e", services: [], checks: [], history: { startedTotal: 1 },
    terminals: { available: true }, processes: [{ id: "p1", label: "alpha", terminal: true }],
  }, {
    columns: 200, color: false, keys: { enabled: true, canQuit: false },
    view: { rows: [{ id: "p1", label: "alpha", terminal: true }], selected: 0, mode: "dashboard", query: "", withoutConsole },
  }).join("\n");
  assert.doesNotMatch(render(true), /p (show|hide) console|enter attach/);
  assert.match(render(false), /p show console/);
  assert.match(render(false), /enter attach/);
});
