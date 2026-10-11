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
//
// SINCE D8 ONLY A DEFINED AGENT IS OFFERED, so the status rules are driven through agents this host
// defines. An agent no host defines is refused before its status is read, and every status refusal
// would pass for that reason instead of its own.

import assert from "node:assert/strict";
import test from "node:test";

import {
  definitionsById,
  notOffered,
  NOT_STARTABLE_STATUSES,
  STARTABLE_STATUSES,
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

/** This host's reading of one definition, as `DefinitionStore.list()` returns it. */
const reading = (id, mode = "managed") => ({ id, problems: [], agent: { id, name: id, role: "coder", harness: "claude", mode } });
/** The agents this host defines, keyed as `startableAgents` takes them. */
const defines = (...ids) => definitionsById({ definitions: ids.map((id) => reading(id)) });
/** One agent judged by this host, which defines it as managed. */
const asDefined = (agent) => startabilityOf(agent, { machineId: HERE, definition: reading("a") });

test("POSITIVE CONTROL: a managed agent this host defines, with no worker, is offered", () => {
  // Every refusal below would pass against a function that returns nothing at all. This is the run
  // that proves it can say yes.
  const rows = startableAgents(roster({ "ef-tester": { status: "available" } }), { machineId: HERE, definitions: defines("ef-tester") });
  assert.deepEqual(rows.map((r) => r.id), ["ef-tester"]);
  assert.match(rows[0].reason, /cold-startable/);
});

test("A LIVE WORKER IS NEVER OFFERED, because starting one gives the agent two", () => {
  // Measured 2026-09-03: the service reconciled live terminals as dead ghosts, asked for
  // replacements, and the host started them beside the ones still running.
  for (const status of ["working", "online", "blocked"]) {
    const rows = startableAgents(roster({ a: { status } }), { machineId: HERE, definitions: defines("a") });
    assert.deepEqual(rows, [], `an agent whose status is "${status}" was offered a start`);
  }
});

test("`starting` IS REFUSED THOUGH IT HAS NO WORKER, which liveness alone would get wrong", () => {
  // The contract's own words: "A claimed spawn is coming up; no worker YET. Do NOT restart or
  // re-send - a restart kills the boot in flight." A rule written as "offer anything without a live
  // worker" offers this one, and the operator's keystroke kills a spawn that was already working.
  assert.deepEqual(asDefined({ machineId: HERE, status: "starting" }), { startable: false, reason: NOT_STARTABLE_STATUSES.starting });
  assert.match(NOT_STARTABLE_STATUSES.starting, /boot in flight/);
});

test("`misconfigured` IS REFUSED, because it is a row that could only ever fail", () => {
  // "Identity exists but can never start. Not send-recoverable; a human must fix the config."
  const verdict = asDefined({ machineId: HERE, status: "misconfigured" });
  assert.equal(verdict.startable, false);
  assert.match(verdict.reason, /human/);
});

test("AN UNKNOWN STATUS FAILS CLOSED, so a word invented later is not silently offered", () => {
  // The rule is an allowlist for exactly this: "anything that does not look live" would offer a
  // status this file has never heard of, and the first time that mattered would be on a live fleet.
  for (const status of ["quarantined", "", null, undefined, "AVAILABLE_LATER"]) {
    const verdict = asDefined({ machineId: HERE, status });
    assert.equal(verdict.startable, false, `status ${JSON.stringify(status)} was offered`);
    assert.ok(verdict.reason.length > 0, "a refusal with no reason is a blank row");
  }
});

test("AN AGENT NO HOST DEFINES IS NOT OFFERED (D8), whatever its row says, and the refusal says how to define it", () => {
  // The service no longer starts an agent no host defines, so offering one is a row that always
  // fails. Before D8 the first of these rows was the ordinary offer: managed, on this host, no worker.
  const rows = roster({
    managed: { status: "available" },
    resident: { status: "offline", sessionMode: "resident" },
    elsewhere: { status: "available", machineId: "wsl-ubuntu:stevenz-l" },
  });
  for (const [what, agent] of Object.entries(rows.agents)) {
    assert.deepEqual(startabilityOf(agent, { machineId: HERE }),
      { startable: false, reason: "no host defines it: define it here (`aify-env agents import --write`), then start it" },
      `an undefined ${what} row`);
  }
  assert.deepEqual(startableAgents(rows, { machineId: HERE }), []);
  // POSITIVE CONTROL: the same managed row, defined on this host, is offered.
  assert.deepEqual(startableAgents(rows, { machineId: HERE, definitions: defines("managed") }).map((r) => r.id), ["managed"]);
});

test("AN UNKNOWN MACHINE IDENTITY OFFERS NOTHING, rather than matching everything", () => {
  // The service names the machine whose definition stands, and an environment that cannot say which
  // machine it is cannot be that owner. A guard that passes when its input is missing is decoration.
  const wholeFleet = roster({
    here: { status: "available", definition: { state: "defined", ownerMachineId: HERE } },
    there: { status: "available", definition: { state: "defined", ownerMachineId: "linux:laputa" } },
  });
  const definitions = defines("here", "there");
  assert.deepEqual(startableAgents(wholeFleet, { machineId: "", definitions }), []);
  assert.deepEqual(startableAgents(wholeFleet, { definitions }), []);
  // POSITIVE CONTROL: the same roster with a real identity offers the one this host owns.
  assert.deepEqual(startableAgents(wholeFleet, { machineId: HERE, definitions }).map((r) => r.id), ["here"]);
});

test("MACHINE IDS COMPARE CASE-INSENSITIVELY, because one side lowercases and the other does not", () => {
  // `machineIdFor` lowercases what it mints; the roster returns whatever was registered. Comparing
  // raw would hide every agent on the host from the host itself, which reads as an empty fleet.
  const owned = { status: "available", definition: { state: "defined", ownerMachineId: "WIN32:StevenZ-L" } };
  const rows = startableAgents(roster({ a: owned }), { machineId: HERE, definitions: defines("a") });
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
  }), { machineId: HERE, definitions: defines("zulu", "alpha", "mike", "bravo") });
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

