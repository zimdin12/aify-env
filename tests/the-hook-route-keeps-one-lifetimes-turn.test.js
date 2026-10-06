// G3: real protocol -> AgentTurnEvents -> real state host -> durable turns, with only OS answers faked.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleRequest } from "../lib/protocol.mjs";
import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { turnsFile } from "../lib/turns-file.mjs";

const L1 = "7f3c9e2a-0000-4000-8000-000000000001";
const L2 = "7f3c9e2a-0000-4000-8000-000000000002";
const AT = 1_790_950_000_600_000;
const WRITTEN = AT - 1000;
const RESIDENT = { definition: "valid", mode: "resident", stoppedByOperator: false };
const record = (lifetime = L1, pid = 41, instance = "default", agentId = "lead") => ({
  agentId, lifetime, instance, harness: "claude", pid, launcher: "C:/fixture/claude-aify", writtenAtUs: WRITTEN,
});
const running = () => ({ alive: true, createdAtUs: WRITTEN - 1, commandLine: 'bash.exe "C:/fixture/claude-aify"' });
const absent = () => ({ alive: false, createdAtUs: null, commandLine: null });
const unknown = () => ({ alive: null, createdAtUs: null, commandLine: null });
const turn = (last = AT) => ({ open: true, startedAtUs: AT - 100, awaitingInput: false, lastEventAtUs: last });

async function fixture(t, { records = [record()], answers = { 41: running() }, stored } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hook-route-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "residents"));
  for (const r of records) fs.writeFileSync(path.join(home, "residents", `${r.agentId}.${r.lifetime}.json`), JSON.stringify(r));
  const file = turnsFile(home, "default");
  if (stored) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(stored)); }
  const probes = [];
  const host = new AgentStateHost({ aifyHome: home, instance: "default", nowUs: () => AT + 1000,
    probe: (pids) => { probes.push([...pids]); return new Map(pids.map((pid) => [pid, answers[pid] ?? absent()])); } });
  host.boot();
  // Imported after setup so the initial RED proves the real missing protocol route before a new module exists.
  const missing = await handleRequest({ method: "POST", path: "/agents/lead/turn-event", body: {} }, {});
  assert.notEqual(missing.status, 404, "the protocol has no hook route");
  const { AgentTurnEvents } = await import("../lib/agent-turn-events.mjs");
  const logs = [];
  const receiver = new AgentTurnEvents({ host, instance: "default", report: (line) => logs.push(line) });
  const send = (body, id = "lead", method = "POST") => handleRequest({ method, path: `/agents/${id}/turn-event`, body }, { turnEvents: receiver });
  return { home, file, host, receiver, logs, probes, answers, send,
    body: (extra = {}) => ({ instance: "default", lifetime: L1, kind: "turn-start", firedAtUs: AT + 1, ...extra }),
    bytes: () => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
}

const rows = [
  { name: "unknown kind", extra: { kind: "made-up" }, applied: false, reason: "unknown-kind" },
  { name: "no timestamp", extra: { firedAtUs: null }, applied: false, reason: "no-timestamp" },
  { name: "unbound", extra: { lifetime: "", kind: "turn-end" }, applied: false, reason: "unbound" },
  { name: "no adoption", records: [], applied: false, reason: "not-current" },
  { name: "another lifetime", extra: { lifetime: L2 }, applied: false, reason: "not-current" },
  { name: "proved ended", answers: { 41: absent() }, applied: false, reason: "not-current" },
  { name: "other instance's record", records: [record(L1, 41, "other")], applied: false, reason: "not-current" },
  { name: "two verified lifetimes", records: [record(), record(L2, 42)], answers: { 41: running(), 42: running() }, applied: false, reason: "conflict" },
  { name: "cross-instance conflict", records: [record(), record(L2, 42, "other")], answers: { 41: running(), 42: running() }, applied: false, reason: "conflict" },
  { name: "identity unknown start", answers: { 41: unknown() }, stored: { [L1]: turn() }, applied: false, reason: "identity-unknown" },
  { name: "identity unknown retained end", answers: { 41: unknown() }, stored: { [L1]: turn() }, extra: { kind: "turn-end" }, applied: true, reason: "retained-end:later" },
  { name: "first event", applied: true, reason: "current:first" },
  { name: "later event", stored: { [L1]: turn() }, applied: true, reason: "current:later" },
  { name: "earlier event", stored: { [L1]: turn() }, extra: { firedAtUs: AT - 1 }, applied: false, reason: "out-of-order" },
  { name: "tie end", stored: { [L1]: turn() }, extra: { kind: "turn-end", firedAtUs: AT }, applied: true, reason: "current:end-wins-tie" },
  { name: "tie start", stored: { [L1]: turn() }, extra: { firedAtUs: AT }, applied: false, reason: "out-of-order" },
];
for (const row of rows) test(`hook route C3/C4: ${row.name}`, async (t) => {
  const f = await fixture(t, row);
  const before = f.bytes();
  const result = await f.send(f.body(row.extra));
  assert.equal(result.status, row.applied ? 200 : 409);
  assert.equal(result.body.applied, row.applied);
  assert.equal(result.body.reason, row.reason);
  assert.equal(result.body.agentId, "lead");
  if (row.applied) {
    assert.notEqual(f.bytes(), null, "an accepted hook was not persisted");
    const stored = JSON.parse(f.bytes())[L1];
    assert.equal(stored.lastEventAtUs, f.body(row.extra).firedAtUs, "an accepted hook was not persisted");
    assert.equal(stored.open, f.body(row.extra).kind !== "turn-end");
    assert.deepEqual(f.receiver.refusals(), {});
  } else {
    assert.equal(f.bytes(), before, "a refused hook changed the stored turn");
    assert.deepEqual(f.receiver.refusals(), { [row.reason]: 1 });
    assert.deepEqual(f.logs, [`agent turn event refused: ${row.reason}`]);
  }
});

