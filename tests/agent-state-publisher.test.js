// The order agent-state publications go out in (lib/agent-state-publisher.mjs; 0.9 plan P0 C5).

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentStatePublisher, nextGeneration } from "../lib/agent-state-publisher.mjs";

const identity = { machineId: "win32:stevenz-l", instance: "default", generation: 1_790_950_000_123, incarnationId: "b1e" };
const agent = (agentId, over = {}) => ({ agentId, lifetime: `${agentId}-l1`, mode: "resident", harness: "claude",
  state: "idle", stateCause: "at-prompt", busy: false, process: { state: "running", verified: "yes", pid: 7 },
  turn: { open: false, ageMs: 0 }, screen: { state: "idle", observedAt: 1 }, ...over });
const all = (...agents) => ({ complete: true, agents });
/** A destination that acknowledged the snapshot of `agents`. */
const acked = (publisher, ...agents) => publisher.snapshot(all(...agents)).view;

test("THE GENERATION only rises: past a lost file, a backward clock and two boots in one millisecond", () => {
  assert.equal(nextGeneration(null, 1000), 1000, "no file: the clock");
  assert.equal(nextGeneration(5000, 1000), 5001, "the clock behind the file: the file wins");
  assert.equal(nextGeneration(1000, 1000), 1001, "the same millisecond: still higher");
  assert.equal(nextGeneration(999, 5000), 5000, "the clock ahead: the clock");
  assert.equal(nextGeneration("x", 1000), 1000, "an unreadable file is no file");
});

test("A SNAPSHOT is whole or it is unavailable: incomplete, a record without its ids, or one agent twice", () => {
  const publisher = new AgentStatePublisher(identity);
  const first = publisher.snapshot(all(agent("a"), agent("b")));
  assert.deepEqual([first.body.kind, first.body.complete, first.body.agents.map((a) => a.agentId)], ["snapshot", true, ["a", "b"]]);
  for (const [enumeration, reason] of [[{ complete: false, agents: [agent("a")], reason: "lock held" }, /lock held/], [{}, /incomplete/],
    [all(agent("a"), agent("a", { state: "working" })), /a enumerated twice/], [all(agent("a", { lifetime: "" })), /agentId and lifetime/],
    [all({ lifetime: "x" }), /agentId and lifetime/]]) {
    const result = publisher.snapshot(enumeration);
    assert.deepEqual([result.body.kind, "agents" in result.body, result.view], ["unavailable", false, null], String(reason));
    assert.match(result.body.reason, reason);
    assert.equal(publisher.changes(enumeration, first.view), null, `${reason}: nor sent as changes`);
  }
});

test("A QUIET HOST sends nothing and spends no number; any field of a record but its ages is a change", () => {
  const publisher = new AgentStatePublisher(identity);
  const view = acked(publisher, agent("a"));
  const before = publisher.identity.publication;
  assert.equal(publisher.changes(all(agent("a", { turn: { open: false, ageMs: 999 }, screen: { state: "idle", observedAt: 2 } })), view), null);
  assert.equal(publisher.identity.publication, before);
  for (const over of [{ state: "working" }, { stateCause: "screen" }, { busy: true }, { mode: "managed" }, { harness: "codex" },
    { process: { state: "running", verified: "yes", pid: 8 } }, { process: { state: "running", verified: "unknown", pid: 7 } },
    { turn: { open: true, ageMs: 0 } }, { turn: { open: false, ageMs: 0, lastEventAtUs: 5 } }, { turn: { open: false, ageMs: 0, busyIf: { strict: true } } },
    { screen: { state: "working", observedAt: 1 } }, { background: { shells: 1 } }, { lifecycle: { stoppedByOperator: true } }, { aNewField: 1 }]) {
    assert.ok(publisher.changes(all(agent("a", over)), view), `${JSON.stringify(over)} was not sent`);
  }
  const reordered = Object.fromEntries(Object.entries(agent("a")).reverse());
  assert.equal(publisher.changes(all(reordered), view), null, "the same record with its keys in another order is no change");
});

