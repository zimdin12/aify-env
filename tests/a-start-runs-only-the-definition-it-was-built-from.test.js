#!/usr/bin/env node
// The process-start boundary (P0 C7): a launch the service built from a definition starts only while
// this host's file is that definition, and the file is held until the process exists. Driven through
// the real control path with a real store; the launch is what `GET /terminals/{id}/launch` returns.
//
// THE HOLD IS THE POINT (review of P4, N1). A check that read the file and let go of it before the
// process was made let a set, a removal, or a removal and re-definition commit in between, and the old
// revision's worker started. The Runner awaits its checkpoint loader before it makes the child, so the
// gap reached inside `processes.start` too. The witnesses below pause there and write through a second
// store, as another process would.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { workspaceWithinRoots } from "../lib/plugins/aify-comms/claim.mjs";
import { createHandleBook, runOneControl } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { Runner } from "../lib/runner.mjs";
import { PluginProcesses } from "../lib/service-plugins.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const agent = (over = {}) => ({ name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/work",
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true, ...over });

function host(launch) {
  const reports = [];
  const starts = [];
  const api = {
    async launch() { return { launch }; },
    async reportControl(id, patch) { reports.push({ id, ...patch }); },
    async terminalOutput() { return {}; },
  };
  const processes = {
    async start(spec) { starts.push(spec); return { id: "proc-1", pid: 1, cols: 80, rows: 24 }; },
    subscribe() { return () => {}; },
    list() { return []; },
  };
  return { api, processes, reports, starts };
}

const LAUNCHER_TEXT = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
const fakeSpec = ({ launcher, args, cwd, env, label }) => ({ spec: { launcher, args, cwd, env, label, fileText: "#!" } });

function control(store, { api, processes }, buildSpec = fakeSpec) {
  return runOneControl({
    control: { id: "ctl-1", terminalId: "term-1", action: "start" }, api, processes, handles: createHandleBook(),
    cwdRoots: ["C:/work"], windows: true, withinRoots: workspaceWithinRoots, buildSpec,
    resolveCandidates: () => ["C:/bin/claude-aify"], baseEnv: {},
    admitStart: (launch, produce) => store.admitStart(launch, produce),
  });
}

async function startWith(store, launch) {
  const { api, processes, reports, starts } = host(launch);
  const result = await control(store, { api, processes });
  return { result, reports, starts };
}

async function definedLead() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-boundary-"));
  const store = new DefinitionStore({ dir, lockWaitMs: 300 });
  await store.set("lead", agent({ model: "m1" }), { installed: ALL });
  const { storeId } = await store.list();
  const launch = { terminalId: "term-1", agentId: "lead", runtime: "claude-code", argv: ["claude-aify", "--aify-agent", "lead"],
    cwd: "C:/work", env: {}, definition: { storeId, incarnation: 1, revision: 1 } };
  return { dir, store, launch };
}

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settleFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
//: What the file says, read past the store: what another process would find there.
const onDisk = (dir) => (fs.existsSync(path.join(dir, "lead.json"))
  ? JSON.parse(fs.readFileSync(path.join(dir, "lead.json"), "utf8")) : null);

//: The writes another process can make while a start is under way. Each goes through its own store.
const CONCURRENT = {
  set: (other) => other.set("lead", agent({ model: "m2" }), { installed: ALL }),
  remove: (other) => other.remove("lead"),
  recreate: async (other) => { await other.remove("lead"); await other.set("lead", agent({ model: "m2" }), { installed: ALL }); },
};

test("THE DEFINITION IT WAS BUILT FROM: it starts; and a launch with no definition is not checked", async () => {
  const { store, launch } = await definedLead();
  assert.equal((await startWith(store, launch)).result.outcome, "started");
  const plain = await startWith(store, { ...launch, agentId: "nobody-defines-this", definition: null });
  assert.equal(plain.result.outcome, "started", "an undefined agent's launch carries none and starts");
});

