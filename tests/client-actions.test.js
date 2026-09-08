#!/usr/bin/env node
// What a client does when the operator confirms an action.
//
// THIS EXISTS BECAUSE THE ENTRYPOINT CANNOT BE TESTED. Importing `bin/aify-env-tui.mjs` STARTS a view
// that talks to a daemon, so logic written there can only be READ, never exercised -- and a source
// regex proves a line was written, which is not the same as proving it does the right thing. The
// entrypoint is now one wiring line and the decisions are here.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_ACTIONS,
  listStartableAgents,
  performClientAction,
  startKnownAgent,
} from "../lib/client-actions.mjs";

/** A fetch that records what it was asked and answers however the test needs. */
function recordingFetch({ ok = true, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method, redirect: options?.redirect });
      if (throws) throw new Error("connection refused");
      return { ok };
    },
  };
}

test("POSITIVE CONTROL: a confirmed stop reaches the daemon", async () => {
  // Every "nothing was sent" assertion below would pass against a function that never sends anything.
  const f = recordingFetch();
  const sent = await performClientAction(
    { action: "stop", process: { id: "abc-p1" } },
    { endpoint: "http://127.0.0.1:8802", fetchImpl: f.impl },
  );
  assert.equal(sent, true);
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]),
    [["DELETE", "http://127.0.0.1:8802/processes/abc-p1"]]);
});

test("ONLY `stop` REACHES THE WIRE, because a verb that becomes a stop is the worst kind of wrong", async () => {
  // `attach` is the view's own business -- it moves the keyboard and touches no daemon -- and
  // `restart` is nobody's here, since respawning a managed agent is the service's work. A dispatcher
  // running its one branch for every action is how a future verb silently becomes a stop.
  const f = recordingFetch();
  for (const action of ["attach", "restart", "detonate", "", null, undefined]) {
    await performClientAction({ action, process: { id: "abc-p1" } },
      { endpoint: "http://x", fetchImpl: f.impl });
  }
  assert.deepEqual(f.calls, [], `${f.calls.length} request(s) were sent for actions that are not stop`);
});

test("NO TARGET SENDS NOTHING, rather than deleting a URL with an empty id", async () => {
  // `/processes/` with no id is a different route, and a DELETE aimed at it is a request nobody
  // intended. Absent, empty and non-string ids are all the same answer: do not send.
  const f = recordingFetch();
  for (const process of [undefined, null, {}, { id: "" }, { id: null }]) {
    await performClientAction({ action: "stop", process }, { endpoint: "http://x", fetchImpl: f.impl });
  }
  assert.deepEqual(f.calls, []);
});

test("THE ID IS ENCODED, so an id with a slash cannot address another route", async () => {
  const f = recordingFetch();
  await performClientAction({ action: "stop", process: { id: "a/b?c" } },
    { endpoint: "http://x", fetchImpl: f.impl });
  assert.equal(f.calls[0].url, "http://x/processes/a%2Fb%3Fc");
});

test("A REDIRECT IS NEVER FOLLOWED, because a DELETE is not a request to repeat elsewhere", async () => {
  // The same rule every other request in this product follows: `fetch` re-sends on a 302, and a
  // delete aimed at an address nobody chose is worse than a delete that failed.
  const f = recordingFetch();
  await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x", fetchImpl: f.impl });
  assert.equal(f.calls[0].redirect, "manual");
});

test("A TRAILING SLASH ON THE ENDPOINT DOES NOT DOUBLE UP", async () => {
  const f = recordingFetch();
  await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x:8802///", fetchImpl: f.impl });
  assert.equal(f.calls[0].url, "http://x:8802/processes/p1");
});

test("IT NEVER THROWS, because this runs inside a keyboard handler", async () => {
  // A request that did not land must not take the operator's screen down. A failed stop shows as the
  // process still being listed on the next refresh, which is the honest signal.
  const refused = recordingFetch({ throws: true });
  assert.equal(await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x", fetchImpl: refused.impl }), false);

  const rejected = recordingFetch({ ok: false });
  assert.equal(await performClientAction({ action: "stop", process: { id: "p1" } },
    { endpoint: "http://x", fetchImpl: rejected.impl }), false,
    "a non-ok response was reported as a successful stop");
});

test("the client offers what it can perform, and restart is not on that list", () => {
  // Absent from BOTH tiers. The daemon cannot restart a managed agent either -- neither has a
  // primitive for it -- so offering it anywhere would be a menu row that does nothing when chosen.
  assert.deepEqual([...CLIENT_ACTIONS], ["attach", "stop"]);
});

console.log("client-actions.test.js: all assertions passed");

// ── starting a known agent, from a client that holds no credential ───────────────────────────────
//
// ONE HOP TO THE DAEMON, not a call to aify-comms: this process has no service endpoint and no key.
// Both calls below turn every failure into a REASON rather than an empty answer, because "nothing to
// start" and "the daemon did not answer" render identically as an empty list and send the operator
// to different places.

/** A fetch that answers with a status and a JSON body, or throws. */
function answering({ status = 200, body = {}, throws = false, notJson = false } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method, redirect: options?.redirect, body: options?.body });
      if (throws) throw new Error("connection refused");
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (notJson) throw new Error("not json"); return body; },
      };
    },
  };
}