test("A LOST SEND changes nothing: the next changes are computed against what the destination acknowledged", () => {
  const publisher = new AgentStatePublisher(identity);
  const view = acked(publisher, agent("a"), agent("b"));
  const lost = publisher.changes(all(agent("a", { state: "working" })), view);
  assert.deepEqual([lost.body.agents.map((a) => a.state), lost.body.removed], [["working"], [{ agentId: "b", lifetime: "b-l1" }]]);
  const again = publisher.changes(all(agent("a", { state: "working" })), view);
  assert.deepEqual([again.body.agents.map((a) => a.state), again.body.removed.length], [["working"], 1], "the lost change and removal are sent again");
  assert.equal(publisher.changes(all(agent("a", { state: "working" })), again.view), null, "CONTROL: once acknowledged, nothing is left to send");
  const other = publisher.changes(all(agent("a", { state: "working" })), null);
  assert.equal(other.body.kind, "snapshot", "a destination that has acknowledged nothing gets a snapshot");
});

test("REMOVAL AND RECREATION name the lifetime, so a delayed removal cannot end the new one", () => {
  const publisher = new AgentStatePublisher(identity);
  const view = acked(publisher, agent("a"), agent("b"));
  const gone = publisher.changes(all(agent("a")), view);
  assert.deepEqual([gone.body.removed, gone.body.agents], [[{ agentId: "b", lifetime: "b-l1" }], []]);
  const back = publisher.changes(all(agent("a"), agent("b", { lifetime: "b-l2" })), gone.view);
  assert.deepEqual([back.body.agents.map((a) => a.lifetime), back.body.removed], [["b-l2"], []]);
  const swapped = publisher.changes(all(agent("a", { lifetime: "a-l2" }), agent("b", { lifetime: "b-l2" })), back.view);
  assert.deepEqual(swapped.body.removed, [{ agentId: "a", lifetime: "a-l1" }], "a restart in place ends the old lifetime");
  assert.deepEqual(swapped.body.agents.map((a) => a.lifetime), ["a-l2"]);
});

test("ONE COUNTER ORDERS EVERY BODY, so an older snapshot that omits an agent is below that agent's change (R4)", () => {
  const publisher = new AgentStatePublisher(identity);
  const old = publisher.snapshot(all(agent("a")));       // omits b
  const created = publisher.changes(all(agent("a"), agent("b")), old.view).body;
  assert.ok(created.publication > old.body.publication, "the change outranks the snapshot that omitted b");
  assert.deepEqual([old.body.generation, old.body.incarnationId], [created.generation, created.incarnationId]);
  const numbers = [old.body, created, publisher.snapshot(all(agent("a"))).body, publisher.snapshot({ complete: false }).body]
    .map((body) => body.publication);
  assert.deepEqual(numbers, [1, 2, 3, 4], "snapshots, changes and unavailable share one counter");
});

test("THE SAME BODY HAS THE SAME DIGEST, and a body is a copy the caller cannot change after the fact", () => {
  const a = new AgentStatePublisher(identity).snapshot(all(agent("a")));
  const b = new AgentStatePublisher(identity).snapshot(all(agent("a")));
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, new AgentStatePublisher(identity).snapshot(all(agent("a", { state: "working" }))).digest, "CONTROL: another body");
  const record = agent("a");
  const sent = new AgentStatePublisher(identity).snapshot(all(record));
  record.state = "working";
  assert.equal(sent.body.agents[0].state, "idle", "the body changed after it was built");
  for (const bad of [{ generation: 0 }, { machineId: "" }, { instance: "" }, { incarnationId: "" }]) {
    assert.throws(() => new AgentStatePublisher({ ...identity, ...bad }), TypeError, JSON.stringify(bad));
  }
});
