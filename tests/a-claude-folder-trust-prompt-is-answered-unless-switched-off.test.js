// Claude's folder-trust dialog is answered on a carried terminal's screen, and only as configured.
//
// THE SCREEN IS A REAL ONE. tests/fixtures/claude-2.1.312-folder-trust.json is the byte stream claude 2.1.312 sent when
// started in a folder with no trusted ancestor (2026-10-28, path redacted), rendered here through the host's own
// checkpoint, so the text the answer reads is the text this host would read from a live worker. Its cursor starts on
// "No, exit": a bare Enter there exits the worker, which is the case this file exists to pin.
//
// THE SECOND SCREEN IS NOT. What claude draws after the DOWN was not captured (a further live launch is the operator's
// to approve), so it is the captured screen with the cursor moved one row, drawn as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import os from "node:os";
import path from "node:path";

import { Runner } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses } from "../lib/service-plugins.mjs";
import { loadCheckpointFactory } from "../lib/screen-checkpoint.mjs";
import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";
import { observeScreen } from "../lib/plugins/aify-comms/screen-observer.mjs";
import { screenText } from "../lib/plugins/aify-comms/screen-rules.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { ANSWERS, DOWN, ENTER, ScreenAnswers, autoConfirmSettings, folderTrustAnswer }
  from "../lib/plugins/aify-comms/screen-answers.mjs";

const CAPTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-2.1.312-folder-trust.json", import.meta.url), "utf8"));
const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J${ESC}[H`;
const SPEC = { service: "aify-comms", fileText: ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join("\n"), command: "fake", args: [] };
const ON = () => ({ config: null, problem: "~/.aify/config.json does not exist or is empty", absent: true });

/** The captured bytes, rendered by the checkpoint the host keeps. */
async function capturedScreen() {
  const checkpoint = (await loadCheckpointFactory())({ cols: CAPTURE.cols, rows: CAPTURE.rows });
  checkpoint.feed(CAPTURE.raw);
  return screenText((await checkpoint.text()).rows);
}

/** The same screen with the cursor on the other row. */
function cursorOnYes(screen) {
  return screen.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust this folder", "❯ Yes, I trust this folder");
}

test("POSITIVE CONTROL: the captured bytes render as the dialog, cursor on No, through the host's checkpoint", async () => {
  const screen = await capturedScreen();
  assert.match(screen, /Is this a project you created or one you trust\?/);
  assert.match(screen, /^ ❯ No, exit$/m);
  assert.match(screen, /^ {3}Yes, I trust this folder$/m);
});

test("cursor on No, exit: one DOWN, never Enter -- and on Yes: one Enter", async () => {
  const screen = await capturedScreen();
  assert.deepEqual(folderTrustAnswer(screen), { step: "leave-no", keys: DOWN });
  assert.deepEqual(folderTrustAnswer(cursorOnYes(screen)), { step: "accept-yes", keys: ENTER });
});

test("anything but the whole dialog at the bottom types nothing", async () => {
  const screen = await capturedScreen();
  const cases = {
    "a reworded Yes row": screen.replace("Yes, I trust this folder", "Yes, proceed"),
    "a reworded No row": screen.replace("No, exit", "No, quit"),
    "no cursor on either row": screen.replace("❯ No, exit", "  No, exit"),
    "no key hint under the rows": screen.replace("Enter to confirm · Esc to cancel", ""),
    "the dialog quoted above a live prompt box": `${screen}\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n`,
    "an empty screen": "",
  };
  for (const [name, text] of Object.entries(cases)) assert.equal(folderTrustAnswer(text), null, name);
});

test("settings: absent means on; unreadable, malformed or not a boolean means off, and each says why", () => {
  const on = { folderTrust: true }, off = { folderTrust: false };
  assert.deepEqual(autoConfirmSettings(ON()), { on, problems: [] });
  assert.deepEqual(autoConfirmSettings({ config: {}, problem: "" }), { on, problems: [] });
  assert.deepEqual(autoConfirmSettings({ config: { autoConfirm: {} }, problem: "" }), { on, problems: [] });
  assert.deepEqual(autoConfirmSettings({ config: { autoConfirm: { folderTrust: true } }, problem: "" }), { on, problems: [] });
  assert.deepEqual(autoConfirmSettings({ config: { autoConfirm: { folderTrust: false } }, problem: "" }), { on: off, problems: [] });
  const failing = [
    [null, /no configuration was read/],
    [{ config: null, problem: "~/.aify/config.json is not JSON" }, /is not JSON/],
    [{ config: { autoConfirm: true }, problem: "" }, /autoConfirm is not an object/],
    [{ config: { autoConfirm: { folderTrust: "yes" } }, problem: "" }, /folderTrust is not true or false/],
  ];
  for (const [read, why] of failing) {
    const settings = autoConfirmSettings(read);
    assert.deepEqual(settings.on, off, JSON.stringify(read));
    assert.match(settings.problems.join("; "), why);
  }
  // An unknown key is reported and changes nothing else.
  const typo = autoConfirmSettings({ config: { autoConfirm: { folderTrus: false } }, problem: "" });
  assert.deepEqual(typo.on, on);
  assert.match(typo.problems[0], /folderTrus is not an answer this host gives \(it gives: folderTrust\)/);
  assert.deepEqual(Object.keys(ANSWERS), ["folderTrust"]);
});

test("each step is taken once: a DOWN that did not move the cursor is not repeated", async () => {
  const screen = await capturedScreen();
  const writes = [];
  const watch = new ScreenAnswers({ config: ON, write: (handle, keys) => { writes.push([handle, keys]); return { ok: true }; } })
    .forTerminal("term-1", "proc-1");
  watch(screen);
  watch(screen);
  watch(cursorOnYes(screen));
  watch(cursorOnYes(screen));
  watch(screen);
  assert.deepEqual(writes, [["proc-1", DOWN], ["proc-1", ENTER]]);
});

test("switched off, or with no configuration reader, nothing is typed", async () => {
  const screen = await capturedScreen();
  const readers = {
    "folderTrust false": () => ({ config: { autoConfirm: { folderTrust: false } }, problem: "" }),
    "an unreadable file": () => ({ config: null, problem: "~/.aify/config.json could not be read: EACCES" }),
    "no reader at all": undefined,
  };
  for (const [name, config] of Object.entries(readers)) {
    const writes = [];
    const watch = new ScreenAnswers({ config, write: (...args) => { writes.push(args); return { ok: true }; } }).forTerminal("t", "p");
    watch(screen);
    watch(cursorOnYes(screen));
    assert.deepEqual(writes, [], name);
  }
});

test("THE REAL PATH: a carried claude terminal at the dialog gets DOWN, then Enter once the cursor is on Yes", async () => {
  const writes = [];
  const terminal = {
    pid: 0, cols: CAPTURE.cols, rows: CAPTURE.rows, handlers: [],
    onData(fn) { this.handlers.push(fn); }, emit(text) { for (const fn of this.handlers) fn(text); },
    onExit() {}, write: (data) => writes.push(data), kill() {}, resize() {},
  };
  const runner = new Runner({ openTerminal: () => terminal,
    managedHost: () => ({ instance: "default", url: "http://127.0.0.1:1", host: { startManaged() {}, endManaged: () => ({ problem: "" }) } }) });
  const processes = new PluginProcesses(runner);
  const log = [];
  const answers = new ScreenAnswers({ config: ON, write: (handle, keys) => processes.write(handle, keys), log: (m) => log.push(m) });
  const api = {
    async launch() { return { launch: { argv: ["worker"], cwd: "/w", agentId: "a1", runtime: "claude" } }; },
    async reportControl() {},
    async terminalOutput() { return { ok: true, terminal: { status: "attached" } }; },
  };
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start", cols: CAPTURE.cols, rows: CAPTURE.rows },
    api, processes, handles: createHandleBook(), cwdRoots: ["/w"], windows: false, withinRoots: () => true,
    buildSpec: () => ({ spec: SPEC }), resolveCandidates: () => ["/bin/worker"], baseEnv: {},
    sender: { send() {}, async drained() { return true; }, forget() {} }, answers,
  });
  assert.equal(result.outcome, "started");
  const waitFor = async (predicate) => {
    for (const until = Date.now() + 3000; Date.now() < until && !predicate();) await new Promise((r) => setTimeout(r, 10));
    return predicate();
  };

  terminal.emit(CAPTURE.raw);
  assert.ok(await waitFor(() => writes.length === 1), `no DOWN: ${JSON.stringify(writes)}`);
  assert.deepEqual(writes, [DOWN]);
  const moved = cursorOnYes(await capturedScreen());
  terminal.emit(`${CLEAR}${moved.split("\n").join("\r\n")}`);
  assert.ok(await waitFor(() => writes.length === 2), `no Enter: ${JSON.stringify(writes)}`);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(writes, [DOWN, ENTER]);
  assert.deepEqual(log, ["terminal term-1: answered folderTrust (leave-no)", "terminal term-1: answered folderTrust (accept-yes)"]);
});

test("an answer that throws is contained: the screen's state is still reported", async () => {
  const screen = await capturedScreen();
  const reported = [];
  const observer = observeScreen({
    runtime: "claude", read: async () => ({ rows: screen.split("\n"), title: "", progress: "" }),
    report: async (activity) => { reported.push(activity.state); },
    onScreen: () => { throw new Error("an answer failed"); }, schedule: (fn) => { setImmediate(fn); return {}; }, cancel: () => {},
  });
  observer.noteOutput("x");
  for (let i = 0; i < 20 && !reported.length; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(reported, ["blocked"]);
  observer.dispose?.();
});

test("THE PLUGIN WIRES IT: the comms plugin answers on a terminal it started, from its own config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-env-trust-"));
  fs.writeFileSync(path.join(dir, "worker-aify"), SPEC.fileText);
  const writes = [];
  const reports = [];
  const listeners = [];
  const screen = await capturedScreen();
  let handedOut = false;
  const api = {
    identity: { bridgeId: "b1" },
    async heartbeat() { return {}; }, async claim() { return {}; },
    async claimControls() {
      if (handedOut) return { controls: [] };
      handedOut = true;
      return { controls: [{ id: "ctl-1", terminalId: "term-1", action: "start" }] };
    },
    async launch() { return { launch: { argv: [path.join(dir, "worker-aify")], cwd: dir, agentId: "a1", runtime: "claude" } }; },
    async reportControl(id, patch) { reports.push({ id, ...patch }); }, async terminalOutput() { return { ok: true }; },
  };
  const runner = {
    async start() { return { id: "proc-1", pid: 9 }; },
    subscribe(_id, onOutput) { listeners.push(onOutput); return () => {}; },
    screenText: async () => ({ rows: screen.split("\n"), title: "", progress: "" }),
    write(id, data) { writes.push([id, data]); return { ok: true }; },
    canStream() { return true; }, resize() {}, async stop() {}, relabel() {}, list() { return []; },
  };
  const plugin = createCommsPlugin({
    endpoint: "http://127.0.0.1:1", advertisement: async () => ({ hostname: "h", kind: "linux" }), cwdRoots: async () => [dir],
    windows: false, platform: "linux", api, readFile: () => SPEC.fileText, config: ON,
    setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
  });
  try {
    await plugin.start(new PluginHost({ processes: new PluginProcesses(runner), credential: async () => "" }));
    for (const until = Date.now() + 3000; Date.now() < until && !listeners.length;) await new Promise((r) => setTimeout(r, 5));
    assert.equal(listeners.length, 1, `the plugin never carried the terminal it started: ${JSON.stringify(reports)}`);
    listeners[0]("output");
    for (const until = Date.now() + 3000; Date.now() < until && !writes.length;) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(writes, [["proc-1", DOWN]]);
  } finally {
    await plugin.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
