// The 0.9.8b session split, judged by behaviour: one scripted session driven into the OLD ConsoleSession (a git ref)
// and the NEW one (the working tree), compared after every step. Plus a negative control in the same run: a copy of
// the new class whose confirmed action takes its process from the cursor must differ, or the driver proves nothing.
//
//   node differential.mjs <repo> <old-ref>
//
// It writes two scratch copies beside lib/console-session.mjs (so their relative imports resolve) and removes them.
// Exit 0 when old and new agree on every step and the control differs; 1 otherwise.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, oldRef] = process.argv.slice(2);
if (!repo || !oldRef) { console.error("usage: node differential.mjs <repo> <old-ref>"); process.exit(64); }
const lib = path.join(repo, "lib");
const load = async (file) => (await import(`${pathToFileURL(file).href}?${Date.now()}`)).ConsoleSession;
const { STREAMING, FAILED } = await import(pathToFileURL(path.join(lib, "output-follower.mjs")).href);
const { MENU_ACTIONS } = await import(pathToFileURL(path.join(lib, "menu-actions.mjs")).href);

const ESC = String.fromCharCode(27);
const K = { UP: `${ESC}[A`, DOWN: `${ESC}[B`, ENTER: "\r", DETACH: String.fromCharCode(29), CTRL_C: String.fromCharCode(3),
  BACKSPACE: String.fromCharCode(127), TAB: "\t", PASTE_START: `${ESC}[200~`, PASTE_END: `${ESC}[201~` };
const rows = (...ids) => ids.map((id) => ({ id, label: id, title: `${id} at work` }));

/** One session under test, with its own follower log and clock. */
function harness(ConsoleSession, options) {
  const log = [];
  const clock = { t: 1000 };
  const make = (id) => {
    log.push(["make", id]);
    return { id, status: "connecting", exit: null, meta: { cols: 100 }, problem: "",
      screen: { bracketedPaste: false, rows: () => ["row 1", "row 2"], unicodeVersion: "11" },
      paneProblem() { return this.problem; }, lines: () => [`line of ${id}`],
      start() { log.push(["start", id]); }, stop() { log.push(["stop", id]); } };
  };
  const progress = [];
  const session = new ConsoleSession({ ...options, makeFollower: make, now: () => clock.t, retryMs: 2000,
    onProgress: () => progress.push(session.watchedId) });
  return { session, log, clock, progress };
}

/** What a result says, with a process reduced to its id so the two classes' objects compare. */
const said = (result) => JSON.parse(JSON.stringify(result, (key, value) => (key === "process" && value ? value.id : value)));
function observe(h, results) {
  const s = h.session;
  const pane = s.pane();
  return {
    results: said(results),
    focus: s.focus,
    selected: s.selected?.id ?? null,
    watchedId: s.watchedId,
    actionTargetId: s.actionTargetId,
    follower: s.follower?.id ?? null,
    log: h.log.splice(0),
    progress: h.progress.splice(0),
    pane: pane && { ...pane, paintedRows: pane.paintedRows, lines: pane.lines() },
    inputIsLive: s.inputIsLive(),
    canDrawPane: s.canDrawPane(),
    startView: s.startView(),
    startOpening: s.startOpening,
    inputFlushMs: s.inputFlushMs,
  };
}

