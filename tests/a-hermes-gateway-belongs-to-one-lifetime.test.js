// An agent's hermes gateway belongs to one lifetime: that lifetime gets it back live, a newer one gets its port after
// the old gateway is ended, and nothing is killed that the OS has not confirmed is that gateway (0.9.10: the comms
// bridge's markers and kill-prior moved here). The launcher starts gateways; here a test plays the launcher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import { HermesGatewayBook, NOT_ENDED, isRecordedGateway, portIsFree, somethingAnswers } from '../lib/hermes-gateway-book.mjs';
import { hashedPort } from '../lib/hermes-gateway-ports.mjs';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const line = (port) => `C:\\hermes\\hermes.exe dashboard --port ${port} --host 127.0.0.1 --no-open --skip-build`;

/** A book over a temp home, with a fake gateway world: what is live, what the OS says, what was killed. */
function world(t, { commandLine = line, killAnswer = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-gw-book-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const live = new Map(); // port -> pid
  const hung = new Set(); // ports whose gateway runs but answers no probe
  const killed = [];
  let nextPid = 5000;
  const book = new HermesGatewayBook({
    aifyHome: home,
    isFree: async (port) => !live.has(port),
    probe: async ({ port }) => (live.has(port) && !hung.has(port) ? { port, token: `t${live.get(port)}`, wsUrl: `ws://127.0.0.1:${port}/api/ws?token=t${live.get(port)}` } : null),
    processes: async (pids) => new Map(pids.map((pid) => {
      const port = [...live].find(([, p]) => p === pid)?.[0];
      return [pid, port === undefined ? { alive: false } : { alive: true, commandLine: commandLine(port) }];
    })),
    // killAnswer set: the kill leaves the process running and answers that (killTree's true is an attempt, not an end).
    kill: async (pid) => { killed.push(pid); if (killAnswer !== null) return killAnswer; for (const [port, p] of live) if (p === pid) live.delete(port); return true; },
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
  return { home, book, live, hung, killed, launch };
}

test('THE SAME LIFETIME GETS ITS LIVE GATEWAY BACK and starts nothing; the delivery loop finds it', async (t) => {
  const w = world(t);
  const first = await w.launch('pc-manager', L1);
  assert.equal(first.port, hashedPort('pc-manager'));
  assert.equal(first.started, 5000);
  const again = await w.launch('pc-manager', L1);
  assert.equal(again.started, null, 'a live gateway is reused');
  assert.equal(again.live.port, first.port);
  assert.deepEqual(w.book.records().map(({ record }) => record.pid), [5000], 'the record keeps the running pid');
});

test('A NEWER LIFETIME ENDS THE CONFIRMED OLD GATEWAY and gets the same port', async (t) => {
  const w = world(t);
  const first = await w.launch('pc-manager', L1);
  const second = await w.launch('pc-manager', L2);
  assert.deepEqual(w.killed, [5000], "the old lifetime's gateway was ended");
  assert.equal(second.port, first.port, 'the port is kept');
  assert.deepEqual(w.book.records().map(({ record }) => [record.lifetime, record.pid]), [[L2, 5001]], 'the old lifetime owns nothing now');
});

test('AN UNCONFIRMED PROCESS IS NEVER KILLED: another program on that pid, or a gateway on another port', async (t) => {
  for (const commandLine of [() => 'C:\\Program Files\\editor\\editor.exe --serve', () => line(1234)]) {
    const w = world(t, { commandLine });
    const first = await w.launch('pc-manager', L1);
    const second = await w.launch('pc-manager', L2);
    assert.deepEqual(w.killed, [], commandLine(0));
    // What it declined to kill still listens there, so the new gateway starts elsewhere (review of 85cbd1a).
    assert.notEqual(second.port, first.port, `${commandLine(0)}: handed the occupied port`);
  }
});

test('A GATEWAY THAT COULD NOT BE ENDED KEEPS ITS RECORD, and the newer lifetime is refused, not handed its port', async (t) => {
  // Dropping the record forgot the pid of a gateway still running (review of 85cbd1a).
  // The kill answering true with the gateway still running is taskkill exiting 1 (review of e7e0956).
  for (const killAnswer of [false, true]) {
    const w = world(t, { killAnswer });
    await w.launch('pc-manager', L1);
    await assert.rejects(w.book.prepare({ agentId: 'pc-manager', lifetime: L2 }), { code: NOT_ENDED }, `kill answered ${killAnswer}`);
    assert.deepEqual(w.killed, [5000], 'CONTROL: the kill was attempted');
    assert.deepEqual(w.book.records().map(({ record }) => [record.lifetime, record.pid]), [[L1, 5000]]);
  }
});

test("ANOTHER GATEWAY ON THE RECORDED PORT IS NEVER ADOPTED: its token is not this agent's", async (t) => {
  const w = world(t);
  const first = await w.launch('pc-manager', L1);
  w.live.set(first.port, 6000); // the recorded pid is gone, and another hermes dashboard answers on its port
  const again = await w.book.prepare({ agentId: 'pc-manager', lifetime: L1 });
  assert.equal(again.live, null, `adopted pid 6000's token`);
  assert.notEqual(again.port, first.port, 'and the occupied port is not handed out');
  assert.deepEqual(w.killed, [], 'nothing the record does not name is killed');
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

test("THIS LIFETIME'S GATEWAY THAT NO LONGER ANSWERS IS ENDED, not forgotten; a dead one is simply started again", async (t) => {
  // The delivery loop asks again only when it cannot reach its gateway. Rewriting the record as unregistered dropped the
  // pid of a gateway still running, so no later lifetime could end it (review of a76e7da, F2).
  const w = world(t);
  const first = await w.launch('pc-manager', L1);
  w.hung.add(first.port);
  const again = await w.launch('pc-manager', L1);
  assert.deepEqual(w.killed, [5000], 'the running, unanswering gateway was ended');
  assert.equal(again.started, 5001);
  assert.deepEqual(w.book.records().map(({ record }) => record.pid), [5001]);
  w.live.clear();
  const third = await w.launch('pc-manager', L1);
  assert.deepEqual(w.killed, [5000], 'CONTROL: a dead gateway is not killed again');
  assert.equal(third.started, 5002);
  assert.equal(third.port, hashedPort('pc-manager'));
});

test('TWO AGENTS THAT HASH TOGETHER get two ports: a recorded port is held even while its gateway is down', async (t) => {
  const w = world(t);
  const a = await w.launch('comms-senior-dev', L1);
  w.live.clear();
  const b = await w.launch('graph-hermes-tl', L2);
  assert.equal(a.port, 9341);
  assert.equal(b.port, 9342);
});

test('TWO AGENTS THAT HASH TOGETHER AND PREPARE AT ONCE get two ports', async (t) => {
  // Each read the other's record before either wrote: [9341, 9341] (review of 85cbd1a, inherited).
  const w = world(t);
  const ports = await Promise.all(['comms-senior-dev', 'graph-hermes-tl'].map((agentId) => w.book.prepare({ agentId, lifetime: L1 })));
  assert.deepEqual(ports.map(({ port }) => port).sort(), [9341, 9342]);
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
  assert.throws(() => w.book.register({ agentId: '', lifetime: L1, port: 9000, pid: 7 }), /not an agent id/);
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

test('A BINDABLE PORT IS STILL BUSY when something answers it: Windows binds loopback beside a wildcard listener', async () => {
  // Injected rather than opening a wildcard listener (a firewall prompt on Windows) or leaning on Windows bind rules.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const asked = [];
  const answers = (answered) => async (p) => { asked.push(p); return answered; };
  assert.equal(await portIsFree(port, { answers: answers(true) }), false, 'the 8811 case: bindable, but a dashboard answers');
  assert.equal(await portIsFree(port, { answers: answers(false) }), true, 'CONTROL: bindable and silent');
  assert.deepEqual(asked, [port, port]);
});

test('somethingAnswers sees a loopback listener, and silence once it closes', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await somethingAnswers(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await somethingAnswers(port), false);
});
