#!/usr/bin/env node
// P0 C8: a registry change DETACHES a plugin, it never shuts the host down. The real aify-comms
// plugin runs here with a fake transport (its long-polls resolved by the test) and fake processes.
//
// Witnesses: a held worker across a registry removal (still held, no offline beat); an endpoint
// change with a claim in flight that returns a START control (refused, nothing started, then detach);
// the same with a non-start control (handled, then detach); a reply after detach (ignored); host
// shutdown still sending the offline beat. And the registry follow itself: plan, retry, readability.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { runInNewContext } from "node:vm";

import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";
import { DETACHING } from "../lib/plugins/aify-comms/plugin-phase.mjs";
import { followRegistry, followReport, planPluginChanges } from "../lib/plugin-bootstrap.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";
import { readServices, registryIsReadable } from "../lib/services.mjs";

const NEWLINE = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(NEWLINE);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate, what) {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A real launcher file and workspace, so a start control goes through the plugin's own pipeline. */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-follow-"));
  const launcher = path.join(root, "claude-aify");
  fs.writeFileSync(launcher, ALLOWED);
  return { root, launcher };
}

/** The transport: every control long-poll is held open until the test answers it. */
function fakeApi(launch) {
  const polls = [];
  const api = {
    heartbeats: [], reports: [], polls,
    // Set to an array to hold beats open: each held beat is answered by the test.
    heldBeats: null,
    async heartbeat(body, { heldTerminals } = {}) {
      api.heartbeats.push({ status: body?.status || "online", held: [...(heldTerminals || [])] });
      if (api.heldBeats) return new Promise((resolve, reject) => api.heldBeats.push({ resolve, reject }));
      return { claimer: { accepted: true } };
    },
    claims: 0,
    async claim() { api.claims += 1; return {}; },
    async report() {},
    claimControls() {
      let answer;
      const promise = new Promise((resolve) => { answer = resolve; });
      polls.push({ answer, promise });
      return promise;
    },
    async launch() { return { launch }; },
    async reportControl(id, patch) { api.reports.push({ id, ...patch }); },
    async terminalOutput() { return { ok: true }; },
  };
  return api;
}

/** The runner the plugin's processes view sits on: starts nothing real, and says what runs. */
function fakeRunner() {
  const running = new Set();
  const runner = {
    starts: [], writes: [],
    async start(spec) { runner.starts.push(spec); running.add("proc-1"); return { id: "proc-1", pid: 4242 }; },
    subscribe(id, onOutput, onExit) { runner.exit = () => { running.delete(id); onExit?.(0, ""); }; return () => {}; },
    write(id, data) { runner.writes.push({ id, data }); },
    resize() {}, relabel() {}, screenText: () => null, canStream: () => true,
    async stop(id) { running.delete(id); },
    list: () => [...running].map((id) => ({ id, pid: 4242 })),
  };
  return runner;
}

// Every plugin a test started is stopped at the end, so a failing witness cannot keep the run alive.
const live = [];
after(() => Promise.all(live.map((plugin) => plugin.stop().catch(() => {}))));

async function startedPlugin({ endpoint = "http://old.invalid", cwdRoots = null } = {}) {
  const { root, launcher } = workspace();
  const launch = { terminalId: "term-1", agentId: "a", runtime: "claude-code", command: launcher, argv: [launcher], cwd: root, env: { AIFY_AGENT_ID: "a" } };
  const api = fakeApi(launch);
  const runner = fakeRunner();
  const plugin = createCommsPlugin({
    endpoint, api, cwdRoots: cwdRoots || (async () => [root]), advertisement: async () => ({ hostname: "h", kind: "test" }),
    windows: process.platform === "win32", readFile: () => ALLOWED,
    setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeoutImpl: clearTimeout,
  });
  const logs = [];
  live.push(plugin);
  await plugin.start(new PluginHost({ processes: new PluginProcesses(runner), log: (line) => logs.push(line) }));
  return { plugin, api, runner, logs };
}

/** Answer the control long-poll now open. Waits for one nobody has answered yet: answering the last
 *  poll regardless would drop the controls into a poll the plugin has already finished with. */
async function answerPoll(api, controls) {
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  const open = api.polls.find((p) => !p.answered);
  open.answered = true;
  open.answer({ controls });
}

/** Detach while a control long-poll is open, so the detach must wait for it, then answer that poll. */
async function detachDuringPoll(plugin, api, controls = []) {
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  let settled = false;
  const detaching = plugin.detach().finally(() => { settled = true; });
  await tick(); await tick();
  assert.equal(settled, false, "detach waits for the long-poll in flight");
  await answerPoll(api, controls);
  return detaching;
}