// THE SCRIPT. Each step acts on one harness and returns what the session handed back.
const live = (h) => { if (h.session.follower) h.session.follower.status = STREAMING; return h.session.notePaneRendered(true) && null; };
const key = (data) => (h) => h.session.handleInput(data);
const chunk = (data) => (h) => h.session.handleChunk(data);
const sync = (...ids) => (h) => (h.session.syncProcesses(rows(...ids)), null);
const STEPS = [
  ["viewport 120", (h) => (h.session.noteViewport({ columns: 120 }), null)],
  ["three agents", sync("alpha", "bravo", "charlie")],
  ["stream live", live],
  ["down", key(K.DOWN)], ["j", key("j")], ["held arrow, one read", chunk(`${K.DOWN}${K.DOWN}`)], ["up", key(K.UP)],
  ["digit 2", key("2")],
  ["attach", key(K.ENTER)], ["bravo live", live], ["type x", chunk("x")],
  ["paste split across reads", chunk(`${K.PASTE_START}hel`)], ["paste end", chunk(`lo${K.PASTE_END}`)],
  ["agent asks for bracketed paste", (h) => { if (h.session.follower) h.session.follower.screen.bracketedPaste = true; return null; }],
  ["paste with markers", chunk(`${K.PASTE_START}hi${K.PASTE_END}`)],
  ["detach", key(K.DETACH)],
  ["reorder", sync("charlie", "alpha", "bravo")],
  ["picker", key("g")], ["type br", chunk("br")], ["accept", key(K.ENTER)],
  ["picker again", key("g")], ["no match", chunk("zzz")], ["accept nothing", key(K.ENTER)],
  ["picker third", key("g")], ["type al", chunk("al")], ["paste into picker", chunk(`${K.PASTE_START}ph${K.PASTE_END}`)],
  ["backspace", key(K.BACKSPACE)], ["close picker", key(K.DETACH)],
  // THE RACE (lead's review): a state change between `m` and `y` while the stop confirmation is open.
  ["to bravo", key("3")], ["menu", key("m")], ["menu j", key("j")], ["menu j again", key("j")], ["stop?", key(K.ENTER)],
  ["agent above exits", sync("charlie", "bravo")], ["rows reorder", sync("bravo", "charlie")], ["y", key("y")],
  ["menu on charlie", key("2")], ["menu", key("m")], ["charlie moves", sync("charlie", "delta", "bravo")],
  ["attach from menu", key(K.ENTER)], ["delta live", live],
  ["detach", key(K.DETACH)], ["to bravo", key("3")], ["menu", key("m")], ["j", key("j")], ["j", key("j")], ["stop?", key(K.ENTER)],
  ["subject exits", sync("charlie", "delta")], ["y on a gone agent", key("y")],
  ["start list", key("s")],
  ["answer", (h) => (h.session.noteStartable([{ id: "a1", name: "a1" }, { id: "a2", name: "a2" }, { id: "a3" }, null],
    "", "aify-comms", [{ reason: "outside roots", ids: ["z"] }]), null)],
  ["down", key(K.DOWN)], ["search a2", chunk("a2")], ["paste into search", chunk(`${K.PASTE_START}x${K.PASTE_END}`)],
  ["backspace", key(K.BACKSPACE)], ["herdr space", key(K.TAB)], ["start it", key(K.ENTER)],
  ["reopen asks again", key("s")], ["a problem", (h) => (h.session.noteStartable([], "aify-comms did not answer"), null)],
  ["close", key(K.DETACH)],
  ["columns", key("v")], ["sort", key("o")], ["panes", key("c")], ["close panes", key(K.DETACH)],
  ["hide pane", key("p")], ["list changes hidden", sync("delta", "charlie", "echo")], ["show pane", key("p")],
  ["attach", key(K.ENTER)], ["live", live], ["narrow to 79", (h) => (h.session.noteViewport({ columns: 79 }), null)],
  ["attach refused narrow", key(K.ENTER)], ["width unknown", (h) => (h.session.noteViewport({}), null)],
  ["wide again", (h) => (h.session.noteViewport({ columns: 120 }), null)],
  ["stream fails", (h) => { if (h.session.follower) h.session.follower.status = FAILED; return null; }],
  ["same list too soon", sync("delta", "charlie", "echo")],
  ["time passes", (h) => { h.clock.t += 2500; return null; }], ["same list retries", sync("delta", "charlie", "echo")],
  ["attach", key(K.ENTER)], ["live", live], ["a notice is drawn", (h) => { if (h.session.follower) h.session.follower.problem = "waiting for repaint"; return h.session.notePaneRendered(true) && null; }],
  ["typing at a notice", chunk("z")], ["frame lost", (h) => (h.session.notePaneRendered(false), null)],
  ["held paste marker", chunk(`${ESC}[20`)], ["quiet: flush", (h) => h.session.flushInput()],
  ["ctrl+c", key(K.CTRL_C)], ["y", key("y")], ["repaint", key(String.fromCharCode(12))], ["quit", key("q")],
  ["menu then empty list", key("m")], ["everyone exits", sync()], ["stop", (h) => (h.session.stop(), null)],
];

