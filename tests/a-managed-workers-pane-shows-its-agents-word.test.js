// A managed worker's Herdr pane shows aify-env's word for its agent (0.9.9, Herdr status sync phase 1).
//
// lib/herdr-pane-reporter.mjs makes every report; lib/herdr-pane-opener.mjs opens the pane and asks it to claim and
// forget. Herdr is faked: the reporter's two calls are injected, and nothing here runs a `herdr` binary.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { deriveAgentState } from "../lib/agent-state.mjs";
import { paneOpenerFor } from "../lib/herdr-pane-opener.mjs";
import { HERDR_AGENT_SOURCE, HerdrPaneReporter, paneReportFor } from "../lib/herdr-pane-reporter.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";

const stateOf = (argv) => argv[argv.indexOf("--state") + 1];
const messageOf = (argv) => (argv.includes("--message") ? argv[argv.indexOf("--message") + 1] : null);
const seqOf = (argv) => Number(argv.at(-1));
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Every word deriveAgentState can say, from its whole fact space: derived, so a new word reaches this test unasked. */
function everyWord() {
  const words = new Set();
  const flags = ["stoppedByOperator", "startingInWindow", "conflict", "busy", "awaitingInput"];
  const screens = [null, ...["working", "blocked", "shell", "idle"].flatMap((state) => [{ state, fresh: true }, { state, fresh: false }])];
  for (const definition of ["valid", "invalid", "unavailable", "none"]) for (const mode of ["managed", "resident"])
    for (const process of ["running", "starting", "exited", "none", "unknown"]) for (const verified of ["yes", "no", "unknown"])
      for (let bits = 0; bits < 2 ** flags.length; bits += 1) for (const screen of screens) for (const backgroundShells of [0, 1]) {
        const set = Object.fromEntries(flags.map((name, at) => [name, Boolean(bits & (1 << at))]));
        words.add(deriveAgentState({ definition, mode, process, verified, ...set, screen, backgroundShells }).state);
      }
  return words;
}

//: The operator-approved table (comms-tech-lead, 2026-10-28): a boot in flight is work, and `unknown` is kept for real unknowns.
const HERDR_STATE = { idle: "idle", working: "working", blocked: "blocked", shell: "idle", starting: "working", misconfigured: "blocked",
  stopped: "unknown", offline: "unknown", available: "unknown", unknown: "unknown" };

test("every word aify-env can say has its Herdr state, and travels as the message", () => {
  const words = everyWord();
  assert.deepEqual([...words].sort(), Object.keys(HERDR_STATE).sort(), "the table and the words deriveAgentState says have drifted apart");
  for (const word of words) assert.deepEqual(paneReportFor(word), { state: HERDR_STATE[word], message: word }, word);
  // FAILS CLOSED: a word nobody taught this table, or none, is Herdr's unknown, and still says what it was.
  assert.deepEqual(paneReportFor("dreaming"), { state: "unknown", message: "dreaming" });
  assert.deepEqual(paneReportFor(undefined), { state: "unknown", message: "unknown" });
  assert.deepEqual(paneReportFor("constructor"), { state: "unknown", message: "constructor" }, "an inherited property is not a word");
});

/** A reporter over a Herdr whose asynchronous calls answer at once, fail, or wait to be released. */
function rig({ hold = false, fail = null } = {}) {
  const r = { sync: [], sent: [], gates: [], logs: [], words: new Map([["lead", "working"]]), complete: true, now: 1_800_000_000_000_000 };
  const read = async () => ({ status: 200, body: { complete: r.complete, agents: [...r.words].map(([agentId, state]) => ({ agentId, state })) } });
  r.reporter = new HerdrPaneReporter({
    observation: {}, read, nowUs: () => r.now, log: (line) => r.logs.push(line),
    call: (argv) => { r.sync.push(argv); return {}; },
    callAsync: (argv) => {
      r.sent.push(argv);
      if (fail) return Promise.reject(fail());
      return hold ? new Promise((resolve, reject) => r.gates.push({ resolve, reject })) : Promise.resolve({});
    },
  });
  return r;
}

