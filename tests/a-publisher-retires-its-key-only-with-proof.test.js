// B5: a daemon retires its managed agent-state key at a clean shutdown, and only when it can prove the key holds
// nothing (aify-comms docs/superpowers/plans/2026-10-20-b5-publisher-retirement.md, rev3).
//
// THE PROOF is that every lifetime the publisher ever NUMBERED in a body is one the managed host saw END. Each test
// below is paired, in that plan, with the mutation it must fail under. The receiver is a fake here: whether a real
// aify-comms commits the retirement is aify-comms' own test (its cursor decides), never this file's.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentStatePublisher } from "../lib/agent-state-publisher.mjs";
import { AgentStateSender } from "../lib/agent-state-sender.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { Runner } from "../lib/runner.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { buildStartSpec } from "../lib/start-spec.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { createShutdown } from "../lib/shutdown.mjs";
import { daemonShutdownHooks } from "../lib/shutdown-hooks.mjs";
import { turnsFile } from "../lib/turns-file.mjs";
import { CREDENTIAL_ABSENT } from "../lib/credential-store.mjs";

const AT = 1_790_950_000_600_000;
const L1 = "7f3c9e2a-0000-4000-8000-0000000000b1";
const TEXT = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\n';
const IDENTITY = { machineId: "win32:fixture", instance: "herdr-fixture", generation: 10, incarnationId: "fixture-boot" };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const target = (endpoint = "http://fixture.invalid/mcp/sse") => ({ endpoint, agentState: { path: "/api/v1/agent-state" } });

function home(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A managed host, a sender over it, and a fake receiver per destination name. */
function senderFixture(t, { population = "managed", answer = () => new Response(null, { status: 204 }) } = {}) {
  const dir = home(t, "b5-sender-");
  const host = new AgentStateHost({ aifyHome: dir, instance: IDENTITY.instance, population, nowUs: () => AT,
    probe: (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: AT - 10, commandLine: "bash C:/fixture/claude-aify" }])) });
  host.boot();
  let services = { x: target() };
  let registryHold = null;
  const calls = [], reports = [];
  let credentialReads = 0;
  const sender = new AgentStateSender({ identity: IDENTITY, stateHost: host, definitions: new DefinitionStore({ dir: path.join(dir, "defs") }),
    lifecycle: { stopFacts: () => new Map() }, observedHarnesses: async () => new Set(["claude"]),
    readRegistry: async () => { if (registryHold) await registryHold; return JSON.stringify({ version: 1, services }); },
    credential: async () => { credentialReads++; return { state: CREDENTIAL_ABSENT }; },
    nowMs: () => 0, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
    fetchImpl: (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body, signal: options.signal }); return answer(url, body, options); },
    report: (line) => reports.push(line) });
  t.after(() => sender.stop());
  const start = (lifetime = L1) => host.startManaged({ agentId: "lead", lifetime, instance: IDENTITY.instance, pid: 41, handle: "fixture" });
  const tick = async () => { await sender.tick(); await flush(); await flush(); };
  return { host, sender, calls, reports, start, tick, credentialReads: () => credentialReads,
    holdRegistry: (promise) => { registryHold = promise; },
    services: (value) => { services = value; } };
}

/** The real Runner over a managed host, as tests/the-managed-child-reaches-agent-state.test.js builds it. */
function runnerFixture(t, { alive = false } = {}) {
  const dir = home(t, "b5-runner-");
  let isAlive = alive;
  const host = new AgentStateHost({ aifyHome: dir, instance: "default", population: "managed", nowUs: () => AT + 1000,
    probe: (pids) => new Map(pids.map((pid) => [pid, { alive: true, createdAtUs: AT - 10, commandLine: "bash /fixture/claude-aify" }])) });
  host.boot();
  const children = [];
  const spawn = (_command, _args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 100 + children.length, cols: 80, rows: 24, env: options.env,
      stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} },
      onData() {}, onExit(fn) { child.finish = fn; }, kill() {}, destroy() {}, write() {}, resize() {} });
    children.push(child);
    return child;
  };
  const runner = new Runner({ openTerminal: spawn, spawnProcess: spawn, managedHost: () => ({ host, instance: "default", url: "http://127.0.0.1:18802" }),
    reportManaged: () => {}, isAlive: () => isAlive, killTree: async () => { isAlive = false; } });
  const spec = () => buildStartSpec({ service: "fixture", launcher: "/fixture/claude-aify", agentId: "lead", env: { PATH: "toolchain" } },
    { readFile: () => TEXT, platform: "linux" }).spec;
  const started = async () => { const handle = await runner.start(spec()); return { handle, lifetime: children.at(-1).env.AIFY_LIFETIME }; };
  return { dir, host, runner, children, started, setAlive: (value) => { isAlive = value; } };
}