async function holdOneWorker(api, runner) {
  await answerPoll(api, [{ id: "ctl-start", terminalId: "term-1", action: "start" }]);
  await until(() => runner.list().length === 1, "the worker to start");
}

// A HANG IS A FAILURE: a detach that waits for ever must fail this file, not stall it (a mutant did).
const witness = (name, fn) => test(name, { timeout: 10_000 }, fn);

const offlineBeats = (api) => api.heartbeats.filter((h) => h.status === "offline");

witness("A HELD WORKER ACROSS A REGISTRY REMOVAL: kept and still reported held, starts refused, no offline beat; detached once it ends", async () => {
  let rootsReads = 0;
  const { plugin, api, runner, logs } = await startedPlugin({ cwdRoots: async () => { rootsReads += 1; return [os.tmpdir()]; } });
  await holdOneWorker(api, runner);
  // CONTROL: while running, the claim loop begins a setup every interval, so the count can move.
  const running = rootsReads;
  await until(() => rootsReads > running + 1, "claim passes beginning their setup while running");
  assert.deepEqual(await detachDuringPoll(plugin, api), { detached: false, held: 1 });
  assert.equal(plugin.state().phase, "held");
  // ONLY THE CONTROL LOOP RUNS WHILE HELD. With its long-poll open, no pass is in its setup; a claim
  // loop still turning would begin one every interval (review of c1a4596, R2).
  await until(() => api.polls.some((p) => !p.answered), "the held plugin's long-poll");
  const held = rootsReads;
  for (let i = 0; i < 8; i += 1) await tick();
  assert.equal(rootsReads, held, "no pass began its setup while held with the long-poll open");
  assert.equal(logs.filter((l) => l.includes("registry change pending")).length, 1);
  await until(() => api.heartbeats.at(-1)?.held.includes("term-1") && api.heartbeats.length > 2, "a beat after the detach");
  assert.deepEqual(offlineBeats(api), [], "a configuration change is not the host going away");
  // Still serving its worker, and still refusing starts.
  await answerPoll(api, [{ id: "ctl-again", terminalId: "term-2", action: "start" }]);
  await until(() => api.reports.some((r) => r.id === "ctl-again"), "the second start's report");
  assert.equal(api.reports.find((r) => r.id === "ctl-again").error, DETACHING);
  assert.equal(runner.starts.length, 1, "nothing more was started");
  assert.equal((await plugin.capabilities.agents.start("a")).problem, DETACHING, "an operator start is refused too");
  // Asked again while the worker lives: still held, and not announced a second time.
  assert.deepEqual(await detachDuringPoll(plugin, api), { detached: false, held: 1 });
  assert.equal(logs.filter((l) => l.includes("registry change pending")).length, 1, "said once, on becoming held");
  runner.exit();
  assert.deepEqual(await detachDuringPoll(plugin, api), { detached: true, held: 0 });
  assert.deepEqual(offlineBeats(api), [], "and still no offline beat");
});

witness("A START CONTROL IN THE IN-FLIGHT POLL is refused and starts nothing; the plugin then detaches", async () => {
  const { plugin, api, runner } = await startedPlugin();
  const detached = await detachDuringPoll(plugin, api, [{ id: "ctl-late", terminalId: "term-9", action: "start" }]);
  assert.deepEqual(detached, { detached: true, held: 0 });
  assert.deepEqual(api.reports.map((r) => [r.id, r.status, r.error]), [["ctl-late", "failed", DETACHING]]);
  assert.equal(runner.starts.length, 0);
  assert.equal(plugin.state().phase, "detached");
  const polls = api.polls.length;
  await tick(); await tick();
  assert.equal(api.polls.length, polls, "no new poll begins after a detach");
});

witness("A NON-START CONTROL IN THE IN-FLIGHT POLL is handled, then the plugin detaches", async () => {
  const { plugin, api, runner } = await startedPlugin();
  await holdOneWorker(api, runner);
  const result = await detachDuringPoll(plugin, api, [{ id: "ctl-type", terminalId: "term-1", action: "input", body: "hi" }]);
  assert.deepEqual(runner.writes.map((w) => w.data), ["hi"], "the input reached the worker");
  assert.equal(api.reports.find((r) => r.id === "ctl-type")?.status, "completed");
  assert.deepEqual(result, { detached: false, held: 1 }, "the worker is still held, so the plugin is kept");
});

