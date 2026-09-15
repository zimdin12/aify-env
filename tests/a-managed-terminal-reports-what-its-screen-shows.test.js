// A managed terminal tells the service what its screen shows: working, idle or blocked.
//
// WHY. The service's status for a managed agent came from hook events and its turn bookkeeping, and
// a lost turn-end left an agent reading `working` for as long as nothing else arrived. Herdr's pane
// dot, reading the same runtime's screen, was right. This host already keeps a headless screen per
// PTY (the checkpoint), so it evaluates Herdr's rules against that screen and reports the result.
//
// THE REAL PATH. Every test here runs bytes through the real Runner and the real checkpoint -- the
// emulator the host actually keeps -- behind a scripted terminal, so the screen text the rules see is
// the text this host would read from a live worker. The screens are synthetic: none is copied from a
// real session.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Runner } from "../lib/runner.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";
import { loadCheckpointFactory } from "../lib/screen-checkpoint.mjs";
import { screenText } from "../lib/plugins/aify-comms/screen-rules.mjs";
import { createHandleBook, runOneControl, runTerminalControlPass } from "../lib/plugins/aify-comms/terminal-controls.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join("\n");
const SPEC = { service: "aify-comms", fileText: ALLOWED, command: "fake", args: [] };
const RULE = "─".repeat(60);
const title = (text) => `${ESC}]0;${text}${BEL}`;
const clear = `${ESC}[2J${ESC}[H`;

function fakeTerminal({ cols, rows }) {
  const handlers = [];
  const exits = [];
  return {
    pid: 0, cols, rows,
    onData: (fn) => handlers.push(fn),
    emit(text) { for (const fn of handlers) fn(text); },
    onExit: (fn) => exits.push(fn),
    exit() { for (const fn of exits) fn({ exitCode: 0, signal: 0 }); },
    write: () => {}, kill: () => {},
    resize(c, r) { this.cols = c; this.rows = r; },
  };
}

async function waitFor(predicate, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

// ── the host's half: screen text from the checkpoint ───────────────────────────────────────────

test("POSITIVE CONTROL: the headless emulator is installed, so a real checkpoint is under test", async () => {
  assert.equal(typeof await loadCheckpointFactory(), "function");
});

test("the checkpoint hands over its rows as text, with the title and progress the process set", async () => {
  const terminal = fakeTerminal({ cols: 40, rows: 6 });
  const processes = new PluginProcesses(new Runner({ openTerminal: () => terminal }));
  const { id } = await processes.start(SPEC);

  terminal.emit(`${title("✳ Claude Code")}${ESC}]9;4;0;${BEL}hello   \r\n日本 x\r\n`);
  let seen = await processes.screenText(id);
  assert.equal(screenText(seen.rows), "hello\n日本 x\n", "a wide character must not leave a spacer behind");
  assert.equal(seen.rows.length, 6, "the whole viewport, not only the rows with content");
  assert.equal(seen.title, "✳ Claude Code");
  assert.equal(seen.progress, "4;0;");

  // Herdr's sanitising: control characters are dropped, and an empty title clears the last one.
  terminal.emit(`${ESC}]2;a${String.fromCharCode(1)}b${BEL}`);
  seen = await processes.screenText(id);
  assert.equal(seen.title, "ab");
  terminal.emit(title(""));
  seen = await processes.screenText(id);
  assert.equal(seen.title, "");
});

test("no checkpoint means no screen, and an unknown process has none either", async () => {
  const terminal = fakeTerminal({ cols: 40, rows: 6 });
  const runner = new Runner({ openTerminal: () => terminal, loadCheckpoint: null });
  const { id } = await runner.start(SPEC);
  assert.equal(await runner.screenText(id), null);
  assert.equal(await runner.screenText("nobody"), null);
});

// ── the plugin's half: evaluate, report transitions, repeat on every liveness frame ────────────

const IDLE_BOX = `${clear}${title("✳ task")}${RULE}\r\n❯\r\n${RULE}\r\n  ? for shortcuts\r\n`;
const WORKING = `${title("⠂ task")}`;
const BLOCKED = `${clear}${title("✳ task")} Bash command\r\n\r\n   ls\r\n\r\n Do you want to proceed?\r\n`
  + " ❯ 1. Yes\r\n   2. No\r\n\r\n Esc to cancel · Tab to amend · ctrl+e to explain\r\n";

async function managedTerminal(runtime) {
  const terminal = fakeTerminal({ cols: 80, rows: 16 });
  const runner = new Runner({ openTerminal: () => terminal });
  const processes = new PluginProcesses(runner);
  const handles = createHandleBook();
  const frames = [];
  const api = {
    async launch() { return { launch: { argv: ["worker"], cwd: "/w", agentId: "a1", runtime } }; },
    async reportControl() {},
    async claimControls() { return { controls: [] }; },
    async terminalOutput(terminalId, body) { frames.push({ terminalId, ...body }); return { ok: true, terminal: { status: "attached" } }; },
  };
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start", cols: 80, rows: 16 },
    api, processes, handles, cwdRoots: ["/w"], windows: false,
    withinRoots: () => true,
    buildSpec: () => ({ spec: SPEC }),
    resolveCandidates: () => ["/bin/worker"],
    baseEnv: {},
    sender: { send() {}, async drained() { return true; }, forget() {} },
  });
  assert.equal(result.outcome, "started");
  const reported = () => frames.filter((f) => f.activity).map((f) => f.activity.state);
  const pass = () => runTerminalControlPass({
    api, processes, environmentId: "e", handles, withinRoots: () => true,
    buildSpec: () => ({}), resolveCandidates: () => [],
  });
  return { terminal, runner, processes, handles, frames, reported, pass };
}

