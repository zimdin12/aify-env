// The 0.9.8b view split, judged by behaviour: one scripted run of the OLD startDashboard (a git ref) and the NEW one (the
// working tree), with the same fake daemon, keyboard, clock and callbacks, comparing every byte written, every callback
// the view made (with the process each action names) and every call on the terminal and the process. Plus a negative
// control in the same run.
//
//   node differential.mjs <repo> <old-ref>
//
// SANDBOXED: the home is a fresh temp directory before anything runs, because `v`, `o` and the pane menu write
// ~/.aify/tui.json. Timers are this file's own (the view's interval, its pane repaint and its paste flush all run on
// them), so both runs see the same moments. Exit 0 when old and new agree and the control differs; 1 otherwise.

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, oldRef] = process.argv.slice(2);
if (!repo || !oldRef) { console.error("usage: node differential.mjs <repo> <old-ref>"); process.exit(64); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-098b-dashboard-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
const lib = path.join(repo, "lib");
const libUrl = (name) => pathToFileURL(path.join(lib, name)).href;
const { readLayout } = await import(libUrl("tui-layout.mjs"));
const { MENU_ACTIONS } = await import(libUrl("menu-actions.mjs"));

// ── the clock: every timer the view sets, fired only when the script advances time ──
const clock = { now: 0, seq: 0, timers: new Map() };
const timer = (fn, ms, every) => {
  const t = { id: ++clock.seq, fn, at: clock.now + Math.max(0, Number(ms) || 0), every, unref() { return t; }, ref() { return t; } };
  clock.timers.set(t.id, t);
  return t;
};
globalThis.setTimeout = (fn, ms) => timer(fn, ms, 0);
globalThis.setInterval = (fn, ms) => timer(fn, ms, Math.max(1, Number(ms) || 1));
globalThis.clearTimeout = (t) => { if (t) clock.timers.delete(t.id); };
globalThis.clearInterval = globalThis.clearTimeout;
const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
async function advance(ms) {
  const until = clock.now + ms;
  for (;;) {
    const due = [...clock.timers.values()].filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    clock.now = due.at;
    if (due.every) due.at += due.every; else clock.timers.delete(due.id);
    due.fn();
    await settle();
  }
  clock.now = until;
}

// ── the daemon: /health with the processes, /agents/state, and a live output stream per process ──
const LF = String.fromCharCode(10);
const world = { processes: [] };
const proc = (id) => ({ id, label: id, title: `${id} at work`, status: "running", pid: 100, startedAt: "2026-10-28T00:00:00.000Z" });
const fetchImpl = async (url) => {
  const text = String(url);
  if (text.includes("/output")) {
    const encoder = new TextEncoder();
    return { ok: true, status: 200, body: (async function* body() {
      yield encoder.encode(`event: meta${LF}data: ${JSON.stringify({ cols: 80, rows: 24, truncated: false, resized: false, replayBytes: 65536 })}${LF}${LF}`);
      yield encoder.encode(`data: ${JSON.stringify(`ready ${text.split("/").at(-2)}`)}${LF}${LF}`);
      await new Promise(() => {});
    })() };
  }
  if (text.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ version: "0.0.0", processes: world.processes.map(proc) }) };
  if (text.endsWith("/agents/state")) return { ok: true, status: 200, json: async () => ({ agents: [] }) };
  return { ok: false, status: 404, json: async () => ({ error: "not here" }) };
};

const ESC = String.fromCharCode(27);
const K = { UP: `${ESC}[A`, DOWN: `${ESC}[B`, ENTER: "\r", DETACH: String.fromCharCode(29), CTRL_C: String.fromCharCode(3),
  CTRL_L: String.fromCharCode(12), TAB: "\t", PASTE_START: `${ESC}[200~`, PASTE_END: `${ESC}[201~` };