console.log("startable-agents.test.js: all assertions passed");

// ── THE RULE HAS TO BE VISIBLE, OR IT IS INDISTINGUISHABLE FROM NO RULE.
//
// The operator, 2026-09-12: "in aify-env start function i see residents for some reason. it should
// offer only managed options. or it should say it is resident and spawning it should make it
// managed type automatically (you choose which is better solution)."
//
// Residents were ALREADY refused -- measured against their live roster the same day: 38 agents, 18
// offered and every one `sessionMode: managed`, 12 residents refused. So the answer to the choice is
// the first option, and it needed no code. What was missing is any way to SEE it: the list draws
// what it kept and never what it refused, so a correct rule and an absent one look the same.
//
// AUTO-CONVERTING WAS THE WRONG HALF OF THE CHOICE, and this project has the incident for it. Two of
// the residents on that host were ONLINE; starting one as managed forks a twin holding the same
// session handle, which on 2026-08-31 left messages refused and relayed for hours with every status
// badge green. The service also already owns resident->managed flips, so a second flip here would be
// two implementations of one decision.

test("RESIDENTS ARE REFUSED, and the refusal is counted where a view can draw it", () => {
  // A defined agent's mode is its definition's, so a resident here is one this host defines as resident.
  const roster = {
    agents: {
      "sc-manager": { sessionMode: "resident", status: "online", machineId: "win32:host" },
      "llama-manager": { sessionMode: "resident", status: "offline", machineId: "win32:host" },
      "sc-tester": { sessionMode: "managed", status: "offline", machineId: "win32:host" },
      "ef-senior-dev": { sessionMode: "managed", status: "working", machineId: "win32:host" },
      // ANOTHER MACHINE'S AGENT IS NOT "NOT OFFERED", it is not this host's business. Counting it
      // would make every machine look like it was hiding the fleet.
      "elsewhere": { sessionMode: "resident", status: "offline", machineId: "linux:other" },
    },
  };
  const definitions = definitionsById({ definitions: [
    reading("sc-manager", "resident"), reading("llama-manager", "resident"), reading("sc-tester"), reading("ef-senior-dev"),
  ] });
  const host = { machineId: "win32:host", definitions };

  assert.deepEqual(startableAgents(roster, host).map((r) => r.id), ["sc-tester"]);

  const skipped = notOffered(roster, host);
  assert.deepEqual(skipped, [
    { count: 2, why: "defined as resident: it is started through its launcher" },
    { count: 1, why: "a live worker is mid-turn" },
  ], "the refusals are not counted, or another host's agent was counted as missing");
});

test("the summary's words are the REFUSAL's own, so the two cannot drift apart", () => {
  // A second vocabulary beside the one that decides would drift invisibly -- the counts would still
  // add up. Driven by asking the deciding function directly for the same agent.
  const agent = { sessionMode: "resident", status: "offline", machineId: "m" };
  const [group] = notOffered({ agents: { a: agent } }, { machineId: "m" });
  assert.equal(group.why, startabilityOf(agent, { machineId: "m" }).reason);
});

test("NOTHING TO SUMMARISE IS AN EMPTY LIST, never a row saying zero", () => {
  assert.deepEqual(notOffered({ agents: { a: { sessionMode: "managed", status: "offline", machineId: "m" } } },
    { machineId: "m", definitions: defines("a") }), []);
  // AND AN UNKNOWN HOST IDENTITY SUMMARISES NOTHING, matching the offer's own guard: an empty
  // machine id must not make every agent on the fleet read as refused here.
  assert.deepEqual(notOffered({ agents: { a: { sessionMode: "resident", machineId: "m" } } }, { machineId: "" }), []);
  assert.deepEqual(notOffered(null, { machineId: "m" }), []);
  assert.deepEqual(notOffered({ agents: "nope" }, { machineId: "m" }), []);
});