test("a scripted claude screen goes idle, working, blocked, idle -- and each is reported once, in order", async () => {
  const { terminal, handles, frames, reported, pass } = await managedTerminal("claude-code");

  terminal.emit(IDLE_BOX);
  assert.ok(await waitFor(() => reported().length === 1), `idle was not reported: ${JSON.stringify(reported())}`);
  terminal.emit(WORKING);
  assert.ok(await waitFor(() => reported().length === 2), `working was not reported: ${JSON.stringify(reported())}`);
  // A spinner repaints its title many times a second; the state it shows is still one state.
  for (const frame of ["⠄", "⠆", "⠇", "⠋", "⠙"]) {
    terminal.emit(`${title(`${frame} task`)}✻ Thinking… (3s · esc to interrupt)\r`);
    await new Promise((r) => setTimeout(r, 120));
  }
  terminal.emit(BLOCKED);
  assert.ok(await waitFor(() => reported().length === 3), `blocked was not reported: ${JSON.stringify(reported())}`);
  terminal.emit(IDLE_BOX);
  assert.ok(await waitFor(() => reported().length === 4), `idle was not reported again: ${JSON.stringify(reported())}`);

  // Let every pending evaluation settle, then check nothing repeated.
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(reported(), ["idle", "working", "blocked", "idle"]);
  const transitions = frames.filter((f) => f.activity);
  assert.deepEqual(transitions.map((f) => f.activity.rule),
    ["live_prompt_box", "osc_title_working", "bash_permission_prompt", "live_prompt_box"]);
  for (const frame of transitions) {
    assert.equal(frame.terminalId, "term-1");
    assert.equal(frame.output, "", "a transition is a liveness frame and carries no output");
    assert.equal("status" in frame, false, "a transition must never carry a status");
    assert.ok(!Number.isNaN(Date.parse(frame.activity.observedAt)), "observedAt is a timestamp");
  }

  // EVERY LIVENESS FRAME REPEATS THE CURRENT OBSERVATION, so a service that missed a transition
  // POST catches up on the next pass.
  frames.length = 0;
  await pass();
  const liveness = frames.find((f) => f.terminalId === "term-1");
  assert.equal(liveness?.activity?.state, "idle", "the liveness frame did not carry the observation");
  assert.equal(handles.activityFor("term-1")?.state, "idle");
});

test("a working screen that goes plainly idle is HELD before idle is reported (Herdr's pending-idle)", async () => {
  const { terminal, reported } = await managedTerminal("claude-code");
  terminal.emit(WORKING);
  assert.ok(await waitFor(() => reported().length === 1));
  // Past the throttle, so what follows is timed by the hold alone.
  await new Promise((r) => setTimeout(r, 300));
  // No title, nothing on screen: idle only by fallback, with no visible idle signal.
  terminal.emit(`${clear}${title("")}`);
  const heldFrom = Date.now();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(reported(), ["working"], "a plain idle was reported without the hold");
  assert.ok(await waitFor(() => reported().length === 2, 2000), "the held idle was never reported");
  assert.deepEqual(reported(), ["working", "idle"]);
  assert.ok(Date.now() - heldFrom >= 250, "the hold did not wait for its confirmations");
});

test("a VISIBLE idle signal is not held: the prompt box is reported at once", async () => {
  const { terminal, reported } = await managedTerminal("claude-code");
  terminal.emit(WORKING);
  assert.ok(await waitFor(() => reported().length === 1));
  await new Promise((r) => setTimeout(r, 300));
  const at = Date.now();
  terminal.emit(IDLE_BOX);
  assert.ok(await waitFor(() => reported().length === 2));
  assert.ok(Date.now() - at < 200, `a visible idle waited ${Date.now() - at}ms, as long as a held one`);
});

test("a runtime with no manifest reports nothing, and its liveness frame carries no activity", async () => {
  const { terminal, frames, reported, pass } = await managedTerminal("opencode");
  terminal.emit(IDLE_BOX);
  terminal.emit(WORKING);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(reported(), []);
  await pass();
  const liveness = frames.find((f) => f.terminalId === "term-1");
  assert.ok(liveness, "POSITIVE CONTROL: the liveness frame was sent");
  assert.equal("activity" in liveness, false);
});

test("the observation goes with the terminal: after exit nothing is evaluated or reported", async () => {
  const { terminal, handles, reported, processes } = await managedTerminal("claude-code");
  terminal.emit(IDLE_BOX);
  assert.ok(await waitFor(() => reported().length === 1));
  let readsAfterExit = 0;
  let exited = false;
  const readScreen = processes.screenText.bind(processes);
  processes.screenText = (id) => { if (exited) readsAfterExit += 1; return readScreen(id); };
  terminal.emit(WORKING);
  terminal.exit();
  exited = true;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(readsAfterExit, 0, "a gone terminal's screen was still being read");
  assert.equal(handles.activityFor("term-1"), null, "a forgotten terminal still holds an observation");
  assert.deepEqual(reported(), ["idle"], "an observation was reported for a terminal that had exited");
});
