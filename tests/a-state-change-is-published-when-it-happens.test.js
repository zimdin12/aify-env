// A change to an agent's state is published when it happens, not on the next 30-second sweep.
//
// THE OPERATOR, 2026-10-25: "when i kill/stop agent then i see that agent be in old status for some time". aify-env
// evaluated agent state only on its sweep and its full-report timer, so a stop reached aify-comms up to a sweep late
// (measured that day: publications 60 s apart with nothing between). Three things now say "something moved", and the
// daemon answers each with an evaluation: the process registry (a process came or went: a start, an exit, a kill, a
// reap), the turn receiver (an event applied), and the lifecycle journal (a stop fact moved). And an evaluation asked
// for while one is in flight runs once more after it, so a change landing mid-evaluation is not left for the sweep.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ProcessRegistry } from "../lib/process-registry.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { LifecycleJournal } from "../lib/agent-lifecycle.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentStateSender } from "../lib/agent-state-sender.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { CREDENTIAL_ABSENT } from "../lib/credential-store.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function home(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the process registry says so when a process is added or removed, and not for an id it does not hold", () => {
  let told = 0;
  const registry = new ProcessRegistry({ onChange: () => { told += 1; } });
  const stored = registry.add({ service: "aify-comms", pid: 41, label: "lead" });
  assert.equal(told, 1, "a start");
  registry.remove(stored.id, { atMs: 1, reason: "exited" });
  assert.equal(told, 2, "an exit");
  registry.remove(stored.id, { atMs: 2 });
  assert.equal(told, 2, "a second remove of the same id moved nothing, so says nothing");
  const throwing = new ProcessRegistry({ onChange: () => { throw new Error("listener"); } });
  assert.doesNotThrow(() => throwing.add({ service: "s", pid: 1 }), "a notice never fails the record");
});

test("the turn receiver says so for an applied event, and not for a refused one", () => {
  let told = 0;
  let applied = true;
  const host = { refresh() {}, applyEvent: () => ({ applied, reason: applied ? "applied" : "stale" }) };
  const events = new AgentTurnEvents({ host, instance: "own", onApplied: () => { told += 1; } });
  assert.equal(events.receive("lead", { kind: "turn-start", instance: "own" }).status, 200);
  assert.equal(told, 1);
  applied = false;
  assert.equal(events.receive("lead", { kind: "turn-end", instance: "own" }).status, 409);
  assert.equal(events.receive("lead", { kind: "turn-end", instance: "someone-else" }).status, 409);
  assert.equal(told, 1, "a refused event changed nothing to publish");
});

test("the lifecycle journal says so when a stop fact moves, after the write, and not for other writes", (t) => {
  const dir = home(t, "stop-notice-");
  let told = 0;
  const file = path.join(dir, "agent-lifecycle.json");
  const journal = new LifecycleJournal({ file, onStopChange: () => {
    told += 1;
    assert.equal(journal.stopFacts().size, 1, "told only once the stop is durable and readable");
  } });
  journal.initialize({ priorBoot: false });
  const request = { id: "r1", agentId: "lead", machineId: "m", storeId: "s", expectedIncarnation: 1, expectedRevision: 1,
    expectedLifetime: null, action: "stop", requestedBy: "dashboard" };
  journal.reserve(request);
  assert.equal(told, 0, "a reservation moves no stop");
  journal.markStopped(request);
  assert.equal(told, 1, "the stop fact moved");
  journal.finish(request, { status: "done", outcome: "stop", resultLifetime: null, finishedAt: "2026-10-25T00:00:00Z" });
  assert.equal(told, 1, "finishing with no stop fact moves none");
});

test("the daemon answers all three notices with an evaluation, and the runner hands its registry the notice", () => {
  // The daemon is never imported (importing it runs it), so its wiring is read, as the other daemon-wiring tests do.
  const daemon = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  assert.match(daemon, /onProcessChange: \(\) => evaluateAgentState\(\)/);
  assert.match(daemon, /new AgentTurnEvents\(\{[^}]*onApplied: evaluateAgentState/);
  assert.match(daemon, /createAgentLifecyclePorts\(\{[\s\S]*?onStopChange: evaluateAgentState/);
  const runner = fs.readFileSync(new URL("../lib/runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /new ProcessRegistry\(\{ onChange: deps\.onProcessChange \}\)/);
  const ports = fs.readFileSync(new URL("../lib/daemon-agent-lifecycle.mjs", import.meta.url), "utf8");
  assert.match(ports, /new LifecycleJournal\(\{[^}]*onStopChange\}\)/);
});

test("an evaluation asked for while one is in flight runs once more after it, shared by every such ask", async (t) => {
  const dir = home(t, "tick-again-");
  const host = new AgentStateHost({ aifyHome: dir, instance: "herdr-fixture", population: "managed", nowUs: () => 1,
    probe: () => new Map() });
  host.boot();
  let reads = 0;
  let release;
  let hold = new Promise((resolve) => { release = resolve; });
  const sender = new AgentStateSender({
    identity: { machineId: "win32:fixture", instance: "herdr-fixture", generation: 10, incarnationId: "boot" },
    stateHost: host, definitions: new DefinitionStore({ dir: path.join(dir, "defs") }),
    lifecycle: { stopFacts: () => new Map() }, observedHarnesses: async () => new Set(["claude"]),
    readRegistry: async () => { reads += 1; await hold; return JSON.stringify({ version: 1, services: {} }); },
    credential: async () => ({ state: CREDENTIAL_ABSENT }),
    nowMs: () => 0, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
    fetchImpl: () => new Response(null, { status: 204 }), report: () => {} });
  t.after(() => sender.stop());
  const first = sender.tick();
  await flush();
  assert.equal(reads, 1, "the first evaluation is in flight, held at its registry read");
  const second = sender.tick();
  const third = sender.tick();
  assert.equal(second, third, "every ask made during the flight shares one follow-up");
  hold = Promise.resolve();
  release();
  await first;
  await second;
  assert.equal(reads, 2, "exactly one more evaluation ran after the one in flight");
  await sender.tick();
  assert.equal(reads, 3, "control: with nothing in flight, a tick evaluates once");
});