test("instance/body refusals precede the probe; route identity cannot be replaced by the body", async (t) => {
  const f = await fixture(t, { records: [record(), record(L2, 42, "default", "other")], answers: { 41: running(), 42: running() } });
  const before = f.probes.length;
  for (const body of [null, [], "fixture", { instance: "default", kind: ["turn-start"] }]) {
    const r = await f.send(body);
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "malformed-event");
  }
  for (const instance of [undefined, "other"]) {
    const r = await f.send(f.body({ instance }));
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "wrong-instance");
  }
  assert.equal(f.probes.length, before, "an envelope refusal probed processes");
  const r = await f.send(f.body({ agentId: "other", lifetime: L2 }));
  assert.equal(r.body.reason, "not-current", "the body retargeted another agent's lifetime");
  assert.equal(f.bytes(), null);
  const good = await f.send(f.body({ agentId: "other" }));
  assert.equal(good.body.applied, true);
  assert.ok(Object.hasOwn(JSON.parse(f.bytes()), L1));
  assert.equal(Object.hasOwn(JSON.parse(f.bytes()), L2), false);
});

test("methods and unavailable state refuse without an applied success", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(f.body(), "lead", "GET")).status, 405);
  assert.equal((await handleRequest({ method: "POST", path: "/agents/lead/turn-event", body: f.body() }, {})).status, 503);
  assert.equal(f.bytes(), null);
});

test("every hook refreshes the real host: an exited or PID-reused lifetime cannot apply from boot's stale yes", async (t) => {
  for (const [label, next] of [["exit", absent()], ["PID reuse", { ...running(), createdAtUs: WRITTEN + 1 }]]) {
    const f = await fixture(t);
    assert.equal(f.host.current("lead", RESIDENT).process.verified, "yes");
    f.answers[41] = next;
    const r = await f.send(f.body());
    assert.equal(r.body.reason, "not-current", label);
    assert.equal(f.bytes(), null, label);
    assert.equal(f.probes.length, 2, "one batch per received valid envelope after the boot batch");
  }
});

test("applied events survive a new real host and keep anchor, blocked state, ties and delayed starts", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(f.body())).body.applied, true);
  assert.equal((await f.send(f.body({ kind: "blocked", firedAtUs: AT + 2 }))).body.applied, true);
  assert.equal(f.host.current("lead", RESIDENT).state, "blocked");
  const g = new AgentStateHost({ aifyHome: f.home, instance: "default", nowUs: () => AT + 1000,
    probe: (pids) => new Map(pids.map((pid) => [pid, running()])) });
  g.boot();
  const { AgentTurnEvents } = await import("../lib/agent-turn-events.mjs");
  const receive = new AgentTurnEvents({ host: g, instance: "default" });
  const send = (body) => handleRequest({ method: "POST", path: "/agents/lead/turn-event", body }, { turnEvents: receive });
  assert.equal(g.current("lead", RESIDENT).turn.startedAtUs, AT + 1);
  assert.equal(g.current("lead", RESIDENT).state, "blocked");
  assert.equal((await send(f.body({ kind: "unblocked", firedAtUs: AT + 3 }))).body.applied, true);
  assert.equal(g.current("lead", RESIDENT).state, "working");
  assert.equal((await send(f.body({ kind: "turn-end", firedAtUs: AT + 3 }))).body.applied, true);
  const before = f.bytes();
  assert.equal((await send(f.body({ firedAtUs: AT + 2 }))).body.reason, "out-of-order");
  assert.equal(f.bytes(), before);
  assert.equal(g.current("lead", RESIDENT).state, "idle");
});

test("write failure is an HTTP refusal and never commits the in-memory turn", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.mkdirSync(f.file);
  const result = await f.send(f.body());
  assert.equal(result.status, 503);
  assert.equal(result.body.applied, false);
  assert.equal(result.body.reason, "persistence-failed");
  assert.equal(f.host.current("lead", RESIDENT).turn, null);
  assert.equal(f.host.current("lead", RESIDENT).stateCause, "turn-unknown");
  assert.equal(fs.statSync(f.file).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [path.basename(f.file)], "failed write left no temporary file");
});

test("a corrupt stored record is not an unordered reachable turn: boot reports it, next verified hook makes it known", async (t) => {
  // readTurns rejects a negative/non-integer lastEventAtUs before route admission. Do not forge private host state.
  const f = await fixture(t, { stored: { [L1]: { ...turn(), lastEventAtUs: -1 } } });
  assert.equal(f.host.current("lead", RESIDENT).stateCause, "turn-unknown");
  assert.equal((await f.send(f.body())).body.reason, "current:first");
  assert.equal(JSON.parse(f.bytes())[L1].lastEventAtUs, AT + 1);
});