witness("A REPLY AFTER DETACH is ignored, and HOST SHUTDOWN still sends the offline beat", async () => {
  for (const late of ["answer", "failure"]) {
    const { plugin, api, logs } = await startedPlugin();
    api.heldBeats = [];
    await until(() => api.heldBeats.length > 0, "a beat in flight");
    assert.deepEqual(await detachDuringPoll(plugin, api), { detached: true, held: 0 });
    const before = JSON.stringify(plugin.state());
    const logged = logs.length;
    const beats = api.heartbeats.length;
    if (late === "answer") api.heldBeats[0].resolve({ claimer: { accepted: false, reason: "superseded" } });
    else api.heldBeats[0].reject(new Error("service went away"));
    await tick(); await tick();
    assert.equal(JSON.stringify(plugin.state()), before, `a late ${late} changes nothing`);
    assert.equal(logs.length, logged, `a late ${late} is not logged`);
    assert.equal(api.heartbeats.length, beats, `a late ${late} schedules no further beat`);
  }

  const other = await startedPlugin();
  await other.plugin.stop();
  assert.deepEqual(offlineBeats(other.api).map((h) => h.held), [[]], "shutdown: one offline beat holding nothing");
});

witness("THE PLAN: a removed or moved service detaches, a new one is added only once its name is free", () => {
  const running = [{ name: "aify-comms", endpoint: "http://a" }, { name: "gone", endpoint: "http://g" }];
  assert.deepEqual(planPluginChanges(running, [{ name: "aify-comms", endpoint: "http://a" }]), { detach: ["gone"], add: [] });
  assert.deepEqual(planPluginChanges(running, [{ name: "aify-comms", endpoint: "http://b" }, { name: "gone", endpoint: "http://g" }]),
    { detach: ["aify-comms"], add: [{ name: "aify-comms", endpoint: "http://b" }] });
  assert.deepEqual(planPluginChanges([], [{ name: "x", endpoint: "" }, { name: "y", endpoint: "http://y" }]).add, [{ name: "y", endpoint: "http://y" }]);
});

witness("FOLLOWING THE REGISTRY: an endpoint change waits for the held worker, then the new plugin starts", async () => {
  const { plugin, api, runner } = await startedPlugin({ endpoint: "http://old.invalid" });
  const registry = new ServicePlugins();
  // Registered as already started, the way boot leaves it.
  assert.equal(registry.register(plugin), "");
  await holdOneWorker(api, runner);
  const built = [];
  const build = (services) => ({ plugins: services.map((s) => { const p = { name: s.name, endpoint: s.endpoint, start: async () => {}, stop: async () => {}, detach: async () => ({ detached: true, held: 0 }) }; built.push(p); return p; }), unserved: [] });
  const host = { processes: null };
  const moved = [{ name: "aify-comms", endpoint: "http://new.invalid" }];
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  const first = followRegistry({ registry, host, services: moved, build });
  await answerPoll(api, []);
  const once = await first;
  assert.deepEqual([once.added, once.detached, once.held], [[], [], [{ name: "aify-comms", held: 1 }]], "kept on the old endpoint");
  assert.deepEqual(registry.running(), [{ name: "aify-comms", endpoint: "http://old.invalid" }]);
  assert.deepEqual(followReport(once), [], "a held plugin is not repeated in the daemon's log on every beat");
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  const again = followRegistry({ registry, host, services: moved, build });
  await answerPoll(api, []);
  const stillHeld = await again;
  assert.deepEqual([stillHeld.resumed, stillHeld.held], [[], [{ name: "aify-comms", held: 1 }]], "a plugin the registry still moves is not resumed");
  runner.exit();
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  const second = followRegistry({ registry, host, services: moved, build });
  await answerPoll(api, []);
  const twice = await second;
  assert.deepEqual([twice.detached, twice.added], [["aify-comms"], ["aify-comms"]]);
  assert.deepEqual(registry.running(), [{ name: "aify-comms", endpoint: "http://new.invalid" }]);
  assert.equal(built.length, 1, "the new plugin was built once, when its name was free");
});

witness("AN UNREADABLE REGISTRY IS NOT AN EMPTY ONE: only a parsed registry is followed", () => {
  assert.equal(registryIsReadable('{"version":1,"services":{}}'), true, "an empty services object is a real removal of all");
  for (const text of ["", "{", "[]", '{"services":[]}', "null", undefined]) {
    assert.equal(registryIsReadable(text), false, String(text));
    assert.deepEqual(readServices(text), [], "which readServices alone could not tell apart");
  }
});