test("proof_covers_every_numbered_body: a body aborted in flight still names its lifetime, so it is not proven ended", async (t) => {
  const never = defer();
  const f = senderFixture(t, { answer: () => never.promise });
  f.start();
  await f.tick();
  assert.equal(f.calls.length, 1, "CONTROL: a body naming L1 was numbered and posted");
  assert.equal(f.calls[0].body.agents.find((row) => row.agentId === "lead")?.lifetime, L1);
  f.sender.stop();
  assert.equal(f.calls[0].signal.aborted, true, "CONTROL: stop aborted the body in flight, unacknowledged");
  // The shutdown slot's deadline, so a retirement that wrongly goes ahead ends unconfirmed instead of hanging.
  const deadline = new AbortController();
  const retiring = f.sender.retire({ signal: deadline.signal });
  await flush(); await flush();
  deadline.abort();
  const outcome = await retiring;
  assert.equal(outcome.outcome, "not-proven", "an unacknowledged body's lifetime fell out of the proof");
  assert.equal(f.calls.length, 1, "a retirement was numbered and posted without a proof");
  assert.match(f.reports.at(-1), /agent state retirement: not-proven \(1 lifetimes\)/);
});

test("proof_rejects_registry_deletion_and_killTree_return: a stop that saw no exit ends nothing", async (t) => {
  const f = runnerFixture(t, { alive: true });
  const { handle, lifetime } = await f.started();
  await f.runner.stop(handle.id);
  assert.deepEqual(f.runner.list(), [], "CONTROL: the registry entry is gone and killTree returned");
  assert.deepEqual(f.host.retirementProof([lifetime]), { holds: false, unproven: [lifetime], reason: "not every published lifetime ended" });
  // A lifetime this host never started is absent from its managed set too; absence is not an end.
  assert.equal(f.host.retirementProof(["never-started-here"]).holds, false, "absence from the managed set was read as an end");

  const g = senderFixture(t);
  g.start();
  await g.tick();
  // The stops all settled (nothing stuck) and the process registry is empty, but no end was observed.
  assert.equal((await g.sender.retire()).outcome, "not-proven", "a settled stop list was taken as proof");
  assert.equal(g.calls.filter((call) => call.body.kind === "retired").length, 0);
});