function run(ConsoleSession, options) {
  const h = harness(ConsoleSession, options);
  return STEPS.map(([name, act]) => ({ name, ...observe(h, act(h)) }));
}

function firstDifference(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const left = JSON.stringify(a[i]); const right = JSON.stringify(b[i]);
    if (left !== right) return { step: i + 1, name: a[i].name, old: left, new: right };
  }
  return null;
}

const oldFile = path.join(lib, ".console-session-old.mjs");
const controlFile = path.join(lib, ".console-session-control.mjs");
const CONFIGS = [["menu, Ctrl+C asks", { actions: MENU_ACTIONS, confirmInterrupt: true }], ["attach only, Ctrl+C leaves", {}],
  ["without a console", { actions: MENU_ACTIONS, withoutConsole: true }]];
let failed = false;
try {
  fs.writeFileSync(oldFile, execFileSync("git", ["-C", repo, "show", `${oldRef}:lib/console-session.mjs`]));
  const current = fs.readFileSync(path.join(lib, "console-session.mjs"), "utf8");
  // The confirmed action's target, taken from the cursor instead: as the class was before 0.9.8b's subjects part, and
  // after it. Exactly one of the two must be there.
  const controls = [
    ["const target = performed && this.actionTargetId\n      ? (this.processes.find((row) => row?.id === this.actionTargetId) ?? null)\n      : null;",
      "const target = performed ? this.selected : null;"],
    ["const target = this.#subjects.takeActionTarget(performed, this.processes);",
      "const target = (this.#subjects.takeActionTarget(performed, this.processes), performed ? this.selected : null);"],
  ].filter(([anchor]) => current.split(anchor).length === 2);
  if (controls.length !== 1) throw new Error("the control's anchor is not in the new class exactly once");
  fs.writeFileSync(controlFile, current.replace(controls[0][0], controls[0][1]));
  const [Old, New, Control] = [await load(oldFile), await load(path.join(lib, "console-session.mjs")), await load(controlFile)];
  for (const [label, options] of CONFIGS) {
    const before = run(Old, options);
    const after = run(New, options);
    const differs = firstDifference(before, after);
    const performed = after.flatMap((step) => [].concat(step.results ?? []).filter((r) => r?.perform || r?.startAgent)
      .map((r) => `${step.name}: ${r.perform ? `${r.perform.action} ${r.perform.process}` : `start ${r.startAgent.id}`}`));
    console.log(`${label}: ${STEPS.length} steps, ${differs ? `DIFFER at step ${differs.step} (${differs.name})` : "old and new agree on every step"}`);
    console.log(`  executor calls: ${performed.join("; ") || "none"}`);
    if (differs) { failed = true; console.log(`  old: ${differs.old}\n  new: ${differs.new}`); }
  }
  const control = firstDifference(run(Old, CONFIGS[0][1]), run(Control, CONFIGS[0][1]));
  console.log(`CONTROL (target from the cursor): ${control ? `differs at step ${control.step} (${control.name}), as it must` : "AGREES: the driver cannot see a wrong target"}`);
  if (!control) failed = true;
} finally {
  for (const file of [oldFile, controlFile]) fs.rmSync(file, { force: true });
}
process.exit(failed ? 1 : 0);
