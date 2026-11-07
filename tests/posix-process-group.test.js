// New contract: an owned POSIX group, not a dead root PID, proves cleanup. Existing kill-tree tests prove only attempts.
// Legacy false->dead verification is a separate unchanged-behavior control required by the #13 approval.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { stopAndVerify } from '../lib/verified-stop.mjs';
import { RunnerStop } from '../lib/runner-stop.mjs';
import { Runner } from '../lib/runner.mjs';
import { STOP_EXIT_WAIT_MS } from '../lib/kill-tree.mjs';
import { createReaper } from '../lib/reaper.mjs';
import { endOwnedChildTree, heldKill } from 'aify-env/plugin-ports';
import { killTree as providerEnd, runChild } from '../lib/plugins/aify-dashboard/provider-child.mjs';

// Every decision/mutant test in this process has a last-line tripwire, even if an injection is accidentally bypassed.
new ProcessEffectTripwire();
const api = await import('../lib/posix-process-group.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const Group = () => { assert.equal(typeof api.PosixProcessGroup, 'function', 'core exports owned POSIX group custody'); return api.PosixProcessGroup; };

class GroupFixture {
  time = 0; waits = 0; state = 'present'; signals = []; probes = []; onSignal = () => {};
  constructor({ termEnds = false, killEnds = true, child = null, detached = true, defer, now } = {}) {
    this.child = child ?? Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null });
    this.group = new (Group())({ child: this.child, detached, platform: 'linux', selfPid: 123, parentPid: 122, defer,
      now: now ?? (() => this.time), wait: async ms => {
        if (!Number.isFinite(ms) || ms <= 0 || ++this.waits > 1000) throw Error('injected test clock requires bounded positive progress');
        this.time += ms;
        if (this.time > 10000) throw Error('injected test clock bound exceeded');
      },
      signal: (target, signal) => {
        assert.equal(target, -this.child.pid, 'effects address only this fake owned group');
        if (signal === 0) {
          this.probes.push(target);
          if (this.state === 'gone') throw Object.assign(Error('gone'), { code: 'ESRCH' });
          if (this.state !== 'present') throw Object.assign(Error(this.state), { code: this.state });
          return;
        }
        this.signals.push(signal);
        if ((signal === 'SIGTERM' && termEnds) || (signal === 'SIGKILL' && killEnds)) this.state = 'gone';
        this.onSignal(signal);
      } });
  }
  end(options = {}) { return api.endPosixGroup(this.group, { timeoutMs: 20, ...options }); }
}

async function assertEnded(promise) {
  const error = await promise.then(() => null, error => error);
  assert.equal(error, null, error?.message || 'group cleanup must be confirmed');
}

