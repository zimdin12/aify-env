#!/usr/bin/env node
// The view: services, owned processes, and this environment's own traffic.
//
// Rendering is a pure function from a snapshot to lines. That is not ceremony — it is what lets the
// one rule that matters here be a test rather than a review comment: THE VIEW MAY NOT CLAIM ANYTHING
// ABOUT AGENTS. aify-env knows which processes it started and whether they are alive. Alive is not
// working, and a status column here would make this a second place answering a question that already
// has an owner.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_NOTICE_ROWS, renderDashboard } from "../lib/tui.mjs";

const SNAPSHOT = {
  version: "0.6.0",
  endpoint: "http://127.0.0.1:8801",
  terminals: { available: false, reason: "node-pty did not load" },
  services: [
    { name: "aify-comms", endpoint: "http://127.0.0.1:8800", state: "passed", detail: "reports healthy" },
    { name: "aify-graph", endpoint: "http://127.0.0.2:2", state: "unanswered", detail: "no answer" },
  ],
  processes: [
    { id: "p1", pid: 4242, service: "aify-comms", terminal: true, uptimeMs: 65_000 },
  ],
  unknown: [],
  traffic: { requests: 12, bytesOut: 34_567 },
};

const render = (overrides = {}) => renderDashboard({ ...SNAPSHOT, ...overrides }).join("\n");

test("THE ACTIVITY DOT'S COLUMN IS NAMED, so a grey circle is not read as 'offline'", () => {
  // The operator reported this as a bug: "claude agents status dot is not green even tho they are
  // online". IT WAS NOT A BUG. Measured 2026-09-08 against the live daemon over 12 samples: every
  // working row had output 0.0-1.6s old and the one grey row had been silent for 308 seconds, so the
  // mark was correct and the COLUMN WAS MUTE -- headed by an empty string.
  //
  // A column of symbols with no header invites the reader to supply a meaning, and "is it alive" is
  // the meaning they reach for. This one is about OUTPUT. Naming it costs three characters and is the
  // whole fix; pinned here because an empty header is invisible in a diff and reads as deliberate.
  const now = Date.now();
  // `nowMs` IS PART OF THE SNAPSHOT, not read from the clock inside the renderer -- which is what
  // keeps this a pure function. Omitting it makes `activityOf` answer `unknown` and the column render
  // BLANK, which would have made the header assertion below pass against no marks at all.
  const view = render({
    nowMs: now,
    processes: [
      { id: "busy", pid: 1, service: "s", terminal: true, uptimeMs: 1000, lastOutputAtMs: now },
      { id: "idle", pid: 2, service: "s", terminal: true, uptimeMs: 1000, lastOutputAtMs: now - 300_000 },
    ],
  });
  assert.match(view, /\bOUT\b/, "the activity column has no header, so its dot means whatever the reader guesses");

  // POSITIVE AND NEGATIVE CONTROL TOGETHER: the header would be worth nothing if both rows carried
  // the same mark, and the marks would be worth nothing without a header to explain them.
  const busy = view.split("\n").find((l) => l.includes("busy"));
  const idle = view.split("\n").find((l) => l.includes("idle"));
  assert.ok(busy.includes("\u25cf"), `a process that just printed is not marked as producing: ${busy}`);
  assert.ok(idle.includes("\u25cb"), `a process silent for five minutes is not marked as quiet: ${idle}`);
});

// -- the actions menu ----------------------------------------------------------------------------

const FLEET = [
  { id: "p1", pid: 1, service: "s", terminal: true, uptimeMs: 1000, label: "alpha" },
  { id: "p2", pid: 2, service: "s", terminal: true, uptimeMs: 1000, label: "bravo" },
  { id: "p3", pid: 3, service: "s", terminal: true, uptimeMs: 1000, label: "charlie" },
];
const withKeys = (view) => renderDashboard(
  { ...SNAPSHOT, processes: FLEET, nowMs: Date.now() },
  // THE VIEW IS TOLD WHAT ITS CALLER OFFERS. The menu draws that, not the vocabulary, so a render
  // test showing `stop` has to declare a caller that can perform one.
  { keys: { enabled: true, canQuit: true },
    view: { rows: FLEET, query: "", menuActions: ["attach", "restart", "stop"], ...view } },
).join("\n");

test("THE MENU NAMES THE AGENT IT WILL ACT ON", () => {
  // "stop" with no subject is the shape of every incident where somebody ended the wrong thing, and
  // the row it refers to may have scrolled out of the window by the time it is read.
  const view = withKeys({ mode: "menu", selected: 1, menuAt: 0 });
  assert.match(view, /actions for bravo/);
  assert.match(view, /attach/);
  assert.match(view, /restart/);
  assert.match(view, /stop/);
});

