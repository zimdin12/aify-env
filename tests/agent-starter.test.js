#!/usr/bin/env node
// Starting a known agent that has no running worker.
//
// TWO OF THESE TESTS GUARD MEASURED INCIDENTS RATHER THAN HYPOTHETICALS.
//
//   A CONTROL THAT CARRIES A BRIEF restarts the agent it just started. A control's body once became
//   the spawn's `initial_message`, which the service turns into a real `type=request` message plus a
//   dispatch run addressed to the new worker -- and 21 self-issued spawn requests on this fleet each
//   followed one of those by 45 to 75 seconds. That is the whole of the operator's "agents exited
//   even though I never stopped them".
//
//   A SNAPSHOT IS NOT EVIDENCE AT THE MOMENT OF ACTING. The menu is built seconds before the
//   operator confirms, and an agent can come up in between. Starting anyway gives it two workers --
//   the shape the service produced against itself on 2026-09-03, asking for replacements for
//   terminals that were still running.
//
// SINCE D8 ONLY A DEFINED AGENT IS STARTED, through `startAgent`; `startable-agents.test.js` holds the
// refusal of an agent no host defines.
//
// NO NETWORK. The api is a recording fake, so every call this makes is inspectable and none of them
// can reach the operator's live fleet.

import assert from "node:assert/strict";
import test from "node:test";

import { AgentStarter } from "../lib/plugins/aify-comms/agent-starter.mjs";

const HERE = "win32:stevenz-l";

/** An api that records what it was asked and answers however the test needs. */
function fakeApi({ roster, startAnswer = { ok: true, queued: true }, throwsOn = "" } = {}) {
  const calls = [];
  return {
    calls,
    async agents() {
      calls.push({ call: "agents" });
      if (throwsOn === "agents") throw new Error("connection refused");
      return roster;
    },
    async startAgent(...args) {
      // EVERY ARGUMENT IS RECORDED, because what this guards is something ARRIVING beside the id: a
      // double that kept only the first could not tell a start that carries a brief from one that
      // does not.
      calls.push({ call: "startAgent", args });
      if (throwsOn === "startAgent") throw new Error("connection refused");
      return startAnswer;
    },
  };
}

/** This host's definition store, defining each id as a managed agent (or as `mode`). */
function store(ids, mode = "managed") {
  return {
    list: async () => ({ storeId: "s1", definitions: ids.map((id) => ({ id, problems: [],
      agent: { id, name: id, role: "coder", harness: "claude", mode } })) }),
  };
}

const ONE_STARTABLE = {
  agents: { "ef-tester": { sessionMode: "managed", machineId: HERE, status: "available", name: "ef-tester", runtime: "claude-code" } },
};
const starterFor = (api, ids = ["ef-tester"], mode = "managed") => new AgentStarter({ api, machineId: HERE, definitions: store(ids, mode) });
const starts = (api) => api.calls.filter((c) => c.call === "startAgent");

test("POSITIVE CONTROL: a startable agent is started through the agent-level start", async () => {
  const api = fakeApi({ roster: ONE_STARTABLE });
  const result = await starterFor(api).start("ef-tester");
  assert.deepEqual(result, { started: true, agentId: "ef-tester", sessionId: "", problem: "" });
  assert.deepEqual(api.calls.at(-1), { call: "startAgent", args: ["ef-tester"] });
});

test("THE ROSTER IS READ AGAIN AT THE MOMENT OF ACTING, not taken from the caller's snapshot", async () => {
  // Without this, `start` would trust whatever the menu was built from and there would be no second
  // reading at all -- so an agent that came up in between gets a second worker.
  const api = fakeApi({ roster: ONE_STARTABLE });
  await starterFor(api).start("ef-tester");
  assert.equal(api.calls[0].call, "agents", "no fresh roster was read before starting");
});

