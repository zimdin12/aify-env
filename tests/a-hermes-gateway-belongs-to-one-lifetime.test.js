// An agent's hermes gateway belongs to one lifetime: that lifetime gets it back live, a newer one gets its port after
// the old gateway is ended, and nothing is killed that the OS has not confirmed is that gateway (0.9.10: the comms
// bridge's markers and kill-prior moved here). The launcher starts gateways; here a test plays the launcher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import { HermesGatewayBook, isRecordedGateway, portIsFree } from '../lib/hermes-gateway-book.mjs';
import { hashedPort } from '../lib/hermes-gateway-ports.mjs';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const line = (port) => `C:\\hermes\\hermes.exe dashboard --port ${port} --host 127.0.0.1 --no-open --skip-build`;

/** A book over a temp home, with a fake gateway world: what is live, what the OS says, what was killed. */
function world(t, { commandLine = line } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-gw-book-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const live = new Map(); // port -> pid
  const killed = [];
  let nextPid = 5000;
  const book = new HermesGatewayBook({
    aifyHome: home,
    isFree: async (port) => !live.has(port),
    probe: async ({ port }) => (live.has(port) ? { port, token: `t${live.get(port)}`, wsUrl: `ws://127.0.0.1:${port}/api/ws?token=t${live.get(port)}` } : null),
    processes: async (pids) => new Map(pids.map((pid) => {
      const port = [...live].find(([, p]) => p === pid)?.[0];
      return [pid, port === undefined ? { alive: false } : { alive: true, commandLine: commandLine(port) }];
    })),
    kill: async (pid) => { killed.push(pid); for (const [port, p] of live) if (p === pid) live.delete(port); return true; },
  });
  /** What hermes-aify does: prepare, start on the port given unless one is live, register the pid. */
  const launch = async (agentId, lifetime) => {
    const prepared = await book.prepare({ agentId, lifetime });
    if (prepared.live) return { ...prepared, started: null };
    const pid = nextPid++;
    live.set(prepared.port, pid);
    assert.deepEqual(await book.register({ agentId, lifetime, port: prepared.port, pid }), { registered: true });
    return { ...prepared, started: pid };
  };
  return { home, book, live, killed, launch };
}

test('THE SAME LIFETIME GETS ITS LIVE GATEWAY BACK and starts nothing; the delivery loop finds it', async (t) => {
  const w = world(t);
  const first = await w.launch('pc-manager', L1);
  assert.equal(first.port, hashedPort('pc-manager'));
  assert.equal(first.started, 5000);
  const again = await w.launch('pc-manager', L1);
  assert.equal(again.started, null, 'a live gateway is reused');
  assert.equal(again.live.port, first.port);
  assert.deepEqual(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), again.live);
});

test('A NEWER LIFETIME ENDS THE CONFIRMED OLD GATEWAY and gets the same port', async (t) => {
  const w = world(t);
  const first = await w.launch('pc-manager', L1);
  const second = await w.launch('pc-manager', L2);
  assert.deepEqual(w.killed, [5000], "the old lifetime's gateway was ended");
  assert.equal(second.port, first.port, 'the port is kept');
  assert.equal(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), null, 'the old lifetime owns nothing now');
});

test('AN UNCONFIRMED PROCESS IS NEVER KILLED: another program on that pid, or a gateway on another port', async (t) => {
  for (const commandLine of [() => 'C:\\Program Files\\editor\\editor.exe --serve', () => line(1234)]) {
    const w = world(t, { commandLine });
    await w.launch('pc-manager', L1);
    await w.launch('pc-manager', L2);
    assert.deepEqual(w.killed, [], commandLine(0));
  }
});