witness("A REVERTED CHANGE RESUMES: the held plugin claims and starts again; nothing claims while held", async () => {
  const { plugin, api, runner } = await startedPlugin({ endpoint: "http://old.invalid" });
  const registry = new ServicePlugins();
  assert.equal(registry.register(plugin), "");
  await holdOneWorker(api, runner);
  const build = () => assert.fail("nothing is built: the name never frees");
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  const moving = followRegistry({ registry, host: {}, services: [{ name: "aify-comms", endpoint: "http://new.invalid" }], build });
  await answerPoll(api, []);
  assert.deepEqual((await moving).held, [{ name: "aify-comms", held: 1 }]);
  const claimsWhileHeld = api.claims;
  await tick(); await tick(); await tick();
  assert.equal(api.claims, claimsWhileHeld, "a held plugin claims nothing: a claimed spawn is a start it must refuse");

  const back = await followRegistry({ registry, host: {}, services: [{ name: "aify-comms", endpoint: "http://old.invalid" }], build });
  assert.deepEqual([back.resumed, back.detached, back.added], [["aify-comms"], [], []]);
  assert.deepEqual(followReport(back), ["registry: resumed the plugin for aify-comms"]);
  assert.equal(plugin.state().phase, "running");
  await until(() => api.claims > claimsWhileHeld, "a claim after resuming");
  assert.notEqual((await plugin.capabilities.agents.start("a")).problem, DETACHING, "starts are no longer refused");
  // Controls: only a held plugin resumes, and a name nobody runs resumes nothing.
  assert.equal(plugin.resume(), false);
  assert.equal(registry.resume("aify-comms"), false);
  assert.equal(registry.resume("nobody"), false);
  const steady = await followRegistry({ registry, host: {}, services: [{ name: "aify-comms", endpoint: "http://old.invalid" }], build });
  assert.deepEqual(steady.resumed, [], "a running plugin is not reported resumed on every beat");
});

witness("A PASS WHOSE SETUP OUTLASTS THE DETACH starts nothing: no claim and no long-poll after it", async () => {
  // Both loops read the workspace roots in their setup; holding that read parks one pass of each
  // inside it. The detach lands there, and each pass must read the phase again once released.
  const parked = [];
  let hold = false;
  const cwdRoots = async () => { if (hold) await new Promise((resolve) => parked.push(resolve)); return [os.tmpdir()]; };
  const { plugin, api } = await startedPlugin({ cwdRoots });
  await until(() => api.polls.some((p) => !p.answered), "an open control long-poll");
  hold = true;
  await answerPoll(api, []);
  await until(() => parked.length === 2, "one claim pass and one control pass parked in their setup");
  const claims = api.claims;
  const polls = api.polls.length;
  const detaching = plugin.detach();
  hold = false;
  for (const release of parked.splice(0)) release();
  assert.deepEqual(await detaching, { detached: true, held: 0 });
  assert.equal(api.claims, claims, "the claim pass claimed nothing after the detach");
  assert.equal(api.polls.length, polls, "the control pass opened no long-poll after the detach");
});

witness("THE REGISTRY'S EDGES: a plugin naming no endpoint is not moved, one without detach() stays, a failed add frees its name", async () => {
  const registry = new ServicePlugins();
  const lifecycle = { start: async () => {}, stop: async () => {} };
  assert.equal(registry.register({ name: "no-endpoint", ...lifecycle }), "");
  assert.equal(registry.register({ name: "no-detach", endpoint: "http://k", ...lifecycle }), "");
  assert.deepEqual(registry.running(), [{ name: "no-detach", endpoint: "http://k" }]);
  const out = await followRegistry({ registry, host: {}, services: [], build: () => assert.fail("nothing to add") });
  assert.deepEqual(out.detached, []);
  assert.equal(out.held.length, 1);
  assert.match(out.held[0].problem, /"no-detach" cannot be detached while this host runs/);
  assert.deepEqual(registry.names(), ["no-endpoint", "no-detach"], "neither left the registry");

  const failing = await registry.add({ name: "late", endpoint: "http://l", start: async () => { throw new Error("service down"); }, stop: async () => {} }, {});
  assert.match(String(failing.error?.message), /service down/);
  assert.equal(registry.names().includes("late"), false);
  assert.deepEqual(await registry.add({ name: "late", endpoint: "http://l", ...lifecycle }, {}), {}, "the next registry read starts it afresh");
});

witness("THE DAEMON FOLLOWS ONLY A REGISTRY THAT PARSES: its own statement, run", () => {
  // bin/aify-env.mjs is never imported (it runs the daemon), so its one follow statement is taken out
  // and run, as production-picker-bootstrap does with the bootstrap.
  const daemon = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const statements = daemon.split(/\r?\n/).filter((line) => line.includes("followServices?.("));
  assert.equal(statements.length, 1, "the daemon's follow statement must remain identifiable");
  for (const [text, expected] of [['{"version":1,"services":{}}', [[]]], ["{", []], ["", []]]) {
    const calls = [];
    runInNewContext(statements[0], { registryText: text, followServices: (services) => calls.push(services), registryIsReadable, readServices });
    assert.deepEqual(calls, expected, JSON.stringify(text));
  }
});
