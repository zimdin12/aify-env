// An agent's hermes gateway belongs to one lifetime: that lifetime reuses it, a newer one replaces it, and nothing is
// killed that the OS has not confirmed is that gateway (0.9.10: the comms bridge's markers and kill-prior moved here).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import net from 'node:net';
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
  const started = [];
  const killed = [];
  let nextPid = 5000;
  const book = new HermesGatewayBook({
    aifyHome: home,
    isFree: async (port) => !live.has(port),
    start: async ({ port, ownerPid }) => {
      await new Promise((r) => setImmediate(r));
      const pid = nextPid++;
      live.set(port, pid);
      started.push({ port, ownerPid, pid });
      return { port, token: `t${pid}`, wsUrl: `ws://127.0.0.1:${port}/api/ws?token=t${pid}`, pid };
    },
    probe: async ({ port }) => (live.has(port) ? { port, token: `t${live.get(port)}`, wsUrl: `ws://127.0.0.1:${port}/api/ws?token=t${live.get(port)}` } : null),
    processes: async (pids) => new Map(pids.map((pid) => {
      const port = [...live].find(([, p]) => p === pid)?.[0];
      return [pid, port === undefined ? { alive: false } : { alive: true, commandLine: commandLine(port) }];
    })),
    kill: async (pid) => { killed.push(pid); for (const [port, p] of live) if (p === pid) live.delete(port); return true; },
  });
  return { home, book, live, started, killed };
}

test('THE SAME LIFETIME REUSES ITS LIVE GATEWAY; asking twice at once starts one', async (t) => {
  const w = world(t);
  const [a, b] = await Promise.all([
    w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 }),
    w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 }),
  ]);
  assert.equal(w.started.length, 1, 'the launcher and the delivery loop asking together start one gateway');
  assert.deepEqual(a, b);
  assert.equal(a.port, hashedPort('pc-manager'));
  assert.deepEqual(w.started[0], { port: a.port, ownerPid: 70, pid: 5000 });
  assert.deepEqual(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), a);
});

test('A NEWER LIFETIME ENDS THE CONFIRMED OLD GATEWAY and starts its own on the same port, owned by its launcher', async (t) => {
  const w = world(t);
  const first = await w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 });
  const second = await w.book.ensure({ agentId: 'pc-manager', lifetime: L2, ownerPid: 71 });
  assert.deepEqual(w.killed, [5000], 'the old lifetime\'s gateway was ended');
  assert.equal(second.port, first.port, 'the port is kept');
  assert.equal(w.started.at(-1).ownerPid, 71);
  assert.equal(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), null, 'the old lifetime owns nothing now');
});

test('AN UNCONFIRMED PROCESS IS NEVER KILLED: another program on that pid, or a gateway on another port', async (t) => {
  for (const commandLine of [() => 'C:\\Program Files\\editor\\editor.exe --serve', () => line(1234)]) {
    const w = world(t, { commandLine });
    await w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 });
    await w.book.ensure({ agentId: 'pc-manager', lifetime: L2, ownerPid: 71 });
    assert.deepEqual(w.killed, [], commandLine(0));
    assert.equal(w.started.length, 2, 'the new lifetime still gets its own gateway');
  }
});

test('ENDING IS THE OWNER\'S: the owning lifetime ends it, any other lifetime changes nothing', async (t) => {
  const w = world(t);
  await w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 });
  assert.deepEqual(await w.book.end({ agentId: 'pc-manager', lifetime: L2 }), { ended: false });
  assert.deepEqual(w.killed, []);
  assert.deepEqual(await w.book.end({ agentId: 'pc-manager', lifetime: L1 }), { ended: true });
  assert.deepEqual(w.killed, [5000]);
  assert.deepEqual(w.book.records(), [], 'its record is gone');
});

test('ASKING STARTS NOTHING: current answers null for a dead gateway or an unknown agent', async (t) => {
  const w = world(t);
  assert.equal(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), null);
  await w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 });
  w.live.clear();
  assert.equal(await w.book.current({ agentId: 'pc-manager', lifetime: L1 }), null);
  assert.equal(w.started.length, 1);
  const again = await w.book.ensure({ agentId: 'pc-manager', lifetime: L1, ownerPid: 70 });
  assert.equal(w.started.length, 2, 'a dead gateway is restarted when its lifetime asks to ensure one');
  assert.equal(again.port, hashedPort('pc-manager'));
});

test('TWO AGENTS THAT HASH TOGETHER get two ports: a recorded port is held even while its gateway is down', async (t) => {
  const w = world(t);
  const a = await w.book.ensure({ agentId: 'comms-senior-dev', lifetime: L1, ownerPid: 70 });
  w.live.clear();
  const b = await w.book.ensure({ agentId: 'graph-hermes-tl', lifetime: L2, ownerPid: 71 });
  assert.equal(a.port, 9341);
  assert.equal(b.port, 9342);
});

test('AN AGENT ID IS NEVER A PATH', async (t) => {
  const w = world(t);
  assert.throws(() => w.book.ensure({ agentId: '../escape', lifetime: L1, ownerPid: 70 }), /not an agent id/);
  assert.throws(() => w.book.current({ agentId: 'a/b', lifetime: L1 }), /not an agent id/);
  assert.throws(() => w.book.end({ agentId: '', lifetime: L1 }), /not an agent id/);
  assert.equal(w.started.length, 0);
});

test('isRecordedGateway confirms only hermes dashboard on the record\'s own port, alive', () => {
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
