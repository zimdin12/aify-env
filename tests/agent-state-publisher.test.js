// The order agent-state publications go out in (lib/agent-state-publisher.mjs; 0.9 plan P0 C5).

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentStatePublisher, nextGeneration } from "../lib/agent-state-publisher.mjs";

const identity = { machineId: "win32:stevenz-l", instance: "default", generation: 1_790_950_000_123, incarnationId: "b1e" };
const agent = (agentId, over = {}) => ({ agentId, lifetime: `${agentId}-l1`, mode: "resident", harness: "claude",
  state: "idle", stateCause: "at-prompt", busy: false, process: { state: "running", verified: "yes", pid: 7 },
  turn: { open: false, ageMs: 0 }, screen: { state: "idle", observedAt: 1 }, ...over });
const all = (...agents) => ({ complete: true, agents });

test("THE GENERATION only rises: past a lost file, a backward clock and two boots in one millisecond", () => {
  assert.equal(nextGeneration(null, 1000), 1000, "no file: the clock");
  assert.equal(nextGeneration(5000, 1000), 5001, "the clock behind the file: the file wins");
  assert.equal(nextGeneration(1000, 1000), 1001, "the same millisecond: still higher");
  assert.equal(nextGeneration(999, 5000), 5000, "the clock ahead: the clock");
  assert.equal(nextGeneration("x", 1000), 1000, "an unreadable file is no file");
});

test("A SNAPSHOT says it is complete; an incomplete enumeration is sent as unavailable, never as a snapshot", () => {
  const publisher = new AgentStatePublisher(identity);
  const first = publisher.snapshot(all(agent("a"), agent("b"))).body;
  assert.equal(first.kind, "snapshot");
  assert.equal(first.complete, true);
  assert.deepEqual(first.agents.map((a) => a.agentId), ["a", "b"]);
  const partial = publisher.snapshot({ complete: false, agents: [agent("a")], reason: "lock held" }).body;
  assert.deepEqual([partial.kind, partial.reason, "agents" in partial], ["unavailable", "lock held", false]);
  assert.equal(publisher.changes({ complete: false, agents: [] }), null, "nor as changes");
  assert.equal(publisher.changes(all(agent("a"), agent("b"))), null, "CONTROL: the unavailable body forgot nobody");
});

test("A QUIET HOST spends no publication number, and an age that moved is not a change", () => {
  const publisher = new AgentStatePublisher(identity);
  publisher.snapshot(all(agent("a")));
  const before = publisher.identity.publication;
  assert.equal(publisher.changes(all(agent("a", { turn: { open: false, ageMs: 999 }, screen: { state: "idle", observedAt: 2 } }))), null);
  assert.equal(publisher.identity.publication, before);
  const working = (turn) => agent("a", { state: "working", stateCause: "turn-open", busy: true, turn: { open: true, ...turn } });
  const moved = publisher.changes(all(working({ lastEventAt: 4, ageMs: 1 })));
  assert.deepEqual(moved.body.agents.map((a) => a.state), ["working"], "CONTROL: a change in meaning is sent");
  assert.equal(publisher.changes(all(working({ lastEventAt: 4, ageMs: 900 }))), null, "the same turn, older: no change");
  assert.ok(publisher.changes(all(working({ lastEventAt: 5, ageMs: 900 }))),
    "only the turn's last event moved, and that is a change: the reminders read its freshness");
});

test("REMOVAL AND RECREATION name the lifetime, so a delayed removal cannot end the new one", () => {
  const publisher = new AgentStatePublisher(identity);
  publisher.snapshot(all(agent("a"), agent("b")));
  const gone = publisher.changes(all(agent("a"))).body;
  assert.deepEqual(gone.removed, [{ agentId: "b", lifetime: "b-l1" }]);
  assert.deepEqual(gone.agents, []);
  const back = publisher.changes(all(agent("a"), agent("b", { lifetime: "b-l2" }))).body;
  assert.deepEqual(back.agents.map((a) => a.lifetime), ["b-l2"]);
  assert.deepEqual(back.removed, []);
  const swapped = publisher.changes(all(agent("a", { lifetime: "a-l2" }), agent("b", { lifetime: "b-l2" }))).body;
  assert.deepEqual(swapped.removed, [{ agentId: "a", lifetime: "a-l1" }], "a restart in place ends the old lifetime");
});

test("ONE COUNTER ORDERS EVERY BODY, so an older snapshot that omits an agent is below that agent's change (R4)", () => {
  const publisher = new AgentStatePublisher(identity);
  const old = publisher.snapshot(all(agent("a"))).body;       // omits b
  const created = publisher.changes(all(agent("a"), agent("b"))).body;
  assert.ok(created.publication > old.publication, "the change outranks the snapshot that omitted b");
  assert.deepEqual([old.generation, old.incarnationId], [created.generation, created.incarnationId]);
  const numbers = [old, created, publisher.snapshot(all(agent("a"))).body, publisher.snapshot({ complete: false }).body]
    .map((body) => body.publication);
  assert.deepEqual(numbers, [1, 2, 3, 4], "snapshots, changes and unavailable share one counter");
});

test("THE SAME BODY HAS THE SAME DIGEST, which is what a receiver's duplicate check compares", () => {
  const a = new AgentStatePublisher(identity).snapshot(all(agent("a")));
  const b = new AgentStatePublisher(identity).snapshot(all(agent("a")));
  assert.equal(a.digest, b.digest);
  const c = new AgentStatePublisher(identity).snapshot(all(agent("a", { state: "working" })));
  assert.notEqual(a.digest, c.digest, "CONTROL: a different body, a different digest");
  assert.throws(() => new AgentStatePublisher({ ...identity, generation: 0 }), /generation/);
});