/** One run of `startDashboard` through the script; returns everything observable, in order. */
async function run(startDashboard, { label, script, options = {} }) {
  clock.now = 0; clock.seq = 0; clock.timers.clear();
  world.processes = ["alpha", "bravo", "charlie"];
  fs.rmSync(path.join(home, ".aify"), { recursive: true, force: true });
  const log = [];
  class Input extends EventEmitter {
    isRaw = false;
    setRawMode(on) { log.push(["input.raw", on]); this.isRaw = on; return this; }
    resume() { log.push(["input.resume"]); return this; }
    pause() { log.push(["input.pause"]); return this; }
    on(event, fn) { log.push(["input.on", event]); return super.on(event, fn); }
    off(event, fn) { log.push(["input.off", event]); return super.off(event, fn); }
  }
  const input = new Input();
  const notices = { items: [], add(text) { log.push(["notice", text]); this.items.push(text); }, recent() { return this.items.slice(-4); } };
  const view = await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: path.join(home, "no-registry.json"), fetchImpl, nowMs: () => 1_790_000_000_000,
    // NO DISK ON THE COLLECTION PATH: a real read finishes when the thread pool says, which is not a moment the script
    // can name, and the harness's own control measured it moving frames between steps.
    readCredentialStore: async () => ({ names: [] }), readInvocationRegistries: () => [],
    write: (text) => log.push(["write", text]), clearScreen: true, intervalMs: 2000, paneRepaintMs: 80, columns: 120, rows: 40,
    notices, input, actions: MENU_ACTIONS, confirmInterrupt: true, layout: readLayout({ home }),
    processEvents: { on: (event) => log.push(["process.on", event]), off: (event) => log.push(["process.off", event]) },
    onQuit: () => log.push(["quit"]), onInterrupt: () => log.push(["interrupt"]),
    onAction: (perform) => { log.push(["action", perform.action, perform.process?.id]); return { ok: true }; },
    onStartList: async () => { log.push(["start-list"]); return { agents: [{ id: "delta", name: "delta" }, { id: "echo", herdrSpace: false }], service: "aify-comms" }; },
    onStartAgent: async (agent) => { log.push(["start", agent.id]); return { started: true }; },
    onSetHerdrSpace: async (agent, show) => { log.push(["herdr-space", agent.id, show]); return { ok: true }; },
    onInput: (selected, text) => log.push(["to-process", selected?.id, text]),
    ...options,
  });
  await settle();
  const marks = [];
  for (const [name, step] of script) {
    marks.push([name, log.length]);
    await step({ input, view, world });
  }
  view.stop?.();
  return { label, log, marks };
}

const key = (data) => async ({ input }) => { input.emit("data", data); await settle(); };
const tick = async () => advance(2000);
const set = (...ids) => async ({ world: w }) => { w.processes = ids; await tick(); };
const SCRIPT = [
  ["first frames", async () => advance(200)],
  ["down", key(K.DOWN)], ["held arrow", key(`${K.DOWN}${K.UP}`)], ["digit 2", key("2")],
  ["attach bravo", key(K.ENTER)], ["stream arrives", async () => advance(200)], ["type", key("ls")],
  ["paste split", key(`${K.PASTE_START}hel`)], ["paste end", key(`lo${K.PASTE_END}`)],
  ["held marker", key(`${ESC}[20`)], ["quiet flush", async () => advance(200)],
  ["detach", key(K.DETACH)], ["ctrl+L", key(K.CTRL_L)],
  ["a refresh", tick], ["delta appears", set("alpha", "bravo", "charlie", "delta")],
  ["picker", key("g")], ["type ch", key("ch")], ["accept", key(K.ENTER)],
  // THE RACE (lead's review of the design): a state change between `m` and `y`. The view orders rows by name, so the
  // shifts come from agents leaving and arriving ABOVE the subject, which moves every index below them.
  ["to charlie", key("3")], ["menu", key("m")], ["j", key("j")], ["j", key("j")], ["stop?", key(K.ENTER)],
  ["alpha exits above it", set("bravo", "charlie", "delta")], ["aaron arrives above it", set("aaron", "bravo", "charlie", "delta")],
  ["y stops charlie", key("y")], ["answers land", async () => advance(10)],
  ["to delta", key("4")], ["menu", key("m")], ["abel arrives above it", set("abel", "aaron", "bravo", "charlie", "delta")],
  ["attach from menu", key(K.ENTER)], ["stream", async () => advance(200)], ["type into delta", key("x")], ["detach", key(K.DETACH)],
  ["to bravo", key("3")], ["menu", key("m")], ["j", key("j")], ["j", key("j")], ["stop?", key(K.ENTER)],
  ["bravo exits", set("aaron", "abel", "charlie", "delta")], ["y stops nothing", key("y")],
  ["columns", key("v")], ["sort", key("o")], ["sort back", key("o")], ["panes", key("c")], ["collapse services", key("s")],
  ["collapse agents", key("a")], ["expand services", key("s")], ["close panes", key(K.DETACH)],
  ["start list", key("s")], ["list answers", async () => advance(10)], ["down", key(K.DOWN)], ["herdr space", key(K.TAB)],
  ["space answers", async () => advance(10)], ["start echo", key(K.ENTER)], ["start answers", async () => advance(10)],
  ["echo arrives", set("charlie", "bravo", "echo")],
  ["narrow", async ({ view }) => { view.resize({ columns: 70, rows: 30 }); await settle(); }], ["attach refused", key(K.ENTER)],
  ["wide", async ({ view }) => { view.resize({ columns: 140, rows: 44 }); await settle(); }],
  ["hide pane", key("p")], ["show pane", key("p")], ["a refresh", tick],
  ["ctrl+c", key(K.CTRL_C)], ["n", key("n")], ["ctrl+c", key(K.CTRL_C)], ["y", key("y")], ["q", key("q")],
];