test("proof_accepts_each_confirmed_end_path: observed exit, dead at stop, release, a verified lifecycle stop, a persistence-failed end", async (t) => {
  // Observed exit (runner.mjs onExit -> ManagedLifetimes.end).
  const exit = runnerFixture(t);
  const a = await exit.started();
  exit.children[0].finish({ exitCode: 0 });
  await a.handle.exited;
  assert.equal(exit.host.retirementProof([a.lifetime]).holds, true, "an observed exit was not an end");

  // Dead at stop (isAlive === false at runner.stop).
  const dead = runnerFixture(t, { alive: false });
  const b = await dead.started();
  await dead.runner.stop(b.handle.id);
  assert.equal(dead.host.retirementProof([b.lifetime]).holds, true, "a stop that found the pid dead was not an end");

  // The reaper's release of a proven-dead pid.
  const released = runnerFixture(t);
  const c = await released.started();
  released.runner.release(c.handle.id);
  assert.equal(released.host.retirementProof([c.lifetime]).holds, true, "release was not an end");

  // The lifecycle's verified stop (stopAndVerify saw the pid gone, then endManaged).
  const life = runnerFixture(t, { alive: true });
  const d = await life.started();
  const ports = createAgentLifecyclePorts({ aifyHome: life.dir, machineId: "machine", stateHost: life.host, runner: life.runner,
    definitions: new DefinitionStore({ dir: path.join(life.dir, "definitions") }), probe: () => new Map(),
    isAlive: () => false, killTree: async () => {}, settleMs: 0, installed: async () => new Set(), buildSpec: async () => ({}) });
  const witness = life.host.rawIdentity("lead").current;
  assert.equal(witness?.lifetime, d.lifetime, "CONTROL: the witness is the started lifetime");
  assert.equal(await ports.stop(witness, "managed"), true, "CONTROL: the lifecycle stop verified the pid gone");
  assert.equal(life.host.retirementProof([d.lifetime]).holds, true, "a verified lifecycle stop was not an end");

  // An end whose turns file could not be written is still an end.
  const broken = runnerFixture(t);
  const e = await broken.started();
  const events = new AgentTurnEvents({ host: broken.host, instance: "default" });
  const sent = await handleRequest({ method: "POST", path: "/agents/lead/turn-event",
    body: { instance: "default", lifetime: e.lifetime, kind: "turn-start", firedAtUs: AT + 1 } }, { turnEvents: events });
  assert.equal(sent.body.applied, true, "CONTROL: the lifetime has a turn on disk");
  const file = turnsFile(broken.dir, "default");
  fs.rmSync(file); fs.mkdirSync(file);
  broken.children[0].finish({ exitCode: 1 });
  await e.handle.exited;
  assert.equal(broken.host.retirementProof([e.lifetime]).holds, true, "a persistence-failed end was not an end");
});

test("proof_refuses_non_managed_population: residents and all hosts are never retired", async (t) => {
  for (const population of ["residents", "all"]) {
    const f = senderFixture(t, { population });
    assert.equal(f.host.retirementProof([]).holds, false, `${population} host gave a proof`);
    assert.equal((await f.sender.retire()).outcome, "not-proven", `${population} sender retired its key`);
    assert.equal(f.calls.filter((call) => call.body.kind === "retired").length, 0);
  }
  const managed = senderFixture(t);
  assert.equal(managed.host.retirementProof([]).holds, true, "CONTROL: a managed host that published no lifetime may retire");
});

test("retirement_numbered_above_every_body: same generation and incarnation, n+1; a later body throws", async (t) => {
  const f = senderFixture(t);
  f.start();
  await f.tick();
  f.host.endManaged(L1);
  const before = f.calls.at(-1).body;
  const outcome = await f.sender.retire();
  assert.equal(outcome.outcome, "confirmed");
  const retired = f.calls.at(-1).body;
  assert.deepEqual(retired, { kind: "retired", machineId: IDENTITY.machineId, instance: IDENTITY.instance,
    generation: before.generation, incarnationId: before.incarnationId, publication: before.publication + 1, reason: "shutdown", inputs: {} });

  const publisher = new AgentStatePublisher({ ...IDENTITY });
  publisher.snapshot({ complete: true, agents: [] });
  assert.equal(publisher.retire().body.publication, 2);
  assert.throws(() => publisher.snapshot({ complete: true, agents: [] }), /retired/);
  assert.throws(() => publisher.changes({ complete: true, agents: [] }, null), /retired/);
});

test("no_turn_event_body_after_retirement: nothing is numbered or sent after the retirement", async (t) => {
  const f = senderFixture(t);
  f.start();
  await f.tick();
  f.host.endManaged(L1);
  await f.sender.retire();
  const sent = f.calls.length, reads = f.credentialReads();
  await f.tick();
  assert.equal(f.calls.length, sent, "a body went out after the retirement");
  // The publisher would refuse a body anyway; the sender must not even start composing one (no credential read).
  assert.equal(f.credentialReads(), reads, "the sender reopened after the retirement");
  await assert.rejects(f.sender.retire(), /retired/, "a second retirement was numbered");
});

