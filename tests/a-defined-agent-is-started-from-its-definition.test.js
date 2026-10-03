#!/usr/bin/env node
// An agent this host defines is offered and started by its definition (P0 C7, the host's half).
//
// Its mode is the definition's, not the roster's `sessionMode`, which reads resident until a managed
// worker registers; it is this host's because it is defined here; and it starts through the service's
// agent-level start, which builds the spawn from the definition even for an agent that never ran. An
// agent this host does not define keeps the rules it had: the roster's mode and machine, and a
// session restart.

import assert from "node:assert/strict";
import test from "node:test";

import { AgentStarter } from "../lib/plugins/aify-comms/agent-starter.mjs";
import { definitionsById, notOffered, startabilityOf, startableAgents } from "../lib/startable-agents.mjs";

const MINE = "win32:host-a";
const reading = (id, over = {}) => ({ id, problems: [], incarnation: 1, revision: 1,
  agent: { id, name: id, role: "coder", harness: "claude", mode: "managed" }, ...over });
const listed = (...readings) => ({ storeId: "s1", definitions: readings });
const rosterAgent = (over = {}) => ({ machineId: MINE, sessionMode: "managed", status: "available", ...over });

test("definitionsById keys this host's readings by id", () => {
  const byId = definitionsById(listed(reading("a"), reading("b")));
  assert.deepEqual([...byId.keys()], ["a", "b"]);
  assert.equal(byId.get("b").id, "b");
  assert.deepEqual([...definitionsById(undefined).keys()], [], "no listing, no definitions");
});

test("A DEFINITION DECIDES: its mode over the roster's, its validity, and the roster's status still", () => {
  const managed = reading("a");
  assert.deepEqual(startabilityOf(rosterAgent({ sessionMode: "resident", machineId: "" }), { machineId: MINE, definition: managed }),
    { startable: true, reason: "managed and cold-startable, no worker" }, "its row still says resident, and another machine");
  assert.deepEqual(startabilityOf(rosterAgent(), { machineId: MINE, definition: reading("a", { agent: { ...managed.agent, mode: "resident" } }) }),
    { startable: false, reason: "defined as resident: it is started through its launcher" });
  assert.deepEqual(startabilityOf(rosterAgent(), { machineId: MINE, definition: reading("a", { problems: ["agent.model: type"], agent: undefined }) }),
    { startable: false, reason: "its definition on this host is invalid (agent.model: type)" });
  assert.equal(startabilityOf(rosterAgent({ status: "online" }), { machineId: MINE, definition: managed }).startable, false,
    "a live worker is not started twice");
  assert.equal(startabilityOf(rosterAgent({ sessionMode: "resident" }), { machineId: MINE }).startable, false,
    "control: without a definition the roster's mode still decides");
});

test("AN AGENT ANOTHER MACHINE DEFINES is not started here, whatever its row remembers", () => {
  // External review of 0.8.1: the row still named this machine, so the menu offered a start of an agent whose
  // owner starts it too. The roster's `definition` is the service's word on who defines it.
  const elsewhere = { state: "defined", ownerMachineId: "win32:host-b" };
  assert.deepEqual(startabilityOf(rosterAgent({ definition: elsewhere }), { machineId: MINE }),
    { startable: false, reason: "defined on win32:host-b: it is started there" });
  assert.deepEqual(startabilityOf(rosterAgent({ definition: { state: "defined", ownerMachineId: MINE } }), { machineId: MINE }),
    { startable: false, reason: "the service holds a definition from this host that this host's store does not" });
  // A withdrawn definition is not started anywhere (C6): the service refuses it, so the menu does not offer it.
  assert.deepEqual(startabilityOf(rosterAgent({ definition: { state: "withdrawn", ownerMachineId: null } }), { machineId: MINE }),
    { startable: false, reason: "its definition was withdrawn: it is not started" });
  assert.equal(startabilityOf(rosterAgent({ definition: { state: "", ownerMachineId: null } }), { machineId: MINE }).startable, true,
    "control: an agent no host ever defined is started the ordinary way");
  assert.equal(startabilityOf(rosterAgent(), { machineId: MINE }).startable, true, "control: a row with no definition field");
});

