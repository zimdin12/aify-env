// An operator's hold is released WITHOUT STARTING ANYTHING (lifecycle action `release`, lib/agent-lifecycle.mjs).
//
// 2026-10-28: sixteen defined agents stopped through the lifecycle read `stopped` (operator-stop), and a message no
// longer started them; the only way out of the hold was a start. `release` clears the stop fact alone: the agent reads
// available again, and the reason the action exists is the next part, a message cold-starts it through admitColdStart.
// Driven through the daemon's own composition (createAgentLifecyclePorts) over a real definition store and journal.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { deriveAgentState } from "../lib/agent-state.mjs";
import { readAgentStates } from "../lib/agent-state-read.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";

async function fixture(t, { mode = "managed" } = {}) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, "lifecycle-release-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const definitions = new DefinitionStore({ dir: path.join(home, "definitions") });
  await definitions.set("a", { id: "a", name: "Fixture", role: "worker", harness: "hermes", mode, workspace: home, model: "", effort: "",
    instructions: "", env: {}, herdrSpace: false }, { installed: new Set(["hermes"]) });
  fs.writeFileSync(path.join(home, "agent-lifecycle.json"), JSON.stringify({ version: 1, records: {}, stops: {} }));
  const listed = await definitions.list();
  const row = listed.definitions[0];
  const f = { home, definitions, current: null, starts: 0 };
  const ports = createAgentLifecyclePorts({ aifyHome: home, machineId: "machine", definitions, installed: async () => new Set(["hermes"]),
    stateHost: { rawIdentity: () => ({ current: f.current, unknown: false, conflict: false }) },
    runner: { start: () => { f.starts += 1; return { id: "fake-runner", pid: 123 }; } } });
  f.ports = ports;
  f.request = (id, action, overrides = {}) => ({ id, agentId: "a", machineId: "machine", storeId: listed.storeId, expectedIncarnation: row.incarnation,
    expectedRevision: row.revision, expectedLifetime: null, action, requestedBy: "operator", ...overrides });
  f.launch = { agentId: "a", runtime: "hermes", definition: { storeId: listed.storeId, incarnation: row.incarnation, revision: row.revision } };
  // A message's start: what the comms plugin hands admitColdStart, with a producer that records a birth.
  f.message = () => ports.admitColdStart(f.launch, async () => {
    f.current = { agentId: "a", handle: "fake-runner", pid: 123, lifetime: "fake-lifetime" };
    return { id: "fake-runner", pid: 123 };
  }, async () => true);
  // The word, read the way /agents/state and the sender read it, over a host whose word is deriveAgentState's.
  f.word = async () => {
    const stateHost = { readAll: (givenById) => {
      const given = givenById.get("a");
      const { state } = deriveAgentState({ stoppedByOperator: given.stoppedByOperator, definition: given.definition, mode: given.mode,
        process: f.current ? "running" : "none", verified: f.current ? "yes" : "no", startingInWindow: false, conflict: false, busy: false,
        awaitingInput: false, screen: null, backgroundShells: 0 });
      return { agents: [{ agentId: "a", state }], complete: true, problems: [] };
    } };
    const read = await readAgentStates({ stateHost, definitions, lifecycle: ports, observedHarnesses: async () => new Set(["hermes"]) });
    return read.body.agents.find((agent) => agent.agentId === "a").state;
  };
  return f;
}

test("A HELD AGENT RELEASED reads available, and a message then starts it; the release itself starts nothing", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.ports.lifecycle.execute(f.request("hold", "stop"))).outcome, "stop");
  assert.equal(await f.word(), "stopped", "CONTROL: the hold reads stopped");
  assert.equal((await f.message()).refused, "stopped-by-operator", "CONTROL: a held agent is not started by a message");
  assert.equal(f.current, null);

  const released = await f.ports.lifecycle.execute(f.request("release", "release"));
  assert.deepEqual([released.status, released.outcome], ["done", "release"]);
  assert.equal(f.starts, 0, "the release started the agent");
  assert.equal(f.current, null, "the release produced a lifetime");
  assert.equal(await f.word(), "available", "a released agent does not read available");

  const started = await f.message();
  assert.equal(started.refused, undefined, `a message did not start the released agent: ${started.refused}`);
  assert.equal(f.current?.lifetime, "fake-lifetime", "the message's start produced no lifetime");
});

test("an agent that is not held is answered not-held, done, and its journal is not written", async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(path.join(f.home, "agent-lifecycle.json"), "utf8");
  const answer = await f.ports.lifecycle.execute(f.request("release", "release"));
  assert.deepEqual([answer.status, answer.outcome], ["done", "not-held"]);
  const after = JSON.parse(fs.readFileSync(path.join(f.home, "agent-lifecycle.json"), "utf8"));
  assert.deepEqual(after.stops, JSON.parse(before).stops, "a release with nothing to release wrote a stop fact");
  assert.equal(after.stopRevisions, undefined, "a release with nothing to release moved the stop revision");
  assert.equal(f.starts, 0);
});

test("a release under a moved definition is refused, and the hold stays", async (t) => {
  const f = await fixture(t);
  await f.ports.lifecycle.execute(f.request("hold", "stop"));
  const moved = await f.ports.lifecycle.execute(f.request("release", "release", { expectedRevision: 99 }));
  assert.deepEqual([moved.status, moved.outcome], ["refused", "revision-moved"]);
  assert.equal(await f.word(), "stopped", "a refused release released the hold");
});

test("a lifetime born between the request's check and the release, under the store's lock, refuses it", async (t) => {
  const f = await fixture(t);
  await f.ports.lifecycle.execute(f.request("hold", "stop"));
  // The first identity read (the request's check) sees no process; the one under the lock sees a lifetime.
  let reads = 0;
  const raced = createAgentLifecyclePorts({ aifyHome: f.home, machineId: "machine", definitions: f.definitions, installed: async () => new Set(["hermes"]),
    stateHost: { rawIdentity: () => ({ current: (reads += 1) > 1 ? { agentId: "a", handle: "h", pid: 9, lifetime: "born-meanwhile" } : null,
      unknown: false, conflict: false }) }, runner: { start: () => { f.starts += 1; } } });
  const answer = await raced.lifecycle.execute(f.request("release", "release"));
  assert.deepEqual([answer.status, answer.outcome], ["refused", "lifetime-moved"]);
  assert.equal(reads >= 2, true, "CONTROL: the release read identity again under the lock");
  assert.equal([...(await raced.stopFacts()).values()][0], true, "a release raced by a birth released the hold");
});

test("a resident's hold is the residents role's: released without the role, it is refused and stays", async (t) => {
  const f = await fixture(t, { mode: "resident" });
  const key = [...(await f.ports.stopFacts()).keys()];
  assert.deepEqual(key, [], "CONTROL: nothing held yet");
  // Held directly in the journal: a resident's stop also needs the role, which this fixture does not hold.
  const journal = JSON.parse(fs.readFileSync(path.join(f.home, "agent-lifecycle.json"), "utf8"));
  const request = f.request("release", "release");
  journal.stops[`${request.storeId}:${request.expectedIncarnation}:a`] = true;
  fs.writeFileSync(path.join(f.home, "agent-lifecycle.json"), JSON.stringify(journal));
  const answer = await f.ports.lifecycle.execute(request);
  assert.deepEqual([answer.status, answer.outcome], ["refused", "not-owner"]);
  assert.equal([...(await f.ports.stopFacts()).values()][0], true, "a resident's hold was released without the role");
});
