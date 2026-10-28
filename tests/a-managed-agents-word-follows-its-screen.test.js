// A managed agent's word follows what its terminal's screen shows (comms-tech-lead's review, 2026-10-28).
//
// THE GAP. The comms plugin has watched every carried terminal's screen since 0.9.8 and told aify-comms what it saw,
// but readAgentStates never handed that to the state host, so a claude idle at its prompt with a background shell, or
// stalled at a dialog, read `idle` (the TUI's `online`). Surveyed on this host's live terminals on 2026-10-28 (27
// screens, 5 claude and 4 hermes agents, three samples): 7 words change, all `idle` -> `shell`, each with a shell or a
// running process on its screen; 4 causes change `turn-open` -> `screen` with the word unchanged; no screen read
// `blocked` and none changed falsely.
//
// THE BAR SET FOR IT: a plain idle screen must read `idle`, and a screen counts only for the agent's current lifetime.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const NOW = 1_790_950_000_600_000;
const lifetime = (n) => `7f3c9e2a-0000-4000-8000-${String(n).padStart(12, "0")}`;

function managedHost(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-screen-word-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = new AgentStateHost({ aifyHome: home, instance: "default", population: "managed", nowUs: () => NOW,
    probe: (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: NOW - 5, commandLine: "claude" }])) });
  host.boot();
  host.startManaged({ agentId: "worker", lifetime: lifetime(1), instance: "default", pid: 99, handle: "p1" });
  return { home, host };
}
const GIVEN = new Map([["worker", { definition: "valid", stoppedByOperator: false, mode: "managed" }]]);
const word = (host, screens) => {
  const row = host.readAll(GIVEN, {}, new Map(Object.entries(screens))).agents.find((agent) => agent.agentId === "worker");
  return `${row.state}/${row.stateCause}`;
};

test("a plain idle screen reads idle, and no sighting reads as before", (t) => {
  const { host } = managedHost(t);
  assert.equal(word(host, {}), "idle/at-prompt", "the control: no screen at all");
  assert.equal(word(host, { p1: { handle: "p1", state: "idle", rule: "live_prompt_box" } }), "idle/at-prompt");
});

test("a prompt with background work reads shell; a working screen, working; a dialog, blocked by its name", (t) => {
  const { host } = managedHost(t);
  assert.equal(word(host, { p1: { handle: "p1", state: "shell", rule: "aify_background_shell" } }), "shell/at-prompt");
  assert.equal(word(host, { p1: { handle: "p1", state: "working", rule: "osc_title_working" } }), "working/screen");
  assert.equal(word(host, { p1: { handle: "p1", state: "blocked", rule: "folder-trust" } }), "blocked/folder-trust");
  assert.equal(word(host, { p1: { handle: "p1", state: "blocked", rule: "bash_permission_prompt" } }), "blocked/bash_permission_prompt");
});

test("a screen counts only for the handle of the agent's current lifetime", (t) => {
  const { host } = managedHost(t);
  assert.equal(word(host, { p0: { handle: "p0", state: "blocked", rule: "folder-trust" } }), "idle/at-prompt",
    "another process's screen decided this agent's word");
  host.endManaged(lifetime(1));
  host.startManaged({ agentId: "worker", lifetime: lifetime(2), instance: "default", pid: 98, handle: "p2" });
  assert.equal(word(host, { p1: { handle: "p1", state: "shell", rule: "aify_background_shell" } }), "idle/at-prompt",
    "the previous lifetime's terminal decided the new one's word");
  assert.equal(word(host, { p2: { handle: "p2", state: "shell", rule: "aify_background_shell" } }), "shell/at-prompt");
});