test('a TERM-compliant owned group ends only after its ESRCH observation', async () => {
  const f = new GroupFixture({ termEnds: true });
  await assertEnded(f.end());
  assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(f.group.observe(), 'gone'); assert.ok(f.probes.length >= 2);
});
test('a TERM-ignoring group receives one KILL within the same bounded deadline', async () => {
  const f = new GroupFixture(); await assertEnded(f.end());
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.group.observe(), 'gone'); assert.ok(f.time <= 20);
  const probes = f.probes.length; f.state = 'present'; // A different group may now reuse that numeric id.
  await assertEnded(f.end()); assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL'], 'proven absence retires the numeric group identity');
  assert.equal(f.probes.length, probes, 'retired custody never observes a reused numeric group');
});
test('a provider force-end sends KILL directly but still requires ESRCH', async () => {
  const f = new GroupFixture(); await assertEnded(f.end({ force: true }));
  assert.deepEqual(f.signals, ['SIGKILL']); assert.equal(f.group.observe(), 'gone');
});
test('an omitted group budget uses the existing shared stop-exit default', async () => {
  assert.equal(STOP_EXIT_WAIT_MS, 3000);
  const f = new GroupFixture({ killEnds: false });
  const error = await api.endPosixGroup(f.group).then(() => assert.fail('present group must reject'), error => error);
  assert.equal(f.time, STOP_EXIT_WAIT_MS); assert.equal(f.group.refusal(error).groupCleanup.state, 'present');
});
test('a still-present group rejects and carries a typed refusal, never a stopped certificate', async () => {
  const f = new GroupFixture({ killEnds: false });
  const error = await f.end().then(() => assert.fail('present group must reject'), error => error);
  const refused = f.group.refusal(error);
  assert.equal(refused.stopped, false); assert.equal(refused.groupCleanup.kind, 'owned-posix-group');
  assert.equal(refused.groupCleanup.state, 'present'); assert.equal(api.isPosixGroupRefusal(refused), true);
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.ok(f.time <= 20);
});
for (const code of ['EPERM', 'EIO']) test(`${code} is group-unknown and authorizes no signal`, async () => {
  const f = new GroupFixture(); f.state = code;
  const error = await f.end().then(() => assert.fail('failed observation must reject'), error => error);
  assert.equal(f.group.refusal(error).groupCleanup.state, 'unknown'); assert.deepEqual(f.signals, []);
});
test('a failed clock during grace cannot authorize KILL', async () => {
  let reads = 0;
  const f = new GroupFixture({ now: () => ++reads <= 2 ? 0 : NaN });
  const error = await f.end().then(() => null, error => error);
  assert.deepEqual({ rejected: error !== null, state: f.group.refusal(error).groupCleanup.state, signals: f.signals },
    { rejected: true, state: 'unknown', signals: ['SIGTERM'] });
});
for (const timeoutMs of [NaN, Infinity, -1]) test(`invalid stop budget ${timeoutMs} grants no termination signal`, async () => {
  const f = new GroupFixture();
  const error = await f.end({ timeoutMs }).then(() => null, error => error);
  assert.deepEqual({ rejected: error !== null, state: f.group.refusal(error).groupCleanup.state, signals: f.signals },
    { rejected: true, state: 'unknown', signals: [] });
});
test('a group already absent is confirmed without a termination signal', async () => {
  const f = new GroupFixture(); f.state = 'gone'; await assertEnded(f.end()); assert.deepEqual(f.signals, []);
});
test('a child whose exit was seen before the attempt grants no new group kill', async () => {
  const f = new GroupFixture(); f.child.emit('exit', 0, null);
  await assert.rejects(f.end(), /execution-unknown/); assert.deepEqual(f.signals, []);
});
test('a pending exit callback runs before group authority is used', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null });
  const f = new GroupFixture({ child, defer: async () => { child.emit('exit', 0, null); } });
  await assert.rejects(f.end(), /execution-unknown/); assert.deepEqual(f.signals, []);
});
test('one concurrent group end shares one attempt and one TERM', async () => {
  const f = new GroupFixture({ termEnds: true });
  const first = f.end(), second = f.end();
  await Promise.all([first, second]);
  assert.equal(first === second, true, 'concurrent ends share the same promise');
  assert.deepEqual(f.signals, ['SIGTERM']);
});
test('missing detached ownership cannot turn an arbitrary PID into a process group', async () => {
  const f = new GroupFixture({ detached: false });
  await assert.rejects(f.end(), /execution-unknown/); assert.deepEqual(f.signals, []); assert.deepEqual(f.probes, []);
});
for (const pid of [0, 1, 123, 122, -2, '424242', Number.MAX_SAFE_INTEGER + 1]) test(`unsafe group PID ${pid} reaches no effect port`, async () => {
  const f = new GroupFixture({ child: Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }) });
  await assert.rejects(f.end(), /execution-unknown/); assert.deepEqual(f.signals, []); assert.deepEqual(f.probes, []);
});

