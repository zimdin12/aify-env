// The start list is searched, like the process finder, and takes the table's place (v0.7.7, TUI 1).
//
// THE OPERATOR'S EXAMPLE: "starting agent maybe should open something that has a search". The list
// took arrows and j/k, had no filter, and at 100x24 showed one agent of 18 under the process table.

import assert from "node:assert/strict";
import test from "node:test";

import { initialFocus, quitsOnQ, reconcileFocus, routeKey, typedText } from "../lib/keys.mjs";
import { ConsoleSession } from "../lib/console-session.mjs";
import { matchesQuery, offScreenNote, startListLines, startRowTexts } from "../lib/start-list.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const ENTER = "\r";
const DETACH = String.fromCharCode(29);
const BACKSPACE = String.fromCharCode(127);
const UP = "\x1b[A";
const DOWN = "\x1b[B";

const open = (extra = {}) => ({ ...initialFocus(2), mode: "start", startAt: 0, startCount: 3, startQuery: "", ...extra });

test("letters type into the search, j and k included; arrows move", () => {
  const typed = routeKey("j", open());
  assert.equal(typed.state.startQuery, "j", "j is a letter of an agent's name here");
  assert.equal(typed.action, "start-query");
  assert.equal(routeKey("k", open({ startQuery: "sc-" })).state.startQuery, "sc-k");
  assert.equal(routeKey(DOWN, open()).state.startAt, 1, "CONTROL: an arrow still moves");
  assert.equal(routeKey(DOWN, open()).state.startQuery, "");
  assert.equal(routeKey(UP, open()).state.startAt, 2);
});

test("typing puts the cursor back on the first match", () => {
  assert.equal(routeKey("a", open({ startAt: 2 })).state.startAt, 0);
});

test("backspace deletes, and an escape sequence is not typed", () => {
  assert.equal(routeKey(BACKSPACE, open({ startQuery: "bra" })).state.startQuery, "br");
  assert.equal(routeKey("a\x1b[C", open()).state.startQuery, "a", "a coalesced arrow typed `[C`");
});

test("Ctrl+] closes the list and forgets the search", () => {
  const closed = routeKey(DETACH, open({ startQuery: "br" }));
  assert.equal(closed.state.mode, "dashboard");
  assert.equal(closed.state.startQuery, "");
  assert.equal(routeKey("s", closed.state).state.startQuery, "", "reopening starts with an empty search");
});

test("the search survives a redraw, with and without processes", () => {
  // The rebuild in `reconcileFocus` names every field by hand and has dropped four of them before.
  assert.equal(reconcileFocus(open({ startQuery: "br" }), 2).startQuery, "br");
  assert.equal(reconcileFocus(open({ startQuery: "br" }), 0).startQuery, "br");
});

test("both lists match a search the same way", () => {
  assert.ok(matchesQuery(["sc-Manager", "claude-code"], " MAN "));
  assert.ok(matchesQuery(["anything"], ""), "an empty search matches everything");
  assert.ok(!matchesQuery(["alpha"], "br"), "CONTROL: a non-match is refused");
  const session = new ConsoleSession({ endpoint: "http://127.0.0.2:1", makeFollower: () => ({ start() {}, stop() {} }) });
  session.syncProcesses([{ id: "p1", label: "alpha" }, { id: "p2", label: "Bravo" }]);
  session.focus = { ...session.focus, mode: "picker", query: "BR" };
  assert.deepEqual(session.visible().map((p) => p.label), ["Bravo"], "the process finder uses the same match");
});

function sessionWithAgents() {
  const session = new ConsoleSession({ endpoint: "http://127.0.0.2:1", makeFollower: () => ({ start() {}, stop() {} }) });
  session.syncProcesses([{ id: "p1", label: "zulu" }]);
  session.handleInput("s");
  session.noteStartable([
    { id: "alpha", name: "alpha", status: "available" },
    { id: "bravo", name: "bravo", status: "stopped" },
    { id: "sc-manager", name: "sc-manager", status: "offline" },
  ]);
  return session;
}