test("AN AGENT THAT CAME UP IN BETWEEN IS REFUSED by the fresh roster, and no start is sent", async () => {
  const cameUp = { agents: { "ef-tester": { sessionMode: "managed", machineId: HERE, status: "online" } } };
  const api = fakeApi({ roster: cameUp });
  const result = await starterFor(api).start("ef-tester");
  assert.equal(result.started, false);
  assert.match(result.problem, /live worker/);
  assert.deepEqual(starts(api), [], "a start was sent anyway");
});

test("NO START IS SENT FOR AN AGENT THIS HOST MAY NOT START", async () => {
  // Every refusal above would be satisfied by a function that returns a message AND sends the
  // request anyway. This is the assertion that the wire stayed quiet.
  const row = (over = {}) => ({ agents: { a: { sessionMode: "managed", machineId: HERE, status: "available", ...over } } });
  const cases = [
    ["a resident", row(), ["a"], "resident"],
    ["an agent another machine defines", row({ definition: { state: "defined", ownerMachineId: "linux:laputa" } }), ["a"], "managed"],
    ["a spawn already in flight", row({ status: "starting" }), ["a"], "managed"],
    ["an agent no host defines", row(), [], "managed"],
    ["an unknown agent", { agents: {} }, ["a"], "managed"],
  ];
  for (const [what, roster, ids, mode] of cases) {
    const api = fakeApi({ roster });
    const result = await starterFor(api, ids, mode).start("a");
    assert.equal(result.started, false, `${what} was started`);
    assert.deepEqual(starts(api), [], `${what}: a start was sent`);
  }
  // POSITIVE CONTROL: the same row, defined here as managed, is started.
  const api = fakeApi({ roster: row() });
  assert.equal((await starterFor(api, ["a"]).start("a")).started, true);
  assert.equal(starts(api).length, 1);
});

test("THE START CARRIES NO BRIEF, because a brief becomes a message the new worker answers", async () => {
  // The starter hands `startAgent` the id and nothing else; the body that call puts on the wire is
  // pinned field by field in `aify-comms-api.test.js`.
  const api = fakeApi({ roster: ONE_STARTABLE });
  await starterFor(api).start("ef-tester");
  assert.deepEqual(starts(api).map((c) => c.args), [["ef-tester"]],
    `the start carried more than the agent's id: ${JSON.stringify(starts(api))}`);
});

test("IT NEVER THROWS, from either call, because a keyboard handler is upstream", async () => {
  for (const throwsOn of ["agents", "startAgent"]) {
    const api = fakeApi({ roster: ONE_STARTABLE, throwsOn });
    const result = await starterFor(api).start("ef-tester");
    assert.equal(result.started, false, `${throwsOn} threw and was reported as started`);
    assert.ok(result.problem.length > 0, `${throwsOn} failed with no reason`);
  }
});

// ── the list ─────────────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: the list names the startable agents on this host", async () => {
  const { agents, problem } = await starterFor(fakeApi({ roster: ONE_STARTABLE })).list();
  assert.equal(problem, "");
  assert.deepEqual(agents.map((a) => a.id), ["ef-tester"]);
});

test("AN UNREACHABLE SERVICE SAYS SO, rather than looking like a host with nothing to start", async () => {
  // Those two render identically -- an empty list -- and one of them means the operator should look
  // at aify-comms rather than at their agents.
  const { agents, problem } = await new AgentStarter({ api: fakeApi({ throwsOn: "agents" }), machineId: HERE }).list();
  assert.deepEqual(agents, []);
  assert.match(problem, /did not answer/);
});

test("AN UNKNOWN MACHINE IDENTITY IS REPORTED, and starts nothing", async () => {
  const api = fakeApi({ roster: ONE_STARTABLE });
  const starter = new AgentStarter({ api, machineId: "", definitions: store(["ef-tester"]) });
  assert.match((await starter.list()).problem, /which machine it is/);
  assert.equal((await starter.start("ef-tester")).started, false);
  assert.deepEqual(api.calls, [], "an environment that cannot name itself still called the service");
});

test("A STARTER WITH NO API REFUSES TO EXIST, rather than failing on first use", () => {
  assert.throws(() => new AgentStarter({ machineId: HERE }), /needs an api/);
});

console.log("agent-starter.test.js: all assertions passed");
