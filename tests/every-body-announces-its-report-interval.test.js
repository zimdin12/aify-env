// Decision 2 (aify-comms DECISIONS.md, "aify-env announces its reporting interval"): every body but `retired` carries
// `reportEveryMs`, the sender's one cadence, so aify-comms derives "not reporting" from it instead of keeping a number
// of its own. Out of aify-comms' bounds it is omitted, never sent as null.

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentStatePublisher } from "../lib/agent-state-publisher.mjs";
import { REPORT_EVERY_MS } from "../lib/agent-state-sender.mjs";

const identity = { machineId: "win32:fixture", instance: "default", generation: 1_790_950_000_123, incarnationId: "i1" };
const agent = (agentId, over = {}) => ({ agentId, lifetime: `${agentId}-l1`, state: "idle", stateCause: "at-prompt",
  busy: false, process: { state: "running", verified: "yes", pid: 7 }, turn: null, ...over });
const all = (...agents) => ({ complete: true, agents });

test("EVERY SNAPSHOT, CHANGES AND UNAVAILABLE BODY carries the sender's cadence; the retirement carries none", () => {
  assert.equal(REPORT_EVERY_MS, 60_000, "the cadence the snapshot epoch and the daemon timer run on");
  const publisher = new AgentStatePublisher({ ...identity, reportEveryMs: REPORT_EVERY_MS });
  const snapshot = publisher.snapshot(all(agent("a")));
  const changes = publisher.changes(all(agent("a", { state: "working", busy: true })), snapshot.view);
  const unavailable = publisher.snapshot({ complete: false, reason: "lock held" });
  const bodies = [snapshot, changes, unavailable].map((publication) => publication.body);
  assert.deepEqual(bodies.map((body) => body.kind), ["snapshot", "changes", "unavailable"]);
  for (const body of bodies) assert.equal(body.reportEveryMs, REPORT_EVERY_MS, `${body.kind} announces the cadence`);
  const retired = publisher.retire().body;
  assert.equal(retired.kind, "retired");
  assert.equal("reportEveryMs" in retired, false, "after its retirement a key reports nothing, so it announces nothing");
});

test("OUT OF BOUNDS the interval is omitted, never null: aify-comms admits whole milliseconds from 1 s to 1 h", () => {
  for (const edge of [1_000, 3_600_000]) {
    const body = new AgentStatePublisher({ ...identity, reportEveryMs: edge }).snapshot(all(agent("a"))).body;
    assert.equal(body.reportEveryMs, edge, `${edge} is inside`);
  }
  for (const value of [999, 3_600_001, 1.5, "60000", null, undefined, true, 0, -1, Number.NaN]) {
    const body = new AgentStatePublisher({ ...identity, reportEveryMs: value }).snapshot(all(agent("a"))).body;
    assert.equal("reportEveryMs" in body, false, `${String(value)} is omitted`);
  }
});