// RunnerStop composition is not proved by primitive tests: it must bypass root/close shortcuts for owned groups.
test('RunnerStop keeps group custody when root exit and close arrive during its group attempt', async () => {
  const f = new GroupFixture({ termEnds: true }); let closed = false;
  f.onSignal = () => { f.child.emit('exit', 0, 'SIGTERM'); closed = true; };
  const stop = new RunnerStop({ child: f.child, group: f.group, exit: new Promise(() => {}), ended: () => closed,
    io: { exitWaitMs: 20, isAlive: () => assert.fail('root PID is not group proof'), killTree: () => assert.fail('legacy killer is not group proof') } });
  assert.deepEqual(await stop.run({ requestId: 'same' }), { stopped: true, problem: '' });
  assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(typeof stop.canRelease, 'function'); assert.equal(stop.canRelease(), true);
  await stop.run({ requestId: 'same' }); assert.deepEqual(f.signals, ['SIGTERM']);
});
test('RunnerStop refuses a root already exited while its owned group is present', async () => {
  const f = new GroupFixture(); f.child.emit('exit', 0, null);
  const stop = new RunnerStop({ child: f.child, group: f.group, exit: Promise.resolve(), ended: () => false,
    io: { exitWaitMs: 20, isAlive: () => false, killTree: () => assert.fail('dead root grants no PID kill') } });
  const refused = await stop.run(); assert.equal(refused.stopped, false); assert.equal(api.isPosixGroupRefusal(refused), true);
  assert.deepEqual(f.signals, []); assert.equal(typeof stop.canRelease, 'function'); assert.equal(stop.canRelease(), false);
});