test("THROUGH /agents/state: every plugin's offer is read, and one that throws is said and costs only its own", async (t) => {
  const { home, host } = managedHost(t);
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  await definitions.set("worker", { name: "Worker", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w", model: "",
    effort: "", instructions: "", env: {}, herdrSpace: true }, { installed: new Set(["claude"]) });
  const deps = { stateHost: host, definitions, observedHarnesses: () => new Set(["claude"]), lifecycle: { stopFacts: () => new Map() } };
  const read = async (screens) => (await handleRequest({ method: "GET", path: "/agents/state" }, { ...deps, screens })).body;

  const plain = await read(undefined);
  assert.equal(plain.agents.find((a) => a.agentId === "worker").state, "idle", "the control: no offer at all");
  assert.deepEqual(plain.inputs, { operatorStop: "tracked" });
  // A FAILED SCREEN READ IS NOT AN INCOMPLETE ENUMERATION: the publisher withholds every word from one of those.
  const said = (body) => { assert.equal(body.complete, true); assert.deepEqual(body.problems, []); assert.equal(body.inputs.screens, "unavailable"); };
  const offered = await read(() => [() => { throw new Error("a plugin's book broke"); },
    () => [{ handle: "p1", state: "shell", rule: "aify_background_shell" }]]);
  assert.equal(offered.agents.find((a) => a.agentId === "worker").state, "shell");
  said(offered);
  // A source that cannot even list its offers costs the sightings, never the read.
  const broken = await read(() => { throw new Error("no capabilities here"); });
  assert.equal(broken.agents.find((a) => a.agentId === "worker").state, "idle");
  said(broken);
});

test("the daemon hands the plugins' screens to every state read: /agents/state, the sender and the Herdr panes", () => {
  const source = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const offer = 'screens: () => servicePlugins.capabilities("screens"),';
  const between = (from, to) => { const at = source.indexOf(from); return at < 0 ? "" : source.slice(at, source.indexOf(to, at)); };
  const protocol = between("protocolDeps: async () => (", "advertisingEnabled: ADVERTISE");
  const observation = between("const stateObservation = {", "};");
  const sender = between("const sendFor = (", "agentStateSender = sendFor(");
  const panes = between("paneOpener = paneOpenerFor({", "});");
  assert.ok(protocol.includes(offer), "GET /agents/state is not given the plugins' screens");
  assert.ok(observation.includes(offer), "the observation the sender and the panes read is not given the plugins' screens");
  assert.ok(sender.includes("...stateObservation,"), "the agent-state sender does not read that observation");
  assert.ok(panes.includes("observation: { stateHost: agentState.host, ...stateObservation }"), "the Herdr panes do not read that observation");
});

test("THROUGH THE SENDER: the published snapshot carries the word the screen decides", async (t) => {
  const { AgentStateSender } = await import("../lib/agent-state-sender.mjs");
  const { home, host } = managedHost(t);
  const definitions = new DefinitionStore({ dir: path.join(home, "defs") });
  await definitions.set("worker", { name: "Worker", role: "coder", harness: "claude", mode: "managed", workspace: "C:/w", model: "",
    effort: "", instructions: "", env: {}, herdrSpace: true }, { installed: new Set(["claude"]) });
  const posted = [];
  const sender = new AgentStateSender({ identity: { machineId: "win32:fixture", instance: "default", generation: 1, incarnationId: "screens" },
    stateHost: host, definitions, lifecycle: { stopFacts: () => new Map() }, observedHarnesses: async () => new Set(["claude"]),
    screens: () => [() => [{ handle: "p1", state: "shell", rule: "aify_background_shell" }]],
    readRegistry: () => JSON.stringify({ version: 1, services: { x: { endpoint: "http://fixture.invalid/mcp/sse", agentState: { path: "/state" } } } }),
    credentialOptions: () => ({ root: path.join(home, "credentials"), env: {} }), nowMs: () => 0,
    fetchImpl: async (_url, options) => { posted.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); },
    setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} });
  t.after(() => sender.stop());
  await sender.tick();
  for (let i = 0; i < 20 && !posted.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(posted.at(-1)?.agents.find((a) => a.agentId === "worker")?.state, "shell", JSON.stringify(posted.at(-1)?.agents));
});