test("THE TARGET COMES FROM THE FULL LIST, not the visible window", () => {
  // `shown` is windowed around the selection, so indexing it with an absolute `selected` names the
  // wrong agent the moment the table scrolls -- the row-shift defect again, on the one screen whose
  // whole job is to say what it is about to stop.
  const view = withKeys({ mode: "menu", selected: 2, menuAt: 0, window: { start: 1, end: 3 } });
  assert.match(view, /actions for charlie/, "the menu named the wrong agent under a scrolled table");
});

test("THE CONFIRMATION STATES THE VERB AND THE SUBJECT, and how to refuse", () => {
  const view = withKeys({ mode: "confirm", selected: 1, confirming: "stop" });
  assert.match(view, /stop bravo\?/);
  assert.match(view, /y to confirm, any other key cancels/);
});

test("`q quit` IS NOT OFFERED where q does not quit", () => {
  // In a menu `q` is swallowed so the list behind cannot be acted on; at a confirmation it is one of
  // the keys that CANCELS. Naming it in either would be a hint that lies -- which this file's own
  // header says is how an operator learns to stop reading them.
  assert.ok(!withKeys({ mode: "menu", selected: 0, menuAt: 0 }).includes("q quit"));
  assert.ok(!withKeys({ mode: "confirm", selected: 0, confirming: "stop" }).includes("q quit"));
  // POSITIVE CONTROL: it IS offered where it works, or this assertion would pass on a view that
  // never mentions quitting at all.
  assert.ok(withKeys({ mode: "dashboard", selected: 0 }).includes("q quit"));
});

test("the hints say what each mode actually accepts", () => {
  assert.match(withKeys({ mode: "menu", selected: 0, menuAt: 0 }), /enter.{0,12}run it/);
  assert.match(withKeys({ mode: "confirm", selected: 0, confirming: "stop" }), /y.{0,8}do it/);
  assert.match(withKeys({ mode: "dashboard", selected: 0 }), /m.{0,10}actions/);
});

test("NEGATIVE CONTROL: no menu is drawn in ordinary dashboard mode", () => {
  // Without this, a renderer that always drew the menu would satisfy every assertion above.
  assert.ok(!withKeys({ mode: "dashboard", selected: 1 }).includes("actions for"));
});

test("registered services are listed with what they said about themselves", () => {
  const view = render();
  assert.match(view, /aify-comms/);
  assert.match(view, /reports healthy/);
});

test("a SILENT service is shown as unanswered, not as down", () => {
  // The distinction a viewer acts on: silent may mean uninstalled or switched off, and showing it as
  // broken sends somebody to debug a service that is simply not running today.
  // Asserted on the service's OWN ROW rather than on the order two words happen to appear in. The
  // first version matched /aify-graph.*unanswered/, which broke when the state column moved ahead of
  // the name -- an ordering the contract never cared about.
  const row = renderDashboard(SNAPSHOT).find((line) => line.includes("aify-graph"));
  assert.ok(row, "the service is not shown at all");
  assert.match(row, /unanswered/);
  assert.doesNotMatch(row, /down|failed|broken/);
});

test("owned processes are shown with pid and owning service", () => {
  const view = render();
  assert.match(view, /4242/);
  assert.match(view, /p1/);
});

test("THE VIEW CLAIMS NO AGENT STATUS, whatever is in the snapshot", () => {
  // The boundary, enforced rather than remembered. Even handed agent fields, the view must not render
  // them: two components deriving status is how two answers start disagreeing.
  const view = renderDashboard({
    ...SNAPSHOT,
    processes: [{ ...SNAPSHOT.processes[0], agentStatus: "working", agentId: "coder-1" }],
  }).join("\n");
  assert.doesNotMatch(view, /working/i);
  assert.doesNotMatch(view, /coder-1/);
});

test("processes the reaper could not judge are shown, not hidden", () => {
  // Kept rather than reaped is the right call and an invisible one; this is where it stops being
  // invisible.
  const view = render({ unknown: [{ id: "p7", pid: 991 }] });
  assert.match(view, /p7/);
  assert.match(view, /unknown|could not/i);
});

test("no terminal support is stated in the view, not left to be discovered", () => {
  const view = render();
  assert.match(view, /terminal/i);
  assert.match(view, /node-pty/);
});

test("traffic is this environment's OWN io, and is labelled as such", () => {
  const view = render();
  assert.match(view, /12/);
  assert.ok(/req|request/i.test(view));
});