test("POSITIVE CONTROL: the startable list is read from the daemon", async () => {
  const f = answering({ body: { agents: [{ id: "ef-tester", status: "available" }], problem: "" } });
  const answer = await listStartableAgents({ endpoint: "http://127.0.0.1:8802/", fetchImpl: f.impl });
  assert.deepEqual(answer, { agents: [{ id: "ef-tester", status: "available" }], problem: "" });
  assert.equal(f.calls[0].url, "http://127.0.0.1:8802/agents/startable");
  assert.equal(f.calls[0].redirect, "manual");
});

test("A 503 STILL CARRIES ITS REASON, because the body is the part that says what to do", async () => {
  // The route answers 503 with `{agents: [], problem}` when no plugin can start agents. Reading only
  // `response.ok` would throw away the one sentence that distinguishes it from an idle host.
  const f = answering({ status: 503, body: { agents: [], problem: "no service plugin on this host can start agents" } });
  const answer = await listStartableAgents({ endpoint: "http://x", fetchImpl: f.impl });
  assert.deepEqual(answer.agents, []);
  assert.match(answer.problem, /no service plugin/);
});

test("AN UNREACHABLE DAEMON IS NOT AN EMPTY LIST", async () => {
  for (const broken of [{ throws: true }, { notJson: true, status: 500 }]) {
    const answer = await listStartableAgents({ endpoint: "http://x", fetchImpl: answering(broken).impl });
    assert.deepEqual(answer.agents, []);
    assert.ok(answer.problem.length > 0, `${JSON.stringify(broken)} came back as a silent empty list`);
  }
});

test("POSITIVE CONTROL: starting an agent posts to its own route", async () => {
  const f = answering({ body: { started: true, agentId: "ef-tester", sessionId: "s1", problem: "" } });
  const answer = await startKnownAgent("ef-tester", { endpoint: "http://x", fetchImpl: f.impl });
  assert.deepEqual(answer, { started: true, problem: "" });
  assert.deepEqual([f.calls[0].method, f.calls[0].url, f.calls[0].redirect],
    ["POST", "http://x/agents/ef-tester/start", "manual"]);
});

test("NO BRIEF TRAVELS FROM THE CLIENT EITHER", async () => {
  // The daemon's route takes none, and sending one would be a field it ignores today and a message
  // the new worker answers the day somebody forwards it. Measured on this fleet: 21 self-issued
  // spawn requests, each 45 to 75 seconds after a control that carried a polite receipt.
  const f = answering({ body: { started: true } });
  await startKnownAgent("a", { endpoint: "http://x", fetchImpl: f.impl });
  assert.deepEqual(JSON.parse(f.calls[0].body), {}, `the client sent a body: ${f.calls[0].body}`);
});

test("A REFUSED START IS REPORTED WITH ITS REASON, not as a success", async () => {
  // The route answers 409 for a refusal AND puts the reason in the body. Both signals agree, and a
  // reader of either one alone still gets the right answer.
  const f = answering({ status: 409, body: { started: false, problem: "it already has a running session" } });
  const answer = await startKnownAgent("a", { endpoint: "http://x", fetchImpl: f.impl });
  assert.equal(answer.started, false);
  assert.match(answer.problem, /running session/);
});

test("THE AGENT ID IS ENCODED, and an unnamed agent sends nothing", async () => {
  const f = answering({ body: { started: true } });
  await startKnownAgent("a/b?c", { endpoint: "http://x", fetchImpl: f.impl });
  assert.equal(f.calls[0].url, "http://x/agents/a%2Fb%3Fc/start");
  const quiet = answering({ body: { started: true } });
  assert.deepEqual(await startKnownAgent("", { endpoint: "http://x", fetchImpl: quiet.impl }),
    { started: false, problem: "no agent was named" });
  assert.deepEqual(quiet.calls, [], "a request was sent for an agent with no name");
});

test("NEITHER CALL THROWS, because both run inside a keyboard handler", async () => {
  const thrower = answering({ throws: true }).impl;
  assert.equal((await listStartableAgents({ endpoint: "http://x", fetchImpl: thrower })).agents.length, 0);
  assert.equal((await startKnownAgent("a", { endpoint: "http://x", fetchImpl: thrower })).started, false);
});
