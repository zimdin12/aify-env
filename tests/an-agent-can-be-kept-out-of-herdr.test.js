#!/usr/bin/env node
// An agent can be kept out of herdr: Tab in the start list switches whether it gets a herdr space.
//
// THE OPERATOR, 2026-09-30: "where is that hide or do not run as space option ? (so we could start
// agents that do not show up in herdr-aify". The setting is the service's (aify-comms keeps it per
// agent); this tier reaches it through its plugin. These follow it from the key to the service call,
// and back to what the list and the outcome line say.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { setAgentHerdrSpace } from "../lib/client-actions.mjs";
import { startDashboard } from "../lib/dashboard.mjs";
import { routeKey } from "../lib/keys.mjs";
import { AgentStarter } from "../lib/plugins/aify-comms/agent-starter.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { startableAgents } from "../lib/startable-agents.mjs";

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function view({ onSetHerdrSpace, agents }) {
  const frames = [];
  const input = new FakeInput();
  const handle = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: (chunk) => frames.push(String(chunk)),
    clearScreen: false,
    intervalMs: 60_000,
    columns: 120,
    rows: 40,
    input,
    actions: ["attach", "stop"],
    fetchImpl: async () => ({ ok: true, status: 200, body: null, json: async () => ({ processes: [] }) }),
    readFile: () => { throw new Error("no registry"); },
    onStartList: async () => ({ agents }),
    onStartAgent: async () => ({ started: true, problem: "" }),
    onSetHerdrSpace,
  });
  await settle();
  return { input, frames, stop: handle.stop };
}

test("Tab switches the highlighted agent, the list says so, and the outcome line reports it", async () => {
  const calls = [];
  const agents = [{ id: "bravo", name: "bravo", status: "available", herdrSpace: true }];
  const { input, frames, stop } = await view({
    agents,
    onSetHerdrSpace: async (agent, show) => { calls.push([agent.id, show]); return { ok: true, problem: "" }; },
  });
  input.emit("data", "s");
  await settle();
  input.emit("data", "\t");
  await settle();
  const screen = frames.join("");
  stop();
  assert.deepEqual(calls, [["bravo", false]], "the setting asked for is not the opposite of the agent's");
  assert.match(screen, /bravo starts without a herdr space from its next start/);
  assert.match(screen, /no herdr space/, "the list still shows the agent with a space");
});

test("a refused setting is reported with its reason, and the row is left as it was", async () => {
  const agents = [{ id: "bravo", name: "bravo", status: "available", herdrSpace: true }];
  const { input, frames, stop } = await view({
    agents,
    onSetHerdrSpace: async () => ({ ok: false, problem: "aify-comms did not store it: 404" }),
  });
  input.emit("data", "s");
  await settle();
  input.emit("data", "\t");
  await settle();
  stop();
  assert.match(frames.join(""), /herdr space for bravo not changed: aify-comms did not store it: 404/);
  assert.equal(agents[0].herdrSpace, true, "a refused change was applied to the row anyway");
});

test("Tab in an empty start list does nothing, and never types into the search", () => {
  const empty = routeKey("\t", { mode: "start", startAt: 0, startCount: 0, startQuery: "" });
  assert.equal(empty.action, null);
  const full = routeKey("\t", { mode: "start", startAt: 0, startCount: 2, startQuery: "br" });
  assert.equal(full.action, "start-toggle-space");
  assert.equal(full.state.startQuery, "br", "the tab went into the search");
});

test("the startable row carries the service's setting; only an explicit false hides the space", () => {
  const rows = startableAgents({ agents: {
    kept: { status: "available", sessionMode: "managed", machineId: "here", herdrSpace: false },
    shown: { status: "available", sessionMode: "managed", machineId: "here" },
  } }, { machineId: "here" });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.herdrSpace])), { kept: false, shown: true });
});

test("the plugin stores it through the service, and a service error is an answer, not a throw", async () => {
  const sent = [];
  const starter = new AgentStarter({ api: { setHerdrSpace: async (id, show) => { sent.push([id, show]); } }, machineId: "here" });
  assert.deepEqual(await starter.setHerdrSpace("bravo", false), { ok: true, problem: "" });
  assert.deepEqual(sent, [["bravo", false]]);
  const failing = new AgentStarter({ api: { setHerdrSpace: async () => { throw new Error("404"); } }, machineId: "here" });
  assert.deepEqual(await failing.setHerdrSpace("bravo", true), { ok: false, problem: "aify-comms did not store it: 404" });
});

test("the daemon route checks its body, and its status agrees with the answer", async () => {
  const post = (body, agents) => handleRequest({ method: "POST", path: "/agents/bravo/herdr-space", body }, { agents, runner: {}, readFile: () => "" });
  assert.equal((await post({ show: "no" }, {})).status, 400);
  assert.equal((await post({ show: false }, null)).status, 503);
  const agents = { setHerdrSpace: async (id, show) => ({ ok: id === "bravo" && show === false, problem: "" }) };
  assert.equal((await post({ show: false }, agents)).status, 200);
  assert.equal((await post({ show: true }, agents)).status, 409);
});

test("setAgentHerdrSpace posts the choice to the daemon and reads its answer", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.method, JSON.parse(init.body)]);
    return { status: 200, json: async () => ({ ok: true, problem: "" }) };
  };
  assert.deepEqual(await setAgentHerdrSpace("bravo", false, { endpoint: "http://127.0.0.1:9/", fetchImpl }), { ok: true, problem: "" });
  assert.deepEqual(seen, [["http://127.0.0.1:9/agents/bravo/herdr-space", "POST", { show: false }]]);
  const down = async () => { throw new Error("refused"); };
  assert.deepEqual(await setAgentHerdrSpace("bravo", true, { endpoint: "http://x", fetchImpl: down }),
    { ok: false, problem: "the environment did not answer: refused" });
});