test("Enter starts the agent under the cursor in the FILTERED list", () => {
  const session = sessionWithAgents();
  for (const ch of "man") session.handleInput(ch);
  assert.equal(session.focus.startCount, 1, "the count Enter reads is the filtered count");
  const [chosen] = [session.handleInput(ENTER)];
  assert.equal(chosen.startAgent?.id, "sc-manager", `started ${chosen.startAgent?.id}`);
});

test("a search that matches nothing starts nothing", () => {
  const session = sessionWithAgents();
  for (const ch of "zzz") session.handleInput(ch);
  assert.equal(session.handleInput(ENTER).startAgent ?? null, null);
});

test("a paste is typed into the search", () => {
  const session = sessionWithAgents();
  session.handleChunk("\x1b[200~brav\x1b[201~");
  assert.equal(session.focus.startQuery, "brav");
  assert.deepEqual(session.startView().agents.map((a) => a.id), ["bravo"]);
});

const SNAPSHOT = {
  version: "0.7.2", build: "abc", endpoint: "http://127.0.0.1:8802",
  services: [], checks: [], history: { startedTotal: 1 }, terminals: { available: true },
};

test("the list replaces the table, echoes the search and counts N of M", () => {
  const session = sessionWithAgents();
  for (const ch of "br") session.handleInput(ch);
  const text = renderDashboard({ ...SNAPSHOT, processes: [{ id: "p1", label: "zulu", terminal: true }] }, {
    columns: 100, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: [{ id: "p1", label: "zulu" }], selected: 0, mode: "start", query: "", start: session.startView() },
  }).join("\n");
  assert.match(text, /find br▌/);
  assert.match(text, /1 of 3/);
  assert.match(text, /❯ bravo/);
  assert.doesNotMatch(text, /alpha/, "a filtered-out agent is still drawn");
  assert.doesNotMatch(text, /zulu/, "the process table is still drawn under the list");
  assert.match(text, /type.*filter/, "the hint says typing filters");
  assert.match(text, /ctrl\+\] back/);
});

test("q quits only where the router quits, so the hint cannot promise it inside a search", () => {
  assert.equal(quitsOnQ("dashboard"), true, "CONTROL: q quits from the list");
  for (const mode of ["picker", "start", "menu", "confirm", "pty"]) {
    assert.equal(quitsOnQ(mode), false, `q claimed to quit from ${mode}`);
  }
});

test("typedText keeps what precedes an escape and drops control characters", () => {
  assert.equal(typedText("ab\x1b[Ccd"), "ab");
  assert.equal(typedText("a\rb\x03c"), "abc");
  assert.equal(typedText(""), "");
});

test("a row is searched on what it shows: name, id, status and runtime", () => {
  const agent = { id: "sc-mgr", name: "sc-manager", status: "stopped", runtime: "codex" };
  for (const query of ["manager", "sc-mgr", "stopped", "codex"]) {
    assert.ok(matchesQuery(startRowTexts(agent), query), `${query} did not match`);
  }
  assert.ok(!matchesQuery(startRowTexts(agent), "claude"), "CONTROL: a field it does not show matched");
});

test("the list says what is off screen, and nothing when all of it is on", () => {
  assert.deepEqual(offScreenNote(0, 0, false), []);
  assert.match(offScreenNote(2, 5, false).join(""), /2 above, 5 below/);
});

test("a search that matches nothing says so instead of 'nothing to start'", () => {
  const text = startListLines({ agents: [], total: 4, query: "zzz", at: 0, asked: true }, 100, false).join("\n");
  assert.match(text, /0 of 4/);
  assert.match(text, /no match/);
  assert.doesNotMatch(text, /nothing to start/, "a filtered-empty list read as an empty host");
});