for (const [label, change, reason] of [
  ["changed since it was queued", (store) => store.set("lead", agent({ model: "m2" }), { installed: ALL }),
    "lead changed since this start was queued: revision 1 -> 2; start it again"],
  ["withdrawn", (store) => store.remove("lead"), "lead was withdrawn on this host"],
]) {
  test(`A DEFINITION ${label.toUpperCase()} refuses the start before any process exists`, async () => {
    const { store, launch } = await definedLead();
    await change(store);
    const { result, reports, starts } = await startWith(store, launch);
    assert.deepEqual([result.outcome, result.detail], ["refused", reason]);
    assert.deepEqual(starts, [], "no process was started");
    assert.deepEqual(reports.map((r) => [r.status, r.error]), [["failed", reason]], "the control says why");
  });
}

for (const [kind, write] of Object.entries(CONCURRENT)) {
  test(`A ${kind.toUpperCase()} DURING THE START waits until the process exists; the worker is the revision it was built from`, async () => {
    const { dir, store, launch } = await definedLead();
    const entered = deferred();
    const release = deferred();
    const seenAtStart = [];
    const order = [];
    const { api, reports } = host(launch);
    const processes = {
      async start() {
        entered.resolve();
        await release.promise;
        seenAtStart.push(onDisk(dir)?.agent?.model ?? "absent");
        order.push("process");
        return { id: "proc-1", pid: 1, cols: 80, rows: 24 };
      },
      subscribe() { return () => {}; },
      list() { return []; },
    };
    const pending = control(store, { api, processes });
    await entered.promise;
    const writing = write(new DefinitionStore({ dir, lockWaitMs: 5000 })).then(() => order.push("write"));
    await settleFor(150);
    assert.equal(onDisk(dir)?.agent?.model, "m1", "nothing was written while the start held the file");
    release.resolve();
    const result = await pending;
    await writing;
    assert.deepEqual([result.outcome, seenAtStart, order], ["started", ["m1"], ["process", "write"]]);
    assert.deepEqual(reports.map((r) => r.status), ["completed"]);
  });

  test(`A ${kind.toUpperCase()} DURING THE RUNNER'S CHECKPOINT LOAD waits until the child exists`, async () => {
    const { dir, store, launch } = await definedLead();
    const loading = deferred();
    const release = deferred();
    const seenAtChild = [];
    const runner = new Runner({
      managedHost: () => ({ instance: "default", url: "http://127.0.0.1:1",
        host: { startManaged() {}, endManaged: () => ({ problem: "" }) } }),
      openTerminal: () => {
        seenAtChild.push(onDisk(dir)?.agent?.model ?? "absent");
        return { pid: 0, cols: 80, rows: 24, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {}, resize: () => {} };
      },
      loadCheckpoint: async () => { loading.resolve(); await release.promise; return null; },
    });
    const { api } = host(launch);
    const pending = control(store, { api, processes: new PluginProcesses(runner) },
      () => ({ spec: { service: "aify-comms", fileText: LAUNCHER_TEXT, command: "fake", args: [], cwd: "C:/work", env: {} } }));
    await loading.promise;
    const writing = write(new DefinitionStore({ dir, lockWaitMs: 5000 }));
    await settleFor(150);
    release.resolve();
    const result = await pending;
    await writing;
    assert.deepEqual([result.outcome, seenAtChild], ["started", ["m1"]], "the child was made while the file was its definition");
    assert.notEqual(onDisk(dir)?.agent?.model, "m1", "and the write landed after it");
  });
}

test("A LAUNCH FROM NO DEFINITION does not wait on the store: it starts while another start holds it", async () => {
  const { store, launch } = await definedLead();
  const holding = deferred();
  const release = deferred();
  const held = store.admitStart(launch, async () => { holding.resolve(); await release.promise; return "first"; });
  await holding.promise;
  try {
    const plain = await startWith(store, { ...launch, agentId: "nobody-defines-this", definition: null });
    assert.equal(plain.result.outcome, "started", "an undefined agent's start keeps the rules it had");
  } finally {
    release.resolve();
  }
  assert.deepEqual(await held, { produced: "first" });
});