test("an empty host renders without throwing and says it is empty", () => {
  // A fresh machine is the first thing anybody sees, and a view that renders a blank rectangle there
  // is a view that looks broken exactly when somebody is checking whether it works.
  const view = renderDashboard({
    version: "0.6.0",
    endpoint: "http://127.0.0.1:8801",
    terminals: { available: true, reason: "" },
    services: [],
    processes: [],
    unknown: [],
    traffic: { requests: 0, bytesOut: 0 },
  }).join("\n");
  assert.match(view, /no services/i);
  // The PROCESSES line no longer says "no processes": an empty list now names WHICH empty it is,
  // after the operator read the old wording as a fault while the environment was merely idle. The
  // property this test was protecting is unchanged and asserted directly -- a fresh host renders a
  // sentence, not a blank rectangle.
  assert.match(view, /no spawn has reached it yet/);
  const lines = view.split(String.fromCharCode(10));
  const processesLine = lines[lines.findIndex((l) => l.includes("PROCESSES")) + 1];
  assert.ok(processesLine && processesLine.trim().length > 10, "the panel rendered blank");
});

test("rendering is pure: the same snapshot renders identically twice", () => {
  // Anything time-derived inside would make the view flicker and make this test flaky, which is the
  // early warning that a clock crept in.
  assert.deepEqual(renderDashboard(SNAPSHOT), renderDashboard(SNAPSHOT));
});

// ── A view an operator can actually read ──────────────────────────────────────────────
//
// The first version of this dashboard was padded plain text: no colour, fixed-width padding that
// misaligned the moment a value was longer than the guess, no column headers, and no truncation, so a
// long detail wrapped and broke the layout. The operator's verdict was that it was not a TUI. These
// pin what makes it one.

const ESCAPE = String.fromCharCode(27);
const OWNED = {
  version: "0.6.0", endpoint: "http://127.0.0.1:8802",
  terminals: { available: true, reason: "" }, services: [], unknown: [],
  processes: [
    { id: "p2", pid: 129340, service: "aify-comms", terminal: true, uptimeMs: 412000,
      label: "probe-one", title: "claude - C:/Docker/aify-comms" },
    { id: "p3", pid: 7, service: "aify-comms", terminal: false, uptimeMs: 65000, label: "", title: "" },
  ],
  traffic: { requests: 167, bytesOut: 126175 },
};

test("a process row names the agent the caller gave it", () => {
  // `p2  pid 129340  aify-comms` cannot tell an operator WHICH agent that is, which is what they asked.
  const row = renderDashboard(OWNED).find((line) => line.includes("129340"));
  assert.match(row, /probe-one/);
});

test("a process with no label renders a placeholder, not an empty column", () => {
  const row = renderDashboard(OWNED).find((line) => line.includes(" 7 "));
  assert.ok(row, "the unlabelled process vanished");
  assert.ok(!/undefined|null/.test(row), row);
});

test("the terminal title the process set is shown", () => {
  const row = renderDashboard(OWNED).find((line) => line.includes("129340"));
  assert.match(row, /claude - C:/);
});

test("uptime is rendered from the field the collector supplies", () => {
  // It read `uptimeMs` while the registry only stored `startedAtMs`, so every row showed "up -".
  const row = renderDashboard(OWNED).find((line) => line.includes("129340"));
  assert.match(row, /6m/);
});

test("no escape sequence appears when colour is off", () => {
  // The default suits a pipe. Escapes in captured output are noise somebody has to strip again.
  const view = renderDashboard(OWNED).join("\n");
  assert.ok(!view.includes(ESCAPE), "an escape reached a non-colour render");
});

test("colour is applied only when asked for", () => {
  const view = renderDashboard(OWNED, { color: true }).join("\n");
  assert.ok(view.includes(ESCAPE), "colour was requested and none was applied");
});

