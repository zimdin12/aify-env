#!/usr/bin/env node
// Starting a known agent that has no running worker.
//
// TWO OF THESE TESTS GUARD MEASURED INCIDENTS RATHER THAN HYPOTHETICALS.
//
//   A CONTROL THAT CARRIES A BRIEF restarts the agent it just started. The route stores `body` as the
//   spawn's `initial_message`, which the service turns into a real `type=request` message plus a
//   dispatch run addressed to the new worker -- and 21 self-issued spawn requests on this fleet each
//   followed one of those by 45 to 75 seconds. That is the whole of the operator's "agents exited
//   even though I never stopped them".
//
//   A SNAPSHOT IS NOT EVIDENCE AT THE MOMENT OF ACTING. The menu is built seconds before the
//   operator confirms, and an agent can come up in between. Starting anyway gives it two workers --
//   the shape the service produced against itself on 2026-09-03, asking for replacements for
//   terminals that were still running.
//
// NO NETWORK. The api is a recording fake, so every call this makes is inspectable and none of them
// can reach the operator's live fleet.

import assert from "node:assert/strict";
import test from "node:test";

import { AgentStarter } from "../lib/plugins/aify-comms/agent-starter.mjs";

const HERE = "win32:stevenz-l";

/** An api that records what it was asked and answers however the test needs. */
function fakeApi({ roster, sessions, control = { ok: true }, throwsOn = "" } = {}) {
  const calls = [];
  return {
    calls,
    async agents() {
      calls.push({ call: "agents" });
      if (throwsOn === "agents") throw new Error("connection refused");
      return roster;
    },
    async sessionsFor(agentId) {
      calls.push({ call: "sessionsFor", agentId });
      if (throwsOn === "sessionsFor") throw new Error("connection refused");
      return sessions;
    },
    async controlSession(sessionId, action, options = {}) {
      // THE OPTIONS ARE RECORDED, because the starter's whole reason for choosing this session is
      // a precondition it must carry to the authority -- and a double that drops the third argument
      // cannot tell a start that states it from one that does not.
      calls.push({ call: "controlSession", sessionId, action, options });
      if (throwsOn === "controlSession") throw new Error("connection refused");
      return control;
    },
  };
}

const ONE_STARTABLE = {
  agents: { "ef-tester": { sessionMode: "managed", machineId: HERE, status: "available", name: "ef-tester", runtime: "claude-code" } },
};
const ONE_DEAD_SESSION = { sessions: [{ id: "s1", status: "stopped", lastSeen: "2026-09-08T04:00:00Z" }] };

test("POSITIVE CONTROL: a startable agent is started, and the control names its session", async () => {
  const api = fakeApi({ roster: ONE_STARTABLE, sessions: ONE_DEAD_SESSION });
  const result = await new AgentStarter({ api, machineId: HERE }).start("ef-tester");
  assert.deepEqual(result, { started: true, agentId: "ef-tester", sessionId: "s1", problem: "" });
  assert.deepEqual(api.calls.at(-1), {
    call: "controlSession", sessionId: "s1", action: "restart",
    // THE RACE REVIEW TRACED: this session was chosen because the listing showed nothing live, and
    // that reading is a round trip old. The authority re-evaluates the belief before it acts.
    options: { onlyIfNoLiveSession: true },
  });
});

test("THE ROSTER IS READ AGAIN AT THE MOMENT OF ACTING, not taken from the caller's snapshot", async () => {
  // Without this, `start` would trust whatever the menu was built from and there would be no second
  // reading at all -- so an agent that came up in between gets a second worker.
  const api = fakeApi({ roster: ONE_STARTABLE, sessions: ONE_DEAD_SESSION });
  await new AgentStarter({ api, machineId: HERE }).start("ef-tester");
  assert.equal(api.calls[0].call, "agents", "no fresh roster was read before starting");
});

test("AN AGENT THAT CAME UP IN BETWEEN IS REFUSED, by the roster and by the session list separately", async () => {
  // TWO INDEPENDENT SOURCES, because the roster's status is a derived cache and the session listing
  // is the row a restart acts on. Either one saying "live" is enough to stop.
  const cameUp = { agents: { a: { sessionMode: "managed", machineId: HERE, status: "online" } } };
  const byRoster = await new AgentStarter({ api: fakeApi({ roster: cameUp, sessions: ONE_DEAD_SESSION }), machineId: HERE }).start("a");
  assert.equal(byRoster.started, false);
  assert.match(byRoster.problem, /live worker/);

  const staleRoster = { agents: { a: { sessionMode: "managed", machineId: HERE, status: "available" } } };
  const liveSession = { sessions: [{ id: "s1", status: "running", lastSeen: "2026-09-08T04:00:00Z" }] };
  const api = fakeApi({ roster: staleRoster, sessions: liveSession });
  const bySession = await new AgentStarter({ api, machineId: HERE }).start("a");
  assert.equal(bySession.started, false, "a running session was restarted because the roster said available");
  assert.match(bySession.problem, /running session/);
  assert.equal(api.calls.filter((c) => c.call === "controlSession").length, 0, "a control was sent anyway");
});

