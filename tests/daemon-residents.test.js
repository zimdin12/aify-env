// A daemon's side of the residents role (B1 contract items 6-9): the hook route admits a resident's event only while
// this process holds the role, a stale descriptor reaching a non-holder changes nothing, an operation that outlives the
// role cannot apply, and a successor restores the turn a crashed holder saved: still busy, still ordered by its last
// event. Real locks of temp homes; the OS probe is the only fake.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { DaemonResidents, composeIdentity } from "../lib/daemon-residents.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const SKIP = process.platform === "win32" || process.platform === "linux" ? false : `not qualified on ${process.platform}`;
const HOLDER = path.resolve(import.meta.dirname, "helpers", "residents-holder.mjs");
const L1 = "7f3c9e2a-0000-4000-8000-0000000000c1";
const PID = 4242;
const WRITTEN = 1_790_950_000_000_000;
const T2 = WRITTEN + 2_000_000;
const RESIDENT = { definition: "valid", mode: "resident", stoppedByOperator: false };
const verifying = (pids) => new Map(pids.map((pid) => [pid, pid === PID
  ? { alive: true, createdAtUs: WRITTEN - 1, commandLine: `node "${process.execPath}"` }
  : { alive: false, createdAtUs: null, commandLine: null }]));

function home(t, { generation = "200\n", record = true } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-daemon-res-")), ".aify");
  fs.mkdirSync(path.join(dir, "env"), { recursive: true });
  if (generation) fs.writeFileSync(path.join(dir, "env", "residents.generation"), generation);
  if (record) {
    fs.mkdirSync(path.join(dir, "residents"));
    fs.writeFileSync(path.join(dir, "residents", `lead.${L1}.json`), JSON.stringify({ agentId: "lead", lifetime: L1,
      instance: "residents", harness: "claude", pid: PID, launcher: process.execPath, writtenAtUs: WRITTEN }));
  }
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}
function daemon(t, aifyHome, url, nowUs = () => T2 + 10_000_000) {
  const residents = new DaemonResidents({ aifyHome, url, pid: process.pid, probe: verifying, nowUs });
  t.after(() => residents.release({ waitMs: 0 }));
  const own = new AgentStateHost({ aifyHome, instance: "default", probe: verifying, nowUs, population: "managed" });
  own.boot();
  const events = new AgentTurnEvents({ host: own, instance: "default", residents });
  const post = (body) => handleRequest({ method: "POST", path: "/agents/lead/turn-event", body }, { turnEvents: events });
  return { residents, own, events, post };
}
const turns = (dir) => fs.existsSync(path.join(dir, "env", "residents.turns.json"))
  ? fs.readFileSync(path.join(dir, "env", "residents.turns.json"), "utf8") : null;
const event = (kind, firedAtUs) => ({ instance: "residents", lifetime: L1, kind, firedAtUs });

test("a resident's event is applied by the holder and refused not-owner by a non-holder, which writes nothing", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const a = daemon(t, dir, "http://127.0.0.1:1001"), b = daemon(t, dir, "http://127.0.0.1:1002");
  assert.equal(await a.residents.acquire(), true);
  assert.equal(await b.residents.acquire(), false);
  assert.equal(b.residents.report().reason, "held-elsewhere");
  const refused = await b.post(event("turn-start", T2));
  assert.deepEqual([refused.status, refused.body.reason], [409, "not-owner"]);
  assert.equal(turns(dir), null, "a non-holder wrote the residents' turns");
  const applied = await a.post(event("turn-start", T2));
  assert.deepEqual([applied.status, applied.body.applied], [200, true]);
  assert.equal(JSON.parse(turns(dir))[L1].lastEventAtUs, T2);
  const wrong = await a.post({ ...event("turn-end", T2 + 1), instance: "herdr-elsewhere" });
  assert.deepEqual([wrong.status, wrong.body.reason], [409, "wrong-instance"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "env", "residents.json"), "utf8")).url, "http://127.0.0.1:1001");
});

