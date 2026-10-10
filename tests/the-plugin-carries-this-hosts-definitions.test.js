#!/usr/bin/env node
// The aify-comms plugin, given this host's definition store, publishes it and checks every start
// against it (P0 C3, C7): the wiring, through `createCommsPlugin` and its real loops. What each part
// does is witnessed in its own file; this one fails if the plugin stops handing them the store.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { LifecycleJournal } from "../lib/agent-lifecycle.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { PluginHost, PluginProcesses } from "../lib/service-plugins.mjs";
import { createCommsPlugin } from "../lib/plugins/aify-comms/index.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const LAUNCHER_TEXT = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
const agent = { name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/Users/Administrator",
  model: "", effort: "", instructions: "", env: {}, herdrSpace: true };

async function until(condition, what) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("GIVEN THE STORE, the plugin publishes it and refuses a start built from an older revision", async (t) => {
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-plugin-defs-")), lockWaitMs: 300 });
  // A LAUNCHER OF ITS OWN, carrying the marker: the refusal must be the definition's, reached after the
  // launcher is found, and never depend on what this machine's PATH holds.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-plugin-launcher-"));
  const launcher = path.join(root, "claude-aify");
  fs.writeFileSync(launcher, LAUNCHER_TEXT);
  await store.set("lead", agent, { installed: ALL });
  await store.set("lead", { ...agent, model: "m2" }, { installed: ALL });
  const { storeId } = await store.list();
  const pushes = [];
  const controlReports = [];
  let controlsHandedOut = false;
  const api = {
    identity: { bridgeId: "bridge-test" },
    async heartbeat() { return {}; },
    async claim() { return {}; },
    async claimControls() {
      if (controlsHandedOut) return { controls: [] };
      controlsHandedOut = true;
      return { controls: [{ id: "ctl-1", terminalId: "term-1", action: "start" }] };
    },
    async launch() {
      return { launch: { terminalId: "term-1", agentId: "lead", runtime: "claude-code",
        argv: [launcher, "--aify-agent", "lead"], cwd: root, env: {},
        definition: { storeId, incarnation: 1, revision: 1 } } };
    },
    async reportControl(id, patch) { controlReports.push({ id, ...patch }); },
    async terminalOutput() { return {}; },
    async claimDefinitionRequests() { return { requests: [] }; },
    async claimLifecycleRequests() { return { requests: [] }; },
    async pushDefinitions(environmentId, body) { pushes.push({ environmentId, ...body }); return { ok: true, refused: [] }; },
  };
  const starts = [];
  const runner = { async start(spec) { starts.push(spec); return { id: "proc-1", pid: 1 }; },
    subscribe() {}, canStream() { return true; }, write() {}, resize() {}, async stop() {}, relabel() {}, release() {},
    list() { return []; }, history() { return {}; }, instance() { return "i"; } };
  const host = new PluginHost({ processes: new PluginProcesses(runner), environmentId: "", credential: async () => "",
    log: () => {} });
  // THE DAEMON'S LIFECYCLE PORT, as bin wires it: automatic starts reach the store through admitColdStart.
  const aifyHome = fs.mkdtempSync(path.join(os.tmpdir(), "aify-plugin-home-"));
  new LifecycleJournal({ file: path.join(aifyHome, "agent-lifecycle.json") }).initialize({ priorBoot: false });
  const cold = () => ({ current: null, conflict: false, unknown: false });
  const agents = { ...createAgentLifecyclePorts({ aifyHome, machineId: "win32:test-host",
    stateHost: { rawIdentity: cold }, runner, definitions: store }), rawIdentity: cold };
  const plugin = createCommsPlugin({
    endpoint: "http://127.0.0.1:1", machineId: "win32:test-host", windows: true, api,
    advertisement: async () => ({ hostname: "test-host", kind: "win32" }), cwdRoots: async () => [root],
    readFile: () => LAUNCHER_TEXT, definitions: store, agents, installedHarnesses: async () => ALL,
    // Timers that never fire: each loop runs its first pass and then waits for ever.
    setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
  });
  t.after(() => plugin.stop());
  await plugin.start(host);
  await until(() => pushes.length > 0 && controlReports.length > 0, "the first sync and control passes");
  assert.deepEqual([pushes[0].environmentId, pushes[0].machineId, pushes[0].storeId, pushes[0].entries[0].revision],
    ["win32:test-host:default", "win32:test-host", storeId, 2]);
  assert.deepEqual(controlReports.map((r) => [r.status, r.error]),
    [["failed", "lead changed since this start was queued: revision 1 -> 2; start it again"]]);
  assert.deepEqual(starts, [], "no process was started");
  assert.deepEqual(plugin.state().definitions.published, { storeId, revision: pushes[0].revision });
});