test("a pane opened for an agent is claimed idle at once, then told the agent's word, on one clock that only rises", async () => {
  const r = rig();
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  assert.equal(r.sync.length, 1, "the claim is not made while the pane is opened");
  assert.deepEqual(r.sync[0].slice(0, -2), ["pane", "report-agent", "w2:p1", "--source", HERDR_AGENT_SOURCE, "--agent", "claude-aify", "--state", "idle"]);
  await r.reporter.tick();
  assert.equal(r.sent.length, 1);
  assert.deepEqual([stateOf(r.sent[0]), messageOf(r.sent[0]), r.sent[0][4]], ["working", "working", HERDR_AGENT_SOURCE]);
  assert.ok(seqOf(r.sent[0]) > seqOf(r.sync[0]), "the word was stamped no later than the claim, on a clock that did not move");
});

test("a word is said when it changes, and again only once it has stood for the reassert interval", async () => {
  const r = rig();
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await r.reporter.tick();
  r.now += 59_000_000;
  await r.reporter.tick();
  assert.equal(r.sent.length, 1, "an unchanged word was said again on every evaluation");
  r.now += 2_000_000;
  await r.reporter.tick();
  assert.equal(r.sent.length, 2, "a word that stood a minute was never said again, so another writer's report stands");
  r.words.set("lead", "shell");
  await r.reporter.tick();
  assert.deepEqual([r.sent.length, stateOf(r.sent[2]), messageOf(r.sent[2])], [3, "idle", "shell"]);
});

test("A SLOW HERDR: one report in flight per pane, the newest waiting, nothing queued behind it, and the daemon never blocks", async () => {
  const r = rig({ hold: true });
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await r.reporter.tick();
  for (const word of ["idle", "blocked"]) { r.words.set("lead", word); await r.reporter.tick(); }
  assert.equal(r.sent.length, 1, "a second report was sent while the first was still in flight");
  r.gates.shift().resolve({});
  await settle();
  assert.deepEqual(r.sent.map(stateOf), ["working", "blocked"], "the word that waited was not the latest");
  assert.equal(r.sync.length, 1, "a report after the claim blocked the daemon");
  const seqs = [r.sync[0], ...r.sent].map(seqOf);
  assert.ok(seqs.every((seq, at) => at === 0 || seq > seqs[at - 1]), `the pane's clock went backwards or stood: ${seqs}`);
});

test("a pane forgotten is told nothing more: the report waiting for it is dropped", async () => {
  const r = rig({ hold: true });
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await r.reporter.tick();
  r.words.set("lead", "idle");
  await r.reporter.tick();
  r.reporter.forget("w2:p1");
  r.gates.shift().resolve({});
  await settle();
  r.words.set("lead", "blocked");
  await r.reporter.tick();
  assert.equal(r.sent.length, 1, "a closing pane, whose id Herdr may give to another, was reported on");
});

test("a pane Herdr no longer has is forgotten", async () => {
  const r = rig({ fail: () => Object.assign(new Error("no such pane"), { code: "pane_not_found" }) });
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await r.reporter.tick();
  await settle();
  r.words.set("lead", "idle");
  await r.reporter.tick();
  assert.equal(r.sent.length, 1, "a pane that is gone was still reported on");
});

test("a report that fails is said again at the next read, and the failure is said once", async () => {
  const r = rig({ fail: () => new Error("socket gone") });
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await r.reporter.tick();
  await settle();
  const first = r.sent.length;
  await r.reporter.tick();
  await settle();
  assert.equal(r.sent.length, first + 1, "a word Herdr never took was not said again at the next read");
  assert.equal(r.logs.filter((line) => line.includes("socket gone")).length, 1, "one failure was logged on every evaluation");
});

test("an incomplete read says nothing, and a pane opened for no agent is claimed and told nothing more", async () => {
  const r = rig();
  r.complete = false;
  r.reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await r.reporter.tick();
  assert.equal(r.sent.length, 0, "a word the publisher withholds from the dashboard reached the pane");
  const plain = rig();
  plain.reporter.claim("w2:p9", { agentId: null, agent: "claude-aify" });
  await plain.reporter.tick();
  assert.deepEqual([plain.sync.length, plain.sent.length], [1, 0]);
});