const CONFIGS = [
  { label: "a live screen", script: SCRIPT },
  { label: "a pipe", script: SCRIPT, options: { clearScreen: false } },
  { label: "once", script: [], options: { once: true } },
];

const loadFrom = async (file) => (await import(`${pathToFileURL(file).href}?${Date.now()}`)).startDashboard;
function firstDifference(a, b) {
  const n = Math.max(a.log.length, b.log.length);
  for (let i = 0; i < n; i += 1) {
    if (JSON.stringify(a.log[i]) !== JSON.stringify(b.log[i])) {
      const step = [...a.marks].reverse().find(([, at]) => at <= i)?.[0] ?? "start";
      return { at: i, step, old: JSON.stringify(a.log[i])?.slice(0, 300), new: JSON.stringify(b.log[i])?.slice(0, 300) };
    }
  }
  return null;
}
const summary = (r) => r.log.filter(([kind]) => ["action", "to-process", "start", "herdr-space", "interrupt", "quit"].includes(kind))
  .map((entry) => entry.join(" ")).join("; ");

const oldFile = path.join(lib, ".dashboard-old.mjs");
const controlFile = path.join(lib, "dashboard", ".key-actions-control.mjs");
const controlDashboard = path.join(lib, ".dashboard-control.mjs");
let failed = false;
try {
  fs.writeFileSync(oldFile, execFileSync("git", ["-C", repo, "show", `${oldRef}:lib/dashboard.mjs`]));
  const actions = fs.readFileSync(path.join(lib, "dashboard", "key-actions.mjs"), "utf8");
  const anchor = "outcome = onAction(perform);";
  if (actions.split(anchor).length !== 2) throw new Error("the control's anchor is not in key-actions.mjs exactly once");
  fs.writeFileSync(controlFile, actions.replace(anchor, "outcome = onAction({ ...perform, process: session.visible()[0] ?? perform.process });"));
  const dashboard = fs.readFileSync(path.join(lib, "dashboard.mjs"), "utf8");
  const importLine = 'import { KeyActions } from "./dashboard/key-actions.mjs";';
  if (dashboard.split(importLine).length !== 2) throw new Error("the control's import is not in dashboard.mjs exactly once");
  fs.writeFileSync(controlDashboard, dashboard.replace(importLine, 'import { KeyActions } from "./dashboard/.key-actions-control.mjs";'));
  const [Old, New, Control] = [await loadFrom(oldFile), await loadFrom(path.join(lib, "dashboard.mjs")), await loadFrom(controlDashboard)];
  // THE HARNESS'S OWN CONTROL: the old view against itself must agree, or a difference below is the harness's.
  for (const config of CONFIGS) {
    const again = firstDifference(await run(Old, config), await run(Old, config));
    console.log(`${config.label}, old against old: ${again ? `DIFFER at event ${again.at} (step "${again.step}"): the harness is not deterministic` : "agree"}`);
    if (again) failed = true;
  }
  for (const config of CONFIGS) {
    const before = await run(Old, config);
    const after = await run(New, config);
    const writes = after.log.filter(([kind]) => kind === "write").length;
    const differs = firstDifference(before, after);
    console.log(`${config.label}: ${after.log.length} events (${writes} writes) over ${config.script.length} steps, `
      + `${differs ? `DIFFER at event ${differs.at} (step "${differs.step}")` : "old and new agree on every event"}`);
    console.log(`  callbacks: ${summary(after) || "none"}`);
    if (differs) { failed = true; console.log(`  old: ${differs.old}\n  new: ${differs.new}`); }
  }
  const control = firstDifference(await run(Old, CONFIGS[0]), await run(Control, CONFIGS[0]));
  console.log(`CONTROL (an action's process taken from the top row): ${control
    ? `differs at event ${control.at} (step "${control.step}"), as it must\n  old: ${control.old}\n  control: ${control.new}`
    : "AGREES: the driver cannot see a wrong target"}`);
  if (!control) failed = true;
} finally {
  for (const file of [oldFile, controlFile, controlDashboard]) fs.rmSync(file, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