test("THE ACCEPTED OWNER OVERRULES THIS HOST'S OWN DEFINITION (review of 0.8.2): custody moved, the old copy starts nothing", () => {
  const local = reading("a");
  assert.equal(startabilityOf(rosterAgent({ definition: { state: "defined", ownerMachineId: MINE } }), { machineId: MINE, definition: local }).startable,
    true, "control: this host's definition, accepted for this host");
  assert.deepEqual(startabilityOf(rosterAgent({ definition: { state: "defined", ownerMachineId: "win32:host-b" } }), { machineId: MINE, definition: local }),
    { startable: false, reason: "defined on win32:host-b: it is started there" });
});

test("THE LIST offers defined agents by their definitions and says which are not published yet", () => {
  const roster = { agents: {
    defined: rosterAgent({ sessionMode: "resident" }),
    // Defined here and busy, under a machine id the roster has not caught up with: still this host's.
    busy: rosterAgent({ status: "online", machineId: "" }),
    plain: rosterAgent(),
    elsewhere: rosterAgent({ machineId: "win32:host-b" }),
  } };
  const definitions = definitionsById(listed(reading("defined"), reading("busy"), reading("pending")));
  assert.deepEqual(startableAgents(roster, { machineId: MINE, definitions }).map((row) => row.id), ["defined", "plain"]);
  assert.deepEqual(notOffered(roster, { machineId: MINE, definitions }), [
    { count: 1, why: "a live worker is running" },
    { count: 1, why: "defined here, not yet published to the service" },
  ]);
  assert.deepEqual(startableAgents(roster, { machineId: MINE }).map((row) => row.id), ["plain"],
    "control: without its definition the resident row is not offered");
});

function fakeApi({ roster, startAnswer = { ok: true, spawnRequested: true } }) {
  const calls = [];
  return {
    calls,
    agents: async () => roster,
    startAgent: async (id) => { calls.push(["startAgent", id]); return startAnswer; },
    sessionsFor: async (id) => { calls.push(["sessionsFor", id]); return { sessions: [{ id: `sess-${id}`, status: "stopped", lastSeen: "1" }] }; },
    controlSession: async (id, action, options) => { calls.push(["controlSession", id, action, options]); return { ok: true }; },
  };
}
const store = (...readings) => ({ list: async () => listed(...readings) });

test("A DEFINED AGENT STARTS through the agent-level start; an undefined one through its session", async () => {
  const roster = { agents: { defined: rosterAgent({ sessionMode: "resident" }), plain: rosterAgent() } };
  const api = fakeApi({ roster });
  const starter = new AgentStarter({ api, machineId: MINE, definitions: store(reading("defined")) });
  assert.deepEqual(await starter.start("defined"), { started: true, agentId: "defined", sessionId: "", problem: "" });
  assert.deepEqual(await starter.start("plain"), { started: true, agentId: "plain", sessionId: "sess-plain", problem: "" });
  assert.deepEqual(api.calls, [
    ["startAgent", "defined"],
    ["sessionsFor", "plain"], ["controlSession", "sess-plain", "restart", { onlyIfNoLiveSession: true }],
  ]);
});

test("THE STARTER'S LIST offers what this host defines, by its definition", async () => {
  const roster = { agents: { defined: rosterAgent({ sessionMode: "resident" }), plain: rosterAgent() } };
  const starter = new AgentStarter({ api: fakeApi({ roster }), machineId: MINE, definitions: store(reading("defined")) });
  const offer = await starter.list();
  assert.deepEqual([offer.problem, offer.agents.map((row) => row.id)], ["", ["defined", "plain"]]);
});

test("A DEFINED START the service answers alreadyRunning is not a start, and an unreadable store is said", async () => {
  const roster = { agents: { defined: rosterAgent() } };
  const running = new AgentStarter({ api: fakeApi({ roster, startAnswer: { ok: true, alreadyRunning: true } }),
    machineId: MINE, definitions: store(reading("defined")) });
  assert.equal((await running.start("defined")).problem, "cannot start defined: it already has a live worker");
  const broken = new AgentStarter({ api: fakeApi({ roster }), machineId: MINE,
    definitions: { list: async () => { throw new Error("the store is locked"); } } });
  assert.equal((await broken.start("defined")).problem, "this host's agent definitions could not be read: the store is locked");
  assert.equal((await broken.list()).problem, "this host's agent definitions could not be read: the store is locked");
});