/** The read the daemon makes, over a host whose word follows its one worker's screen, as AgentStateHost.current's does. */
function screenObservation(sightings) {
  const stateHost = { readAll: (_given, _missing, screens) => {
    const seen = screens.get("h1");
    const { state } = deriveAgentState({ stoppedByOperator: false, definition: "valid", mode: "managed", process: "running", verified: "yes",
      startingInWindow: false, conflict: false, busy: false, awaitingInput: false, screen: seen ? { state: seen.state, fresh: true } : null, backgroundShells: 0 });
    return { agents: [{ agentId: "lead", state }], complete: true, problems: [] };
  } };
  return { stateHost, definitions: { list: async () => ({ storeId: "s", definitions: [], unreadable: [] }) },
    lifecycle: { stopFacts: async () => new Map() }, observedHarnesses: async () => new Set(["claude"]), screens: () => [() => sightings.now] };
}

test("NO PATH BACK IN: a report never feeds the word, so a screen that clears takes the word with it", async () => {
  const sightings = { now: [{ handle: "h1", state: "blocked", rule: "folder-trust" }] };
  const sent = [];
  const reporter = new HerdrPaneReporter({ observation: screenObservation(sightings), call: () => ({}), callAsync: async (argv) => { sent.push(argv); return {}; } });
  reporter.claim("w2:p1", { agentId: "lead", agent: "claude-aify" });
  await reporter.tick();
  assert.deepEqual([stateOf(sent.at(-1)), messageOf(sent.at(-1))], ["blocked", "blocked"], "CONTROL: the screen's dialog reached the pane");
  sightings.now = [];
  await reporter.tick();
  assert.deepEqual([stateOf(sent.at(-1)), messageOf(sent.at(-1))], ["idle", "idle"], "the pane's own report held the word after its cause cleared");
});

test("THROUGH THE OPENER: a started agent's pane is told its word, and nothing more once its worker has gone", async (t) => {
  const path = await import("node:path");
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-pane-word-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sync = [];
  const sent = [];
  const watched = new Map();
  const deferred = [];
  const sightings = { now: [] };
  const openPane = paneOpenerFor({
    env: { HERDR_SOCKET_PATH: path.join(root, "herdr.sock") }, dedicatedRoot: root, base: "http://127.0.0.1:65000", node: "node",
    script: "aify-env.mjs", platform: "linux", bin: "herdr", defer: (fn) => deferred.push(fn),
    watchExit: (id, onExit) => watched.set(id, onExit), observation: screenObservation(sightings),
    call: (_bin, argv) => { sync.push(argv); return argv[1] === "process-info" ? { result: { process_info: { shell_pid: 1 } } } : { result: { root_pane: { pane_id: "w2:p1" } } }; },
    callAsync: async (_bin, argv) => { sent.push(argv); return {}; },
  });
  const runner = { start: async () => ({ id: "proc-1", terminal: true }) };
  const processes = new PluginProcesses(runner, { onStarted: openPane, prepare: openPane.prepare });
  await processes.start({ id: "term-1", label: "lead", agentId: "lead", launcher: "/bin/claude-aify", env: {} });
  await openPane.report();
  assert.equal(sync.filter((argv) => argv[1] === "report-agent").length, 1, "the pane was not claimed as it opened");
  assert.deepEqual(sent.map((argv) => [argv[2], stateOf(argv), messageOf(argv)]), [["w2:p1", "idle", "idle"]], "the agent's pane was not told its word");
  watched.get("proc-1")(0, null);
  // A NEW WORD, so a pane still held would be told it: an unchanged one is not said again anyway.
  sightings.now = [{ handle: "h1", state: "blocked", rule: "folder-trust" }];
  await openPane.report();
  assert.equal(sent.length, 1, "a pane whose worker had gone, queued for closing, was reported on");
});

test("THE DAEMON ASKS FOR THE REPORTS wherever it evaluates agent state, read rather than run", () => {
  // Importing bin/aify-env.mjs starts a daemon, so the one call that makes any of this happen is checked in its source.
  const source = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const evaluate = source.slice(source.indexOf("function evaluateAgentState() {"), source.indexOf("function stopAgentStateSending()"));
  assert.match(evaluate, /void paneOpener\?\.report\(\)\.catch\(/, "no evaluation tells a pane its word");
});
