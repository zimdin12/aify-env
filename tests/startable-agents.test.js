#!/usr/bin/env node
// Which known agents this host may offer to start.
//
// THE SHAPES HERE ARE REAL. The roster fixture was measured against the operator's live service on
// 2026-09-08 (read-only, `GET /api/v1/agents`): 42 agents, five machine ids, and managed statuses
// `working`, `online`, `available`, `stopped` and `offline` all present at once. A fixture invented
// from the field names would have missed that `stopped` and `offline` are ordinary states on a
// healthy host rather than error cases.
//
// THE DANGEROUS ANSWER IS "YES". Offering an agent that already has a worker is how one agent ends
// up with two, so every refusal below is tested with a positive control in the same run -- a
// function that refused everything would satisfy the refusals alone and be useless.

import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_SESSION_STATUSES,
  NOT_STARTABLE_STATUSES,
  STARTABLE_STATUSES,
  restartTargetFor,
  startabilityOf,
  startableAgents,
} from "../lib/startable-agents.mjs";

const HERE = "win32:stevenz-l";

/** A roster in the exact shape `GET /api/v1/agents` returns. */
function roster(entries) {
  const agents = {};
  for (const [id, agent] of Object.entries(entries)) {
    agents[id] = { sessionMode: "managed", machineId: HERE, runtime: "claude-code", role: "coder", ...agent };
  }
  return { agents };
}

test("POSITIVE CONTROL: a managed agent on this host with no worker is offered", () => {
  // Every refusal below would pass against a function that returns nothing at all. This is the run
  // that proves it can say yes.
  const rows = startableAgents(roster({ "ef-tester": { status: "available" } }), { machineId: HERE });
  assert.deepEqual(rows.map((r) => r.id), ["ef-tester"]);
  assert.match(rows[0].reason, /cold-startable/);
});

test("A LIVE WORKER IS NEVER OFFERED, because starting one gives the agent two", () => {
  // Measured 2026-09-03: the service reconciled live terminals as dead ghosts, asked for
  // replacements, and the host started them beside the ones still running.
  for (const status of ["working", "online", "blocked"]) {
    const rows = startableAgents(roster({ a: { status } }), { machineId: HERE });
    assert.deepEqual(rows, [], `an agent whose status is "${status}" was offered a start`);
  }
});

test("`starting` IS REFUSED THOUGH IT HAS NO WORKER, which liveness alone would get wrong", () => {
  // The contract's own words: "A claimed spawn is coming up; no worker YET. Do NOT restart or
  // re-send - a restart kills the boot in flight." A rule written as "offer anything without a live
  // worker" offers this one, and the operator's keystroke kills a spawn that was already working.
  assert.equal(startabilityOf({ sessionMode: "managed", machineId: HERE, status: "starting" }, { machineId: HERE }).startable, false);
  assert.match(NOT_STARTABLE_STATUSES.starting, /boot in flight/);
});

test("`misconfigured` IS REFUSED, because it is a row that could only ever fail", () => {
  // "Identity exists but can never start. Not send-recoverable; a human must fix the config."
  const verdict = startabilityOf({ sessionMode: "managed", machineId: HERE, status: "misconfigured" }, { machineId: HERE });
  assert.equal(verdict.startable, false);
  assert.match(verdict.reason, /human/);
});

test("AN UNKNOWN STATUS FAILS CLOSED, so a word invented later is not silently offered", () => {
  // The rule is an allowlist for exactly this: "anything that does not look live" would offer a
  // status this file has never heard of, and the first time that mattered would be on a live fleet.
  for (const status of ["quarantined", "", null, undefined, "AVAILABLE_LATER"]) {
    const verdict = startabilityOf({ sessionMode: "managed", machineId: HERE, status }, { machineId: HERE });
    assert.equal(verdict.startable, false, `status ${JSON.stringify(status)} was offered`);
    assert.ok(verdict.reason.length > 0, "a refusal with no reason is a blank row");
  }
});

test("A RESIDENT IS NEVER OFFERED, because restarting one forks a managed twin", () => {
  // The service's own restart path refuses this in as many words. A menu row that always fails is
  // the defect this codebase keeps finding from the other end.
  for (const sessionMode of ["resident", "RESIDENT", "", undefined]) {
    const rows = startableAgents(roster({ a: { status: "available", sessionMode } }), { machineId: HERE });
    assert.deepEqual(rows, [], `sessionMode ${JSON.stringify(sessionMode)} was offered`);
  }
});

test("ANOTHER MACHINE'S AGENT IS NOT OFFERED, and the reason names where it does run", () => {
  // A restart is routed to the agent's OWN environment, so this would bring up a worker on a host
  // the operator is not looking at, from a menu on the host they are.
  const verdict = startabilityOf(
    { sessionMode: "managed", machineId: "wsl-ubuntu:stevenz-l", status: "available" },
    { machineId: HERE },
  );
  assert.equal(verdict.startable, false);
  assert.match(verdict.reason, /wsl-ubuntu:stevenz-l/);
});

test("AN UNKNOWN MACHINE IDENTITY OFFERS NOTHING, rather than matching everything", () => {
  // The comparison is against a string. With an empty one, a blank-vs-blank match would offer every
  // agent whose machine is also unknown, and an environment that cannot say which machine it is has
  // no business starting anything. A guard that passes when its input is missing is decoration.
  const wholeFleet = roster({
    here: { status: "available" },
    nameless: { status: "available", machineId: "" },
  });
  assert.deepEqual(startableAgents(wholeFleet, { machineId: "" }), []);
  assert.deepEqual(startableAgents(wholeFleet, {}), []);
  // POSITIVE CONTROL: the same roster with a real identity offers the one that matches.
  assert.deepEqual(startableAgents(wholeFleet, { machineId: HERE }).map((r) => r.id), ["here"]);
});