test("columns line up once escapes are removed", () => {
  // The whole point of measuring width rather than counting characters: a coloured cell is longer in
  // bytes and identical on screen, and padding that counts the escapes misaligns every row after it.
  const plain = (line) => line.split(ESCAPE).join("").replace(/\[[0-9;]*m/g, "");
  const coloured = renderDashboard(OWNED, { color: true }).map(plain);
  const mono = renderDashboard(OWNED, { color: false });
  const rows = (lines) => lines.filter((l) => /129340|\s7\s/.test(l));
  assert.deepEqual(rows(coloured).map((l) => l.length), rows(mono).map((l) => l.length));
});

test("a long value is clipped rather than allowed to wrap", () => {
  const wide = {
    ...OWNED,
    processes: [{ ...OWNED.processes[0], title: "x".repeat(400) }],
  };
  for (const line of renderDashboard(wide, { columns: 100 })) {
    assert.ok(line.length <= 100, `a line ran past the terminal width: ${line.length}`);
  }
});

test("the same snapshot renders identically twice, with and without colour", () => {
  assert.deepEqual(renderDashboard(OWNED), renderDashboard(OWNED));
  assert.deepEqual(renderDashboard(OWNED, { color: true }), renderDashboard(OWNED, { color: true }));
});

// ── notices must never cost the operator their agents ───────────────────────────────────────────
//
// REPORTED FROM THE OPERATOR'S OWN SCREEN. A service restart produced a burst of
// `output not delivered: fetch failed`, the ring filled to twenty, and the fitting loop -- which
// shrank ONLY the process table -- gave the whole overflow to the agents. Three processes were
// running and the view showed one, under twenty rows of the same repeated failure. Their words:
// "i would rather see more agents and less notices, most useful thing in this is that i see what
// agent is working and what not."

const manyProcs = (n) => Array.from({ length: n }, (_, i) => ({
  id: `9d8ad800-p${i}`, pid: 1000 + i, label: `agent-${i}`, service: "aify-comms",
  terminal: true, uptimeMs: 240000, title: "working",
}));
// OLDEST FIRST, as the ring really holds them: `createNotices` pushes and shifts, so index 0 is the
// oldest and the view reverses it. My first fixture had this backwards and failed a correct
// implementation -- a fixture that does not match the producer tests the fixture.
const manyNotices = (n) => Array.from({ length: n }, (_, i) => ({
  atMs: Date.now() - (n - 1 - i) * 1000, count: 1,
  text: `terminal term_${i} output not delivered: fetch failed`,
}));
const fleetSnapshot = (procs, notices) => ({
  ...SNAPSHOT, processes: procs, notices, nowMs: Date.now(),
});
const drawFleet = (procs, notices, rows) => renderDashboard(
  fleetSnapshot(procs, notices),
  { rows, columns: 100, keys: { enabled: true, canQuit: true }, view: { rows: procs, selected: 0 } },
);
const agentRows = (out) => out.filter((line) => /agent-\d/.test(line)).length;
const noticeRows = (out) => out.filter((line) => /not delivered/.test(line)).length;

test("A BURST OF NOTICES DOES NOT COST THE AGENT LIST", () => {
  const procs = manyProcs(12);
  const out = drawFleet(procs, manyNotices(20), 45);
  assert.equal(agentRows(out), 12, "agents were dropped to make room for notices");
  assert.ok(noticeRows(out) <= 10, `notices were not bounded: ${noticeRows(out)} rows`);
});

test("WHEN IT IS GENUINELY TIGHT, NOTICES GO FIRST AND THE AGENTS STAY", () => {
  // The ordering is the whole fix. At a height that cannot hold both, the section the operator opened
  // the view for is the one that survives.
  const procs = manyProcs(12);
  const out = drawFleet(procs, manyNotices(20), 30);
  assert.equal(agentRows(out), 12, "the fitting loop still takes the agents before the notices");
  assert.equal(noticeRows(out), 0, "notices did not yield when there was no room for both");
});

test("POSITIVE CONTROL: notices are shown when there is room", () => {
  // A change that simply deleted the section would satisfy both tests above. This is what stops it.
  const out = drawFleet(manyProcs(3), manyNotices(20), 60);
  assert.ok(noticeRows(out) > 0, "the notices section vanished entirely");
  assert.equal(noticeRows(out), DEFAULT_NOTICE_ROWS,
    "the cap is not the ten the operator asked for");
  assert.equal(DEFAULT_NOTICE_ROWS, 10, "the default moved without the operator asking");
});

test("the heading says the count is a window, not the whole ring", () => {
  // Ten of twenty is a different fact from ten recent, and an operator chasing a failure needs to
  // know there are more behind it.
  const out = drawFleet(manyProcs(2), manyNotices(20), 60).join("\n");
  assert.match(out, /NOTICES.*10 of 20/, "the heading hides that notices were dropped");
});

test("NEWEST FIRST, so a cap keeps the ones being asked about", () => {
  const notices = manyNotices(20);          // index 0 is the newest
  const out = drawFleet(manyProcs(2), notices, 60).join("\n");
  assert.match(out, /term_19 /, "the newest notice was cut");
  assert.doesNotMatch(out, /term_0 /, "an older notice survived while the newest was dropped");
});
