#!/usr/bin/env node
// The two routes that let a client on the other side of loopback start a known agent.
//
// WHY THEY EXIST rather than the client asking aify-comms itself: the client has no credential and
// no endpoint. The service plugin holds both, this daemon holds the plugin, so the capability lives
// where the credential does and both tiers reach one implementation.
//
// NOTHING HERE BINDS A PORT OR STARTS A DAEMON. `handleRequest` is pure request-in / response-out,
// and importing `bin/aify-env.mjs` would START a daemon that supersedes the operator's and reaps its
// managed workers. That is not a hypothetical: it has happened twice in this project.

import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../lib/protocol.mjs";
import { ServicePlugins } from "../lib/service-plugins.mjs";

/** The smallest deps `handleRequest` needs, plus whatever this test is about. */
function deps(extra = {}) {
  return {
    runner: { list: () => [], stop: async () => {} },
    readFile: () => "",
    version: "0.6.3",
    ...extra,
  };
}

/** A capability that records what it was asked. */
function fakeAgents({ list = { agents: [], problem: "" }, start = { started: true, agentId: "a", sessionId: "s1", problem: "" } } = {}) {
  const calls = [];
  return {
    calls,
    list: async () => { calls.push({ call: "list" }); return list; },
    start: async (agentId) => { calls.push({ call: "start", agentId }); return start; },
  };
}

test("POSITIVE CONTROL: the list route answers with what the capability returned", async () => {
  const agents = fakeAgents({ list: { agents: [{ id: "ef-tester", status: "available" }], problem: "" } });
  const answer = await handleRequest({ method: "GET", path: "/agents/startable" }, deps({ agents }));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.agents.map((a) => a.id), ["ef-tester"]);
  assert.equal(answer.body.problem, "");
});

test("A HOST WITH NO SUCH PLUGIN ANSWERS 503, not an empty list", async () => {
  // Those two render identically -- "nothing to start" -- and one of them means the operator should
  // look at their plugin configuration rather than at their agents.
  const answer = await handleRequest({ method: "GET", path: "/agents/startable" }, deps({ agents: null }));
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.body.agents, [], "the body shape must not change with the status");
  assert.match(answer.body.problem, /no service plugin/);
});

test("THE LIST BODY ALWAYS CARRIES BOTH FIELDS, so a view has one shape to render", async () => {
  // A capability that answered with nothing, or with a partial object, would otherwise reach the
  // view as `undefined.map` -- inside a redraw, which is a screen that dies.
  for (const list of [undefined, null, {}, { agents: undefined }, { problem: null }]) {
    const answer = await handleRequest({ method: "GET", path: "/agents/startable" }, deps({ agents: fakeAgents({ list }) }));
    assert.ok(Array.isArray(answer.body.agents), `${JSON.stringify(list)} produced a non-array \`agents\``);
    assert.equal(typeof answer.body.problem, "string");
  }
});

test("POSITIVE CONTROL: the start route passes the id through and reports a start", async () => {
  const agents = fakeAgents();
  const answer = await handleRequest({ method: "POST", path: "/agents/ef-tester/start", body: {} }, deps({ agents }));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.started, true);
  assert.deepEqual(agents.calls, [{ call: "start", agentId: "ef-tester" }]);
});

test("A REFUSED START IS 409 AND SAYS WHY, so neither signal alone misleads", async () => {
  // A refusal is an ordinary answer here -- the agent came up in between, it has no session, the
  // service said no -- carrying a reason no status code can express. 200 with `started: false` reads
  // as success to a caller that checks `response.ok`; 409 with no body loses the reason. Both.
  const agents = fakeAgents({ start: { started: false, agentId: "a", sessionId: "", problem: "it already has a running session" } });
  const answer = await handleRequest({ method: "POST", path: "/agents/a/start", body: {} }, deps({ agents }));
  assert.equal(answer.status, 409);
  assert.equal(answer.body.started, false);
  assert.match(answer.body.problem, /running session/);
});

test("STARTING NEEDS A NAME: `/agents//start` is not a route", async () => {
  // Without the empty-id refusal in the matcher, this reaches the handler with an empty agent id and
  // every guard downstream has to remember to refuse it.
  for (const path of ["/agents//start", "/agents/start"]) {
    const answer = await handleRequest({ method: "POST", path, body: {} }, deps({ agents: fakeAgents() }));
    assert.equal(answer.status, 404, `${path} reached a handler`);
  }
});

test("`/agents/startable` IS NOT READ AS AN AGENT CALLED `startable`", async () => {
  // The two patterns share a prefix. If the start matcher were tried first, or matched loosely, a
  // GET of the list would be an attempt to start something.
  const agents = fakeAgents();
  await handleRequest({ method: "GET", path: "/agents/startable" }, deps({ agents }));
  assert.deepEqual(agents.calls, [{ call: "list" }], "listing reached the start capability");
});

test("THE VERBS ARE PINNED: a GET cannot start and a POST cannot list", async () => {
  // 405 rather than a silent fall-through, which is the rule the rest of this table already follows.
  const listedByPost = await handleRequest({ method: "POST", path: "/agents/startable", body: {} }, deps({ agents: fakeAgents() }));
  assert.equal(listedByPost.status, 405);
  const startedByGet = await handleRequest({ method: "GET", path: "/agents/a/start" }, deps({ agents: fakeAgents() }));
  assert.equal(startedByGet.status, 405);
});

// ── how the host finds the capability ────────────────────────────────────────────────────────────

test("A CAPABILITY IS ONLY OFFERED BY A STARTED PLUGIN", async () => {
  // Registered is not started. A plugin whose start threw has no working api behind it, and handing
  // its capability out produces a route that answers with a connection error instead of saying the
  // plugin is not running.
  const plugins = new ServicePlugins();
  const capability = { list: async () => ({ agents: [], problem: "" }), start: async () => ({ started: false }) };
  assert.equal(plugins.register({
    name: "broken", capabilities: { agents: capability },
    start: async () => { throw new Error("no credential"); }, stop: async () => {},
  }), "");
  assert.equal(plugins.capability("agents"), null, "a registered-but-unstarted plugin offered its capability");

  const failures = await plugins.startAll({});
  assert.equal(failures.length, 1, "positive control: the start was supposed to fail");
  assert.equal(plugins.capability("agents"), null, "a plugin that FAILED to start offered its capability");
});

test("POSITIVE CONTROL: a started plugin's capability is found by name", async () => {
  const plugins = new ServicePlugins();
  const capability = { list: async () => ({ agents: [{ id: "x" }], problem: "" }) };
  plugins.register({ name: "svc", capabilities: { agents: capability }, start: async () => {}, stop: async () => {} });
  await plugins.startAll({});
  assert.equal(plugins.capability("agents"), capability);
  assert.equal(plugins.capability("nothing-offers-this"), null);
  assert.equal(plugins.capability(""), null);
});

test("A CAPABILITY CANNOT BE THE PLUGIN'S OWN LIFECYCLE METHOD", async () => {
  // The reason capabilities live under their own key. `start` on a plugin is "boot this plugin"; a
  // route wired to a bare property called `start` would reboot the plugin instead of starting an
  // agent, and both are functions taking one argument, so nothing would complain.
  const plugins = new ServicePlugins();
  let booted = 0;
  plugins.register({ name: "svc", start: async () => { booted += 1; }, stop: async () => {} });
  await plugins.startAll({});
  assert.equal(booted, 1);
  assert.equal(plugins.capability("start"), null, "the plugin's lifecycle start was handed out as a capability");
});

console.log("agent-start-routes.test.js: all assertions passed");