test("NO CONTROL IS SENT FOR AN AGENT THIS HOST MAY NOT START", async () => {
  // Every refusal above would be satisfied by a function that returns a message AND sends the
  // request anyway. This is the assertion that the wire stayed quiet.
  const cases = [
    ["a resident", { agents: { a: { sessionMode: "resident", machineId: HERE, status: "offline" } } }],
    ["another machine", { agents: { a: { sessionMode: "managed", machineId: "linux:laputa", status: "available" } } }],
    ["a spawn already in flight", { agents: { a: { sessionMode: "managed", machineId: HERE, status: "starting" } } }],
    ["an unknown agent", { agents: {} }],
  ];
  for (const [what, roster] of cases) {
    const api = fakeApi({ roster, sessions: ONE_DEAD_SESSION });
    const result = await new AgentStarter({ api, machineId: HERE }).start("a");
    assert.equal(result.started, false, `${what} was started`);
    assert.deepEqual(api.calls.filter((c) => c.call === "controlSession"), [], `${what}: a control was sent`);
  }
});

test("THE CONTROL CARRIES NO BRIEF, because a brief becomes a message the new worker answers", async () => {
  // THE GUARANTEE IS THAT NO BRIEF CAN TRAVEL, and the mechanism used to be that `controlSession`
  // had nowhere to put one. v0.6.3 gave it a third argument for the caller's PRECONDITION, so the
  // guarantee is now stated directly instead of resting on an absent parameter: the options object
  // carries exactly the precondition, and nothing anywhere in the call names a body.
  //
  // The defect this guards has a measurement behind it: 21 self-issued spawn requests on this fleet,
  // each 45-75s after a restart, because the service turns a non-empty `body` into a real message
  // and the fresh worker answered it.
  const api = fakeApi({ roster: ONE_STARTABLE, sessions: ONE_DEAD_SESSION });
  await new AgentStarter({ api, machineId: HERE }).start("ef-tester");
  const sent = api.calls.at(-1);
  assert.deepEqual(Object.keys(sent).sort(), ["action", "call", "options", "sessionId"],
    `the control carried more than a session, an action and a precondition: ${JSON.stringify(sent)}`);
  assert.deepEqual(Object.keys(sent.options).sort(), ["onlyIfNoLiveSession"],
    `the options carried more than the precondition: ${JSON.stringify(sent.options)}`);
  assert.doesNotMatch(JSON.stringify(sent), /body|message|brief/i,
    `something brief-shaped reached the control: ${JSON.stringify(sent)}`);
});

test("A REFUSAL ANSWERED WITH 200 IS STILL A REFUSAL", async () => {
  // The route can answer `{ok: false}` with a 200. Reading only the transport would report a
  // restart that never happened, and the operator would wait for a worker that is not coming.
  const api = fakeApi({ roster: ONE_STARTABLE, sessions: ONE_DEAD_SESSION, control: { ok: false, error: "environment offline" } });
  const result = await new AgentStarter({ api, machineId: HERE }).start("ef-tester");
  assert.equal(result.started, false);
  assert.match(result.problem, /environment offline/);
});

test("IT NEVER THROWS, from any of the three calls, because a keyboard handler is upstream", async () => {
  for (const throwsOn of ["agents", "sessionsFor", "controlSession"]) {
    const api = fakeApi({ roster: ONE_STARTABLE, sessions: ONE_DEAD_SESSION, throwsOn });
    const result = await new AgentStarter({ api, machineId: HERE }).start("ef-tester");
    assert.equal(result.started, false, `${throwsOn} threw and was reported as started`);
    assert.ok(result.problem.length > 0, `${throwsOn} failed with no reason`);
  }
});

// ── the list ─────────────────────────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: the list names the startable agents on this host", async () => {
  const { agents, problem } = await new AgentStarter({ api: fakeApi({ roster: ONE_STARTABLE }), machineId: HERE }).list();
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
  const api = fakeApi({ roster: ONE_STARTABLE, sessions: ONE_DEAD_SESSION });
  const starter = new AgentStarter({ api, machineId: "" });
  assert.match((await starter.list()).problem, /which machine it is/);
  assert.equal((await starter.start("ef-tester")).started, false);
  assert.deepEqual(api.calls, [], "an environment that cannot name itself still called the service");
});

test("A STARTER WITH NO API REFUSES TO EXIST, rather than failing on first use", () => {
  assert.throws(() => new AgentStarter({ machineId: HERE }), /needs an api/);
});

console.log("agent-starter.test.js: all assertions passed");