test("transport_only_terminal_and_still_registered: a destination gone or changed gets no credential read and no post", async (t) => {
  const f = senderFixture(t);
  f.services({ x: target(), y: target("http://other.invalid/mcp/sse") });
  f.start();
  await f.tick();
  assert.deepEqual(new Set(f.calls.map((call) => new URL(call.url).host)), new Set(["fixture.invalid", "other.invalid"]), "CONTROL: both were sent a body");
  f.host.endManaged(L1);
  f.sender.stop();
  f.services({ x: target() });
  const reads = f.credentialReads();
  const outcome = await f.sender.retire();
  const retired = f.calls.filter((call) => call.body.kind === "retired");
  assert.deepEqual(retired.map((call) => new URL(call.url).host), ["fixture.invalid"], "a deregistered destination was sent the retirement");
  assert.equal(f.credentialReads() - reads, 1, "a credential was read for a destination no longer registered");
  assert.deepEqual([outcome.outcome, outcome.reason], ["unconfirmed", "destination-not-authorized"]);
});

test("transport_ignores_occupancy_and_never_reopens: an aborted request in flight neither delays nor is released", async (t) => {
  const never = defer();
  let first = true;
  const f = senderFixture(t, { answer: (url, body) => (body.kind === "retired" ? new Response(null, { status: 204 })
    : first ? (first = false, never.promise) : new Response(null, { status: 204 })) });
  f.start();
  await f.tick();
  f.host.endManaged(L1);
  f.sender.stop();
  const outcome = await f.sender.retire();
  assert.equal(outcome.outcome, "confirmed", "the retirement waited on, or was refused by, the occupied request");
  const sent = f.calls.length, reads = f.credentialReads();
  await f.tick();
  assert.equal(f.calls.length, sent, "tick() after the retirement published again");
  assert.equal(f.credentialReads(), reads, "tick() after the retirement reopened the sender (it read a credential)");
});