test("a stale residents.json that reaches the old holder after the role moved changes nothing there", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const a = daemon(t, dir, "http://127.0.0.1:1001"), b = daemon(t, dir, "http://127.0.0.1:1002");
  await a.residents.acquire();
  const stale = JSON.parse(fs.readFileSync(path.join(dir, "env", "residents.json"), "utf8"));
  await a.residents.release({ waitMs: 0 });
  assert.equal(await b.residents.acquire(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "env", "residents.json"), "utf8")).url, "http://127.0.0.1:1002");
  assert.equal(stale.url, "http://127.0.0.1:1001", "a hook holding the old descriptor still posts to A");
  const refused = await a.post(event("turn-start", T2));
  assert.deepEqual([refused.status, refused.body.reason], [409, "not-owner"]);
  assert.equal(turns(dir), null);
  assert.equal((await b.post(event("turn-start", T2))).status, 200);
});

test("an entered operation that outlives the role's release cannot apply its effect", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const a = daemon(t, dir, "http://127.0.0.1:1001");
  await a.residents.acquire();
  const entered = a.residents.enter();
  const outcome = await a.residents.release({ waitMs: 50 });
  assert.deepEqual(outcome, { timedOut: true, abandoned: 1 });
  assert.equal(a.residents.enter(), null);
  assert.throws(() => entered.host.applyEvent({ agentId: "lead", lifetime: L1, kind: "turn-start", firedAtUs: T2 },
    { guard: entered.op.guard }), { code: "NOT_OWNER" });
  entered.op.done();
  assert.equal(turns(dir), null, "a late operation wrote after the release");
});

test("P-1 AND THE WATERMARK across a crashed holder: restored busy, an older end refused, a later end closes", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const child = spawn(process.execPath, [HOLDER, dir, "turn", "lead", L1, String(PID), String(WRITTEN), String(T2)], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  for (const end = Date.now() + 20000; !out.includes("\n") && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
  const said = JSON.parse(out.split("\n")[0]);
  assert.equal(said.held, true, out);
  assert.equal(said.generation, 201);
  assert.equal(said.applied.applied, true);
  const saved = turns(dir);
  child.kill("SIGKILL");
  await exited;
  // The crash released the lock. The successor takes the role, a higher generation and the saved turn.
  const b = daemon(t, dir, "http://127.0.0.1:1002");
  assert.equal(await b.residents.acquire(), true);
  assert.equal(b.residents.report().generation, 202);
  const busy = () => b.residents.host.current("lead", RESIDENT);
  assert.equal(busy().busy, true, "the restored open turn was not busy");
  assert.equal(busy().state, "working");
  const stale = await b.post(event("turn-end", T2 - 1));
  assert.deepEqual([stale.status, stale.body.reason], [409, "out-of-order"]);
  assert.equal(turns(dir), saved, "a refused end changed the stored turn");
  assert.deepEqual(JSON.parse(turns(dir))[L1], { open: true, startedAtUs: T2, awaitingInput: false, lastEventAtUs: T2 });
  assert.equal(busy().busy, true, "still busy after the refused end");
  const later = await b.post(event("turn-end", T2 + 1));
  assert.deepEqual([later.status, later.body.applied], [200, true]);
  assert.equal(JSON.parse(turns(dir))[L1].open, false);
  assert.deepEqual([busy().busy, busy().state], [false, "idle"]);
});

test("identity: the residents host answers for its records only while the role is held here", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const a = daemon(t, dir, "http://127.0.0.1:1001");
  const notHeld = a.residents.identity("lead", a.own);
  assert.deepEqual(notHeld, { current: null, conflict: false, unknown: true }, "a resident nobody here answers for is unknown");
  await a.residents.acquire();
  const held = a.residents.identity("lead", a.own);
  assert.equal(held.current.lifetime, L1);
  assert.deepEqual([held.conflict, held.unknown], [false, false]);
});

test("composeIdentity: two current lifetimes conflict, either unknown is unknown, no residents host is the managed answer", () => {
  const cur = (lifetime) => ({ lifetime });
  const raw = (current, conflict = false, unknown = false) => ({ current, conflict, unknown });
  assert.deepEqual(composeIdentity(raw(cur("m")), null), raw(cur("m")));
  assert.deepEqual(composeIdentity(raw(null), raw(cur("r"))), raw(cur("r")));
  assert.deepEqual(composeIdentity(raw(cur("m")), raw(null)), raw(cur("m")));
  assert.deepEqual(composeIdentity(raw(cur("m")), raw(cur("r"))), raw(null, true, false));
  assert.deepEqual(composeIdentity(raw(null, false, true), raw(cur("r"))), raw(cur("r"), false, true));
  assert.deepEqual(composeIdentity(raw(null), raw(null, true)), raw(null, true, false));
});
