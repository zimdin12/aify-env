// Relaying what a service said, without deciding anything.
//
// The rule these tests defend: aify-env may DISPLAY an agent's status and may not DERIVE one. The
// tempting version of this feature reads its own process table and calls a live pid a running agent,
// which is a second answer to a question aify-comms owns -- and a wrong one, because alive is not
// working.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentsTheServiceCallsLive,
  managedOnly,
  relayedAgents,
  remainderNote,
} from "../lib/agents-relay.mjs";

const PAYLOAD = {
  agents: {
    "mc-coder": { name: "Coder", runtime: "claude-code", sessionMode: "managed", status: "working" },
    "mc-tester": { name: "Tester", runtime: "codex", sessionMode: "managed", status: "online" },
    "mc-old": { name: "Old", runtime: "codex", sessionMode: "managed", status: "offline" },
    "dev": { name: "Dev", runtime: "claude-code", sessionMode: "resident", status: "online" },
  },
};

test("the service's map becomes rows, attributed to the service that answered", () => {
  const rows = relayedAgents(PAYLOAD, "aify-comms");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.service), ["aify-comms", "aify-comms", "aify-comms", "aify-comms"]);
  const coder = rows.find((r) => r.id === "mc-coder");
  assert.deepEqual(coder, {
    service: "aify-comms", id: "mc-coder", name: "Coder",
    runtime: "claude-code", mode: "managed", status: "working",
  });
});

test("a status the service did not state stays empty rather than becoming offline", () => {
  // Not knowing and being told "offline" are different answers, and only one of them was given.
  const rows = relayedAgents({ agents: { x: { name: "X" } } }, "svc");
  assert.equal(rows[0].status, "");
  assert.equal(rows[0].runtime, "");
  assert.equal(rows[0].mode, "");
});

test("an id with no record is skipped rather than rendered blank", () => {
  const rows = relayedAgents({ agents: { a: null, b: "nonsense", c: { status: "online" } } }, "svc");
  assert.deepEqual(rows.map((r) => r.id), ["c"]);
});

test("a payload that is not the expected shape yields no rows, never a guess", () => {
  // A service that answered with something else, or did not answer at all, must produce nothing --
  // and the caller states the reason. Inventing "none running" would be a claim.
  for (const bad of [null, undefined, {}, { agents: null }, { agents: [] }, "text", 42]) {
    assert.deepEqual(relayedAgents(bad, "svc"), [], `${JSON.stringify(bad)} produced rows`);
  }
});

test("live means what the SERVICE calls live", () => {
  const live = agentsTheServiceCallsLive(relayedAgents(PAYLOAD, "aify-comms"));
  assert.deepEqual(live.map((r) => r.id).sort(), ["dev", "mc-coder", "mc-tester"]);
});

test("managed excludes residents, which never touch this environment", () => {
  const managed = managedOnly(relayedAgents(PAYLOAD, "aify-comms"));
  assert.deepEqual(managed.map((r) => r.id).sort(), ["mc-coder", "mc-old", "mc-tester"]);
  assert.ok(!managed.some((r) => r.id === "dev"));
});

test("a filtered view says what it left out, so it never reads as the whole population", () => {
  const all = relayedAgents(PAYLOAD, "aify-comms");
  const shown = agentsTheServiceCallsLive(managedOnly(all));
  const note = remainderNote(all, shown);
  assert.match(note, /2 not shown/);
  assert.match(note, /1 offline/);
  assert.match(note, /1 online/, "the resident is hidden too and must be counted");
});

test("nothing left over means no line at all", () => {
  const all = relayedAgents({ agents: { a: { status: "online", sessionMode: "managed" } } }, "s");
  assert.equal(remainderNote(all, all), "");
  assert.equal(remainderNote([], []), "");
});

test("an unstated status is counted under its own name in the remainder", () => {
  const all = relayedAgents({ agents: { a: { sessionMode: "managed" } } }, "s");
  assert.match(remainderNote(all, []), /1 unstated/);
});