test("retirement_one_deadline_then_unconditional_exit: a post that never answers is unconfirmed at the deadline, and exit runs", async (t) => {
  const never = defer();
  const f = senderFixture(t, { answer: () => never.promise });
  await f.tick();
  f.sender.stop();
  const timers = [];
  const events = [];
  const shutdown = createShutdown({ runner: { list: () => [], stop: async () => {} }, clearOwned: () => events.push("cleared"),
    exit: (code) => events.push(`exit ${code}`), write: (line) => events.push(line.trim()),
    afterStops: ({ signal }) => f.sender.retire({ signal }).then((outcome) => events.push(`outcome ${outcome.outcome}`)),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const done = shutdown("SIGTERM");
  await flush(); await flush();
  const retireTimer = timers.find((timer) => timer.ms === 1000);
  assert.ok(retireTimer, "no 1000 ms deadline was armed for the retirement");
  assert.equal(events.includes("exit 0"), false, "CONTROL: the exit waited for the slot");
  retireTimer.fn();
  await done;
  assert.ok(f.reports.some((line) => /agent state retirement: unconfirmed, deadline/.test(line)), "the outcome was not written at the deadline");
  assert.ok(events.indexOf("exit 0") > -1, "no exit after the deadline");

  for (const slot of [() => { throw new Error("thrown"); }, () => Promise.reject(new Error("rejected"))]) {
    const exits = [];
    await createShutdown({ runner: { list: () => [], stop: async () => {} }, clearOwned: () => {}, exit: (code) => exits.push(code),
      afterStops: slot, setTimer: () => 0, clearTimer: () => {} })("SIGTERM");
    assert.deepEqual(exits, [0], "a slot that threw or rejected held the exit");
  }

  const second = [];
  let secondTimer = null;
  const hung = createShutdown({ runner: { list: () => [], stop: async () => {} }, clearOwned: () => second.push("cleared"),
    exit: (code) => second.push(code), write: () => {}, afterStops: () => new Promise(() => {}),
    setTimer: (fn, ms) => { if (ms === 1000) secondTimer = fn; return 1; }, clearTimer: () => {} });
  void hung("SIGTERM");
  await flush(); await flush();
  assert.ok(secondTimer, "CONTROL: the slot is being waited for");
  await hung("SIGINT");
  await flush(); await flush();
  // The WAIT ended, so the record is cleared and then the exit runs; an exit that skipped the record is the other branch.
  assert.deepEqual(second, ["cleared", 0], "a second signal did not end the wait");
});

test("a deadline before the destinations are known is unconfirmed, never a vacuous confirmation", async (t) => {
  const f = senderFixture(t);
  f.start();
  await f.tick();
  f.host.endManaged(L1);
  f.holdRegistry(new Promise(() => {}));
  const deadline = new AbortController();
  const retiring = f.sender.retire({ signal: deadline.signal });
  await flush(); await flush();
  deadline.abort();
  const outcome = await retiring;
  assert.deepEqual([outcome.outcome, outcome.reason, outcome.destinations], ["unconfirmed", "deadline", {}]);
});

test("attempt_is_not_confirmation: 200 applied:false, 422, an abort and a transport failure are each unconfirmed", async (t) => {
  const answers = [
    () => new Response(JSON.stringify({ applied: false }), { status: 200 }),
    () => new Response(null, { status: 422 }),
    () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    () => Promise.reject(new Error("connection refused")),
  ];
  for (const answer of answers) {
    const f = senderFixture(t, { answer: (url, body) => (body.kind === "retired" ? answer() : new Response(null, { status: 204 })) });
    await f.tick();
    const outcome = await f.sender.retire();
    assert.equal(outcome.outcome, "unconfirmed", `an attempt answered ${answer} was taken as confirmed`);
  }
});

test("unconfirmed_never_resurrects_k: a receiver that committed and never answered gets no later body under K", async (t) => {
  const never = defer();
  const f = senderFixture(t, { answer: (url, body) => (body.kind === "retired" ? never.promise : new Response(null, { status: 204 })) });
  f.start();
  await f.tick();
  f.host.endManaged(L1);
  const deadline = new AbortController();
  const retiring = f.sender.retire({ signal: deadline.signal });
  await flush(); await flush();
  assert.equal(f.calls.at(-1).body.kind, "retired", "CONTROL: the receiver was sent the retirement (it may have committed)");
  deadline.abort();
  assert.equal((await retiring).outcome, "unconfirmed");
  const sent = f.calls.length;
  await f.tick();
  await f.tick();
  assert.equal(f.calls.length, sent, "a body was published under K after an unconfirmed retirement");
});

test("outcome_lists_each_destination: one confirmed and one at the deadline are both named beside the aggregate", async (t) => {
  const never = defer();
  const f = senderFixture(t, { answer: (url, body) => (body.kind === "retired" && url.includes("other.invalid") ? never.promise : new Response(null, { status: 204 })) });
  f.services({ x: target(), y: target("http://other.invalid/mcp/sse") });
  await f.tick();
  const deadline = new AbortController();
  const retiring = f.sender.retire({ signal: deadline.signal });
  await flush(); await flush(); await flush();
  deadline.abort();
  const outcome = await retiring;
  assert.deepEqual(outcome.destinations, { x: "confirmed", y: "unconfirmed (deadline)" });
  assert.equal(outcome.outcome, "unconfirmed");
  assert.match(f.reports.at(-1), /^agent state retirement: unconfirmed, deadline \["x"=confirmed, "y"=unconfirmed \(deadline\)\]$/);
});

test("the daemon's shutdown hooks put the retirement in the after-stops slot, with its signal", async () => {
  const seen = [];
  const hooks = daemonShutdownHooks({ runner: {}, stopView() {}, releaseResidents: async () => {}, inputSocket: () => null,
    servicePlugins: { stopAll: async () => {} }, closeHttpServer() {}, clearOwned() {}, exit() {}, write() {},
    retireAgentState: (options) => { seen.push(options); return Promise.resolve(); } });
  const signal = new AbortController().signal;
  await hooks.afterStops({ signal });
  assert.equal(seen[0].signal, signal);
  assert.equal(daemonShutdownHooks({ runner: {}, stopView() {}, releaseResidents: async () => {}, inputSocket: () => null,
    servicePlugins: { stopAll: async () => {} }, closeHttpServer() {}, clearOwned() {}, exit() {}, write() {} }).afterStops, null);
});
