// The view draws the panes ~/.aify/tui.json names, in its order, and says what it could not use (0.9.6).
//
// THE OPERATOR'S ASK, 2026-10-28: panes configurable, "kept somewhere a restart preserves". The file is read when the
// view starts; a missing one is the default view, which must stay exactly what 0.9.5 drew.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderDashboard } from "../lib/tui.mjs";
import { PANES } from "../lib/tui-panes/index.mjs";
import { layoutFrom, readLayout, tuiLayoutPath } from "../lib/tui-layout.mjs";
import { startDashboard } from "../lib/dashboard.mjs";

const SNAPSHOT = {
  version: "0.9.6-dev", endpoint: "http://127.0.0.1:8802", nowMs: 1_000_000, terminals: { available: true },
  services: [{ name: "aify-comms", state: "passed", endpoint: "http://127.0.0.1:8800", detail: "healthy" }],
  checks: [{ id: "a", state: "passed" }],
  processes: [{ id: "x-p1", pid: 1, label: "worker", service: "aify-comms", terminal: true, uptimeMs: 60_000, title: "t" }],
  history: { recentExits: [{ id: "x-p0", label: "gone", atMs: 990_000, exitCode: 0 }] },
  notices: [{ atMs: 999_000, count: 1, text: "said" }],
  traffic: { requests: 1, bytesOut: 2 },
  // One agent defined and not running, so the ROSTER pane (0.9.7) has something to head.
  agentRecords: { resting: { agentId: "resting", lifetime: null, state: "stopped", stateCause: "operator-stop" } },
};
const HEADINGS = { services: "SERVICES", health: "HEALTH", agents: "PROCESSES", roster: "ROSTER", exits: "RECENT EXITS", notices: "NOTICES", traffic: "TRAFFIC" };
const order = (lines) => lines.map((line) => Object.entries(HEADINGS).find(([, title]) => line.startsWith(title))?.[0]).filter(Boolean);
const draw = (layout) => renderDashboard(SNAPSHOT, { columns: 120, layout });

test("every pane has a heading here, so the order checks below see all of them", () => {
  assert.deepEqual(Object.keys(HEADINGS).sort(), PANES.map((pane) => pane.name).sort());
  assert.deepEqual(order(draw(null)), PANES.map((pane) => pane.name), "the control: no file draws the default order");
});

test("no file, an empty one, or {} is the default view, line for line, with nothing to say", () => {
  const plain = draw(null);
  for (const text of [null, "", "{}"]) {
    const layout = layoutFrom(text);
    assert.deepEqual(layout.problems, [], JSON.stringify(text));
    assert.deepEqual(draw(layout), plain, JSON.stringify(text));
  }
});

test("panes is the order; a known pane it leaves out comes after, in default order", () => {
  const layout = layoutFrom(JSON.stringify({ panes: ["traffic", "agents"] }));
  assert.deepEqual(layout.problems, []);
  assert.deepEqual(order(draw(layout)), ["traffic", "agents", "services", "health", "roster", "exits", "notices"]);
});

test("hidden panes are not drawn, but agents cannot be hidden: its keys act on it", () => {
  const layout = layoutFrom(JSON.stringify({ hidden: ["services", "traffic", "agents"] }));
  assert.deepEqual(order(draw(layout)), ["health", "agents", "roster", "exits", "notices"]);
  assert.deepEqual(layout.problems, ["hidden names agents, which cannot be hidden: its keys act on it"]);
});

test("a reordered view separates its sections once: no two blank lines in a row", () => {
  const lines = draw(layoutFrom(JSON.stringify({ panes: ["traffic", "services", "health", "notices", "exits", "agents"] })));
  for (let at = 1; at < lines.length; at++) assert.ok(lines[at] !== "" || lines[at - 1] !== "", `two blank lines at ${at}`);
});

test("what it cannot use is SAID under the header, and the rest still applies", () => {
  const layout = layoutFrom(JSON.stringify({ panes: ["traffic", "trafic", "traffic"], hidden: "services" }));
  assert.deepEqual(layout.problems, [
    `panes names "trafic", which is not a pane (panes: ${PANES.map((pane) => pane.name).join(", ")})`,
    "panes names traffic twice",
    "hidden is not a list of pane names",
  ]);
  const lines = draw(layout);
  assert.match(lines[2], /^! ~\/\.aify\/tui\.json panes names "trafic"/);
  assert.equal(order(lines)[0], "traffic");
  for (const text of ["{ not json", "[1]", "7"]) {
    const broken = layoutFrom(text);
    assert.equal(broken.problems.length, 1, text);
    assert.deepEqual(order(draw(broken)), PANES.map((pane) => pane.name), text);
  }
});

test("read from <home>/.aify/tui.json: missing is the default, unreadable is the default AND said", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-layout-"));
  try {
    assert.deepEqual(readLayout({ home }), layoutFrom(null));
    fs.mkdirSync(path.dirname(tuiLayoutPath(home)), { recursive: true });
    fs.writeFileSync(tuiLayoutPath(home), JSON.stringify({ hidden: ["traffic"] }));
    assert.deepEqual([...readLayout({ home }).hidden], ["traffic"]);
    const locked = readLayout({ home, readFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
    assert.deepEqual(locked.order, layoutFrom(null).order);
    assert.match(locked.problems[0], /could not be read \(EACCES\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("THE VIEW READS THE FILE when it starts, from this process's home", async () => {
  // This file runs in its own process, so pointing its home at a scratch directory touches no other test.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-tui-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    fs.mkdirSync(path.join(home, ".aify"));
    fs.writeFileSync(tuiLayoutPath(home), JSON.stringify({ hidden: ["services"] }));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const written = [];
    const { stop } = await startDashboard({
      endpoint: "http://127.0.0.1:8802", registryPath: "/registry.json", clearScreen: false, once: true,
      readFile: () => JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://svc:8800" } } }),
      fetchImpl: async () => { throw Object.assign(new Error("ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } }); },
      write: (text) => written.push(text),
    });
    stop();
    assert.match(written.join(""), /HEALTH/, "the control: the view drew");
    assert.doesNotMatch(written.join(""), /SERVICES/, "the hidden pane was drawn: the view never read tui.json");
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