test('REGISTER IS THE PREPARED LIFETIME AND PORT ONLY', async (t) => {
  const w = world(t);
  const { port } = await w.book.prepare({ agentId: 'pc-manager', lifetime: L1 });
  for (const [body, why] of [
    [{ lifetime: L2, port, pid: 7 }, 'another lifetime'],
    [{ lifetime: L1, port: port + 1, pid: 7 }, 'another port'],
    [{ lifetime: L1, port, pid: 0 }, 'no pid'],
  ]) assert.deepEqual(await w.book.register({ agentId: 'pc-manager', ...body }), { registered: false }, why);
  assert.deepEqual(await w.book.register({ agentId: 'nobody', lifetime: L1, port, pid: 7 }), { registered: false }, 'nothing prepared');
});

test('A PREPARED BUT NEVER REGISTERED RECORD ENDS NOTHING when a newer lifetime replaces it', async (t) => {
  const w = world(t);
  await w.book.prepare({ agentId: 'pc-manager', lifetime: L1 });
  await w.launch('pc-manager', L2);
  assert.deepEqual(w.killed, []);
});

test("ENDING IS THE OWNER'S: the owning lifetime ends it, any other lifetime changes nothing", async (t) => {
  const w = world(t);
  await w.launch('pc-manager', L1);
  assert.deepEqual(await w.book.end({ agentId: 'pc-manager', lifetime: L2 }), { ended: false });
  assert.deepEqual(w.killed, []);
  assert.deepEqual(await w.book.end({ agentId: 'pc-manager', lifetime: L1 }), { ended: true });
  assert.deepEqual(w.killed, [5000]);
  assert.deepEqual(w.book.records(), [], 'its record is gone');
});

test('ASKING STARTS NOTHING: current answers null for a dead gateway or an unknown agent', async (t) => {
  const w = world(t);
  assert.equal(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), null);
  await w.launch('pc-manager', L1);
  w.live.clear();
  assert.equal(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), null);
  const again = await w.launch('pc-manager', L1);
  assert.equal(again.started, 5001, 'a dead gateway gets a new start when its lifetime prepares again');
  assert.equal(again.port, hashedPort('pc-manager'));
});

test('TWO AGENTS THAT HASH TOGETHER get two ports: a recorded port is held even while its gateway is down', async (t) => {
  const w = world(t);
  const a = await w.launch('comms-senior-dev', L1);
  w.live.clear();
  const b = await w.launch('graph-hermes-tl', L2);
  assert.equal(a.port, 9341);
  assert.equal(b.port, 9342);
});

test('PREPARING TWICE AT ONCE decides once', async (t) => {
  const w = world(t);
  const [a, b] = await Promise.all([w.book.prepare({ agentId: 'pc-manager', lifetime: L1 }), w.book.prepare({ agentId: 'pc-manager', lifetime: L1 })]);
  assert.equal(a.port, b.port);
  assert.equal(w.book.records().length, 1);
});

test('AN AGENT ID IS NEVER A PATH', (t) => {
  const w = world(t);
  assert.throws(() => w.book.prepare({ agentId: '../escape', lifetime: L1 }), /not an agent id/);
  assert.throws(() => w.book.register({ agentId: 'a/b', lifetime: L1, port: 9000, pid: 7 }), /not an agent id/);
  assert.throws(() => w.book.current({ agentId: 'a/b', lifetime: L1 }), /not an agent id/);
  assert.throws(() => w.book.end({ agentId: '', lifetime: L1 }), /not an agent id/);
});

test("isRecordedGateway confirms only hermes dashboard on the record's own port, alive", () => {
  const record = { port: 9341 };
  assert.equal(isRecordedGateway(record, { alive: true, commandLine: line(9341) }), true);
  assert.equal(isRecordedGateway(record, { alive: true, commandLine: 'hermes dashboard --port=9341' }), true);
  assert.equal(isRecordedGateway(record, { alive: true, commandLine: line(93410) }), false, 'a longer port is another port');
  assert.equal(isRecordedGateway(record, { alive: true, commandLine: 'node server.js --port 9341' }), false);
  assert.equal(isRecordedGateway(record, { alive: null, commandLine: line(9341) }), false, 'an unanswered probe confirms nothing');
  assert.equal(isRecordedGateway(record, undefined), false);
});

test('portIsFree says busy for a port something listens on, and free once it stops', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await portIsFree(port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portIsFree(port), true);
});