test("MACHINE IDS COMPARE CASE-INSENSITIVELY, because one side lowercases and the other does not", () => {
  // `machineIdFor` lowercases what it mints; the roster returns whatever was registered. Comparing
  // raw would hide every agent on the host from the host itself, which reads as an empty fleet.
  const rows = startableAgents(roster({ a: { status: "available", machineId: "WIN32:StevenZ-L" } }), { machineId: HERE });
  assert.deepEqual(rows.map((r) => r.id), ["a"]);
});

test("AVAILABLE COMES FIRST AND THE ORDER IS STABLE, so an arrow key does not land on a different row", () => {
  // The list is rebuilt on every refresh. An order that depends on object iteration would reshuffle
  // under the operator's cursor between one redraw and the next -- which is the shape of the
  // wrong-agent defects this feature has already had twice.
  const rows = startableAgents(roster({
    zulu: { status: "available" },
    alpha: { status: "offline" },
    mike: { status: "available" },
    bravo: { status: "stopped" },
  }), { machineId: HERE });
  assert.deepEqual(rows.map((r) => r.id), ["mike", "zulu", "bravo", "alpha"]);
});

test("A MALFORMED ROSTER IS AN EMPTY LIST, not a throw inside a keyboard handler", () => {
  for (const bad of [null, undefined, {}, { agents: null }, { agents: [] }, "nope", 7]) {
    assert.deepEqual(startableAgents(bad, { machineId: HERE }), [], `${JSON.stringify(bad)} threw or leaked rows`);
  }
});

test("THE TWO STATUS MAPS ARE DISJOINT, so no status has two answers", () => {
  // They are read by different branches and a status in both would make the verdict depend on which
  // one is consulted first -- a rule that is right by accident of ordering.
  const startable = Object.keys(STARTABLE_STATUSES);
  const refused = Object.keys(NOT_STARTABLE_STATUSES);
  assert.ok(startable.length > 0 && refused.length > 0, "a map was emptied, which makes every check below vacuous");
  for (const status of startable) {
    assert.ok(!refused.includes(status), `"${status}" appears in both maps`);
  }
});

// ── which session a start acts on ────────────────────────────────────────────────────────────────

test("POSITIVE CONTROL: an agent with one dead session names it", () => {
  const target = restartTargetFor({ sessions: [{ id: "s1", status: "stopped", lastSeen: "2026-09-08T05:00:00Z" }] });
  assert.deepEqual(target, { sessionId: "s1", refusal: "" });
});

test("A LIVE SESSION REFUSES, because the roster this list was built from is a snapshot", () => {
  // Between building the menu and the operator pressing `y`, the agent may have come up -- by a
  // send, a dispatch, or the service's own reconcile. This is the second, fresher reading, and it is
  // the one allowed to say no. The pane's confirmation learned the same lesson after a stop
  // retargeted the wrong agent.
  for (const status of LIVE_SESSION_STATUSES) {
    const target = restartTargetFor({ sessions: [{ id: "s1", status, lastSeen: "2026-09-08T05:00:00Z" }] });
    assert.equal(target.sessionId, "", `a ${status} session was handed out as a restart target`);
    assert.match(target.refusal, new RegExp(status));
  }
});

test("NO SESSION AT ALL NAMES THE REMEDY, because it is a normal state rather than a failure", () => {
  // An agent that has never run here has nothing to restart, and the fix is the one the service's
  // own tool names: send it a message and a managed agent cold-starts a worker.
  const target = restartTargetFor({ sessions: [] });
  assert.equal(target.sessionId, "");
  assert.match(target.refusal, /send it a message/);
});

test("THE MOST RECENTLY SEEN SESSION WINS, not whichever the service listed first", () => {
  // That endpoint sorts live-first then `last_seen DESC` today. Taking `sessions[0]` would make this
  // answer depend on a detail of somebody else's SELECT, and a page ordered any other way would
  // restart the OLDEST backing the agent ever had.
  const target = restartTargetFor({
    sessions: [
      { id: "old", status: "stopped", lastSeen: "2026-08-01T00:00:00Z" },
      { id: "newest", status: "ended", lastSeen: "2026-09-08T04:00:00Z" },
      { id: "middle", status: "failed", lastSeen: "2026-09-01T00:00:00Z" },
    ],
  });
  assert.equal(target.sessionId, "newest");
});

test("A LISTING THAT IS NOT A LIST REFUSES, and says the service did not answer with one", () => {
  // A 500 body, an error object, or a truncated response all arrive here. None of them is an agent
  // with no sessions, and reporting them as one would send the operator to the wrong remedy.
  for (const bad of [null, undefined, {}, { error: "boom" }, "nope"]) {
    const target = restartTargetFor(bad);
    assert.equal(target.sessionId, "", `${JSON.stringify(bad)} produced a session id`);
    assert.match(target.refusal, /did not return a session list/);
  }
  // POSITIVE CONTROL: a bare array is a session list and is accepted.
  assert.equal(restartTargetFor([{ id: "s9", status: "ended", lastSeen: "x" }]).sessionId, "s9");
});

console.log("startable-agents.test.js: all assertions passed");
