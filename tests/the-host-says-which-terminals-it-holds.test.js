// The host tells the service which terminals it still holds a process for.
//
// WHAT WAS MEASURED. After a daemon restart the service was never told which terminals had gone: the
// new daemon started with an empty handle book and reported nothing about its predecessor's rows,
// so they ended only through the service's ghost reaper -- and a detached hermes gateway vetoes that
// reaper for ever. The exit markers that could have ended them were cut off by a shutdown that did
// not wait for them, and a process the runner's reaper released never produced one at all.
//
// So the host now says it in one place: the heartbeat carries `metadata.heldTerminals`, from the
// SAME predicate the liveness frames use. A terminal this host holds a live process for is in the
// list; anything else is not, whatever the handle book still remembers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runner } from "../lib/runner.mjs";
import { PluginHost, PluginProcesses } from "../lib/service-plugins.mjs";
import { CommsApi, mintBridgeIdentity } from "../lib/plugins/aify-comms/api.mjs";
import { HEARTBEAT_INTERVAL_MS, createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";
import {
  createHandleBook,
  heldTerminalIds,
  runOneControl,
  runTerminalControlPass,
} from "../lib/plugins/aify-comms/terminal-controls.mjs";

const NEWLINE = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(NEWLINE);
const idle = (script = "setTimeout(() => {}, 30000)") => ({
  service: "aify-comms", fileText: ALLOWED, command: process.execPath, args: ["-e", script],
});

// ── the runner's reaper ─────────────────────────────────────────────────────────────────────────

test("a process the reaper RELEASES tells its exit listeners, exactly once", async () => {
  // The reaper releases a process whose close event was never observed. `#release` deleted the
  // stream and fired nothing, so the plugin's exit path -- forget the terminal, send the exit marker
  // -- never ran, and the service went on believing a dead worker was attached.
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(idle());
  const exits = [];
  runner.subscribe(handle.id, () => {}, (code, signal) => exits.push({ code, signal }));

  runner.release(handle.id);
  assert.deepEqual(exits, [{ code: null, signal: "" }],
    "a released process never reached its exit listeners, so no exit marker could be sent");

  // AND ONCE. The close event can still arrive for a released child; it must not report twice.
  process.kill(handle.pid, "SIGKILL");
  await handle.exited;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(exits.length, 1, `the exit was reported ${exits.length} times`);
});

test("a process that EXITED on its own is not reported again by a later release", async () => {
  const runner = new Runner({ openTerminal: null });
  const handle = await runner.start(idle("process.exit(3)"));
  const exits = [];
  runner.subscribe(handle.id, () => {}, (code) => exits.push(code));
  await handle.exited;
  await new Promise((resolve) => setTimeout(resolve, 30));
  runner.release(handle.id);
  assert.deepEqual(exits, [3]);
});

// ── the one predicate ───────────────────────────────────────────────────────────────────────────

test("a terminal is HELD only while the runner still runs its process", async () => {
  const runner = new Runner({ openTerminal: null });
  const processes = new PluginProcesses(runner);
  const live = await runner.start(idle());
  const gone = await runner.start(idle());
  const book = createHandleBook();
  book.remember("term-live", live.id, "a1");
  book.remember("term-gone", gone.id, "a2");
  // The book still remembers term-gone; the runner does not run it. Only the runner can say.
  runner.release(gone.id);
  book.remember("term-gone", gone.id, "a2");
  try {
    assert.deepEqual(heldTerminalIds(book, processes), ["term-live"]);
  } finally {
    await runner.stop(live.id);
    try { process.kill(gone.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("liveness frames go ONLY to terminals the host holds a process for", async () => {
  const book = createHandleBook();
  book.remember("term-live", "proc-live", "a1");
  book.remember("term-gone", "proc-gone", "a2");
  const outputs = [];
  const api = {
    async claimControls() { return { controls: [] }; },
    async terminalOutput(terminalId, body) { outputs.push({ terminalId, ...body }); return { ok: true }; },
  };
  await runTerminalControlPass({
    api,
    processes: { list: () => [{ id: "proc-live", pid: 1 }] },
    environmentId: "e", handles: book, withinRoots: () => true,
    buildSpec: () => ({}), resolveCandidates: () => [],
  });
  assert.deepEqual(outputs.map((o) => o.terminalId), ["term-live"],
    "a terminal whose process is gone was still reported alive");
});

test("a started terminal is HELD before the service is told it started", async () => {
  // The service ends confirmed terminals a heartbeat does not name. If the host reported a start
  // before the terminal entered the held set, a heartbeat built in between would end a worker that
  // had just come up -- so the report itself is where this is measured.
  const book = createHandleBook();
  let running = false;
  let heldAtReport = null;
  const processes = {
    async start() { running = true; return { id: "proc-1", pid: 9 }; },
    subscribe: () => () => {},
    list: () => (running ? [{ id: "proc-1", pid: 9 }] : []),
  };
  const api = {
    async launch() { return { launch: { argv: ["worker"], cwd: "/w", agentId: "a1" } }; },
    async reportControl(_id, patch) {
      if (patch.status === "completed") heldAtReport = heldTerminalIds(book, processes);
    },
    async terminalOutput() { return { ok: true }; },
  };
  const result = await runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" },
    api, processes, handles: book, cwdRoots: ["/w"], windows: false,
    withinRoots: () => true,
    buildSpec: (spec) => ({ spec }),
    resolveCandidates: () => ["/bin/worker"],
    baseEnv: {},
    sender: { send() {}, async drained() { return true; }, forget() {} },
  });
  assert.equal(result.outcome, "started");
  assert.deepEqual(heldAtReport, ["term-1"],
    "the service was told the terminal started while the host did not yet name it as held");
});

// ── the heartbeat body ──────────────────────────────────────────────────────────────────────────

function capturingApi() {
  const bodies = [];
  const api = new CommsApi({
    endpoint: "http://127.0.0.1:1",
    credential: async () => "",
    identity: mintBridgeIdentity({ version: "test" }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    },
  });
  return { api, bodies };
}

test("the heartbeat carries heldTerminals INSIDE metadata, beside the identity", async () => {
  const { api, bodies } = capturingApi();
  await api.heartbeat({ hostname: "h", kind: "linux", metadata: { other: 1 } }, { heldTerminals: ["t1"] });
  assert.deepEqual(bodies[0].metadata.heldTerminals, ["t1"]);
  assert.equal(bodies[0].metadata.other, 1);
  assert.ok(bodies[0].metadata.bridgeStartedAt, "the identity was displaced");
  assert.equal("heldTerminals" in bodies[0], false, "top level is not where the service reads it");
});

test("a heartbeat that was given NO list sends none -- absent is not empty", async () => {
  // The service reads an absent list as "an older host, do nothing" and an empty one as "this host
  // holds nothing, end the rest". Collapsing the two would end every terminal on a caller that
  // simply did not say.
  const { api, bodies } = capturingApi();
  await api.heartbeat({ hostname: "h", kind: "linux" });
  assert.equal("heldTerminals" in bodies[0].metadata, false);
});

// ── the plugin, end to end over its own loops ───────────────────────────────────────────────────

function pluginRig() {
  const dir = mkdtempSync(join(tmpdir(), "aify-env-held-"));
  const launcher = join(dir, "worker-aify");
  writeFileSync(launcher, ALLOWED);
  const beats = [];
  const reports = [];
  let pendingMarker = null;
  let handedOut = false;
  const running = new Map();
  const exitListeners = new Map();
  const api = {
    identity: { bridgeId: "b1" },
    async heartbeat(body, extra = {}) { beats.push({ body, extra }); return {}; },
    async claim() { return {}; },
    async claimControls() {
      if (handedOut) return { controls: [] };
      handedOut = true;
      return { controls: [{ id: "ctl-1", terminalId: "term-1", action: "start" }] };
    },
    async launch() { return { launch: { argv: [launcher], cwd: dir, agentId: "a1" } }; },
    async reportControl(id, patch) { reports.push({ id, ...patch }); },
    async terminalOutput(_terminalId, body) {
      // An exit marker is held open until the test releases it, so "stop waited for it" is visible.
      if (body.status) return new Promise((resolve) => { pendingMarker = resolve; });
      return { ok: true };
    },
  };
  const runner = {
    async start() { running.set("proc-1", { id: "proc-1", pid: 9 }); return { id: "proc-1", pid: 9 }; },
    subscribe(id, _onOutput, onExit) { exitListeners.set(id, onExit); return () => {}; },
    canStream() { return true; }, write() {}, resize() {}, async stop() {}, relabel() {},
    list() { return [...running.values()]; },
  };
  const timers = [];
  const plugin = createCommsPlugin({
    endpoint: "http://127.0.0.1:1",
    advertisement: async () => ({ hostname: "h", kind: "linux" }),
    cwdRoots: async () => [dir],
    windows: false,
    platform: "linux",
    api,
    readFile: () => ALLOWED,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  const host = new PluginHost({ processes: new PluginProcesses(runner), credential: async () => "" });
  const nextBeat = async () => {
    const timer = timers.filter((t) => t.ms === HEARTBEAT_INTERVAL_MS).at(-1);
    await timer.fn();
    return beats.at(-1);
  };
  return {
    plugin, host, beats, reports, running, exitListeners, nextBeat,
    releaseMarker: () => pendingMarker?.({ ok: true }),
    hasPendingMarker: () => Boolean(pendingMarker),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function until(predicate, what) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the plugin's heartbeat names what it holds, and stops naming what the runner dropped", async () => {
  const rig = pluginRig();
  try {
    await rig.plugin.start(rig.host);
    assert.deepEqual(rig.beats[0].extra.heldTerminals, [], "the first beat holds nothing yet");
    await until(() => rig.reports.some((r) => r.status === "completed"), "the start to be reported");

    assert.deepEqual((await rig.nextBeat()).extra.heldTerminals, ["term-1"]);

    rig.running.delete("proc-1");            // the runner no longer runs it, and nobody said
    assert.deepEqual((await rig.nextBeat()).extra.heldTerminals, [],
      "a terminal whose process the runner no longer holds was still named as held");
  } finally {
    await rig.plugin.stop();
    rig.cleanup();
  }
});

test("stopping sends an OFFLINE beat holding nothing, and waits for an exit marker in flight", async () => {
  const rig = pluginRig();
  try {
    await rig.plugin.start(rig.host);
    await until(() => rig.reports.some((r) => r.status === "completed"), "the start to be reported");
    rig.running.delete("proc-1");
    rig.exitListeners.get("proc-1")(0, "");
    await until(rig.hasPendingMarker, "the exit marker to be posted");

    let stopped = false;
    const stopping = rig.plugin.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, "stop returned while an exit marker was still on its way");
    rig.releaseMarker();
    await stopping;

    const last = rig.beats.at(-1);
    assert.equal(last.body.status, "offline");
    assert.deepEqual(last.extra.heldTerminals, [],
      "the offline beat did not say this host holds nothing");
  } finally {
    rig.cleanup();
  }
});