async function fakeRunner(f) {
  const starts = [];
  f.child.kill = () => assert.fail('owned POSIX group never uses the legacy child kill');
  f.child.unref = () => assert.fail('detached jobs remain owned by the runner');
  const runner = new Runner({ platform: 'linux', openTerminal: null, loadCheckpoint: null,
    spawnProcess: (_command, _args, options) => { starts.push(options); queueMicrotask(() => f.child.emit('spawn')); return f.child; },
    makeProcessGroup: ({ child }) => { assert.equal(child, f.child); return f.group; },
    isAlive: () => false, killTree: () => assert.fail('legacy PID kill forbidden'), processIdentity: { captureChild: () => null } });
  const handle = await runner.start({ service: 'fixture', command: '/fixture/launcher', args: [], fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1"\n' });
  return { runner, handle, starts };
}
// These are actual Runner/reaper integrations, not additional copies of the group algorithm tests.
test('piped POSIX Runner detaches without unref and retains a root close until its group ends', async () => {
  const f = new GroupFixture(); const { runner, handle, starts } = await fakeRunner(f);
  assert.equal(starts[0].detached, true);
  let retainedAtClose = false;
  f.onSignal = signal => { if (signal === 'SIGTERM') {
    f.child.emit('exit', 0, 'SIGTERM'); f.child.emit('close', 0, 'SIGTERM');
    retainedAtClose = runner.list().some(row => row.id === handle.id);
  } };
  assert.deepEqual(await runner.stop(handle.id, { requestId: 'owned' }), { stopped: true, problem: '' });
  assert.equal(retainedAtClose, true, 'root close is not tree absence'); assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(runner.list(), []); assert.equal(runner.canStream(handle.id), false);
});
test('a root-dead reaper neither kills nor releases an unresolved owned group', async () => {
  const f = new GroupFixture(); const { runner, handle } = await fakeRunner(f);
  f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
  const reaper = createReaper(runner, { isAlive: () => false });
  const refused = reaper.sweep();
  assert.deepEqual(refused.reaped, []); assert.equal(refused.unknown[0]?.id, handle.id); assert.equal(runner.list().length, 1);
  assert.deepEqual(f.signals, []);
  f.state = 'gone'; assert.deepEqual(reaper.sweep().reaped, [handle.id]); assert.deepEqual(runner.list(), []); assert.deepEqual(f.signals, []);
});
test('Runner refuses a root-dead job whose retained owned group is present', async () => {
  const f = new GroupFixture(); const { runner, handle } = await fakeRunner(f);
  f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
  const answer = await runner.stop(handle.id);
  assert.equal(answer.stopped, false); assert.equal(api.isPosixGroupRefusal(answer), true); assert.equal(runner.list().length, 1);
  assert.deepEqual(f.signals, []);
});

test('the provider default end traverses the released core port and confirms its group', async () => {
  assert.equal(providerEnd, endOwnedChildTree, 'the plugin contains no parallel killer');
  const f = new GroupFixture(); const stop = new AbortController();
  f.child.stderr = new EventEmitter(); f.child.kill = () => assert.fail('group success needs no root fallback');
  f.onSignal = () => { f.child.emit('exit', null, 'SIGKILL'); f.child.emit('close', null, 'SIGKILL'); };
  const pending = runChild({ nodePath: '/fake/node', script: '/fake/client.mjs', cwd: '/fake', env: {},
    platform: 'linux', signal: stop.signal, killWaitMs: 40,
    makeProcessGroup: ({ child }) => { assert.equal(child, f.child); return f.group; }, start: () => f.child });
  f.child.emit('spawn'); stop.abort();
  const result = await pending;
  assert.equal(result.stopped, true); assert.equal(result.unconfirmed, ''); assert.deepEqual(f.signals, ['SIGKILL']);
});
test('the core Windows port uses only the supplied live-child held handshake', async () => {
  const own = { pid: 424242, kill: () => assert.fail('the held handshake owns ending') }; const calls = [];
  const stillOurs = () => true;
  const ending = endOwnedChildTree(own.pid, { platform: 'win32', own, stillOurs, held: async (pid, options) => { calls.push(pid); assert.equal(options.stillOurs, stillOurs); } });
  assert.deepEqual(calls, [], 'the existing held launch remains microtask-deferred');
  await ending;
  assert.deepEqual(calls, [own.pid]);
});
test('the core Windows port refuses a borrowed child handle before any held call', async () => {
  const calls = [];
  const error = await endOwnedChildTree(424242, { platform: 'win32', own: { pid: 424243 }, stillOurs: () => true,
    held: async pid => { calls.push(pid); } }).then(() => null, error => error);
  assert.deepEqual({ refused: /does not own/.test(error?.message || ''), calls }, { refused: true, calls: [] });
});
test('the core port refuses a group belonging to a different owned child', async () => {
  const f = new GroupFixture();
  await assert.rejects(endOwnedChildTree(f.child.pid + 1, { platform: 'linux', group: f.group }), /matching owned POSIX group/);
  assert.deepEqual(f.probes, []); assert.deepEqual(f.signals, []);
});

for (const pid of [process.pid, process.ppid, 1]) test(`released held port refuses protected PID ${pid} before starting a helper`, async () => {
  const helpers = [];
  await assert.rejects(heldKill(pid, { stillOurs: () => true, powershell: 'C:/fake/powershell.exe',
    start: () => { helpers.push(pid); throw Error('helper must not start'); } }), /protected/);
  assert.deepEqual(helpers, []);
});

test('the released held port needs a live-child witness before any helper starts', async () => {
  const helpers = [];
  const error = await heldKill(424242, { powershell: 'C:/fake/powershell.exe',
    start: () => { helpers.push('started'); throw Error('unexpected helper'); } }).then(() => null, error => error);
  assert.deepEqual({ refused: /no way to know/.test(error?.message || ''), helpers }, { refused: true, helpers: [] });
});

test('legacy Windows or PTY false followed by PID absence is still stopped', async () => {
  const answer = await stopAndVerify({ list: () => [{ id: 'held', pid: 424242 }], stop: async () => ({ stopped: false, problem: 'execution-unknown: root close not seen' }) },
    'held', { isAlive: () => false, settleMs: 0 });
  assert.deepEqual(answer, { stopped: true, problem: '' });
});
for (const state of ['present', 'unknown']) test(`POSIX owned-group ${state} cannot be overwritten by a dead root`, async () => {
  const refused = { stopped: false, problem: `execution-unknown: group ${state}`, groupCleanup: { kind: 'owned-posix-group', pid: 424242, state } };
  const answer = await stopAndVerify({ list: () => [{ id: 'held', pid: 424242 }], stop: async () => refused }, 'held', { isAlive: () => false, settleMs: 0 });
  assert.deepEqual(answer, refused);
});
test('an untyped group-looking problem keeps legacy PID verification', async () => {
  const answer = await stopAndVerify({ list: () => [{ id: 'held', pid: 424242 }], stop: async () => ({ stopped: false, problem: 'execution-unknown: group unknown' }) },
    'held', { isAlive: () => false, settleMs: 0 });
  assert.deepEqual(answer, { stopped: true, problem: '' });
});
