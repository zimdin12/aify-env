// #17's recovered-root/group authority is distinct from #13's live ChildProcess custody.
// This file covers current proc group membership, bounded escalation and held-root birth admission; no real effects.
// Live and recovered owners exercise endObservedProcessGroup through separate acquisition contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { RecoveredProcessTermination } from '../lib/recovered-process-termination.mjs';
import { heldKill } from '../lib/held-process-tree.mjs';
import { originalBirthState } from '../lib/process-birth.mjs';
new ProcessEffectTripwire();
const { token, procStat } = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
const GONE = () => Object.assign(Error('gone'), { code: 'ESRCH' });
const entry = { id: 'recorded-root', pid: token.pid, owner: 200, service: 'fixture', launcher: '/fixture/launcher', startToken: token,
  groupScope: { kind: 'posix-process-group', pgid: token.pid } };
const statWith = (group, tick = token.startTicks) => procStat.replace(' S 200 1 1 ', ` S 200 ${group} 1 `).replace(token.startTicks, tick);

function fixture({ rootAlive = true, group = 'present', membership = token.pid, ticks = token.startTicks,
  killWorks = true, rootExitsOnTerm = false } = {}) {
  let alive = rootAlive, groupState = group, clock = 0;
  const signals = [], reads = [];
  const identity = new ProcessIdentityProbe({ platform: 'linux', selfPid: 200,
    run: () => { throw Error('no process query'); }, runSync: () => { throw Error('no process query'); },
    state: () => alive ? 'alive' : 'gone', readFile: name => {
      reads.push(name);
      if (name.endsWith('boot_id')) return token.bootId;
      if (!alive) throw Object.assign(Error('absent'), { code: 'ENOENT' });
      if (name.endsWith('/stat')) return statWith(membership, ticks);
      if (name.endsWith('/cmdline')) return `node\0${entry.launcher}\0`;
      throw Error('unexpected fixture path');
    } });
  const signal = (pid, name) => {
    signals.push([pid, name]);
    if (name === 0) {
      if (groupState === 'gone') throw GONE();
      if (groupState === 'unknown') throw Object.assign(Error('denied'), { code: 'EPERM' });
      return;
    }
    if (name === 'SIGTERM' && rootExitsOnTerm) alive = false;
    if (name === 'SIGKILL' && killWorks) groupState = 'gone';
  };
  const termination = new RecoveredProcessTermination({ platform: 'linux', identity, signal, held: () => { throw Error('no held helper'); },
    selfPid: 200, parentPid: 199, timeoutMs: 60, now: () => clock,
    wait: async ms => { assert.ok(ms > 0 && ms <= 10); clock += ms; } });
  return { identity, termination, signals, reads, elapsed: () => clock };
}

test('the optional group observation brackets the same token and keeps the default #22 answer unchanged', async () => {
  // Catches returning an unowned group from the wrong proc field or changing every existing probe consumer.
  const f = fixture();
  const ordinary = (await f.identity.probe([entry.pid])).get(entry.pid);
  assert.equal(Object.hasOwn(ordinary, 'groupId'), false);
  const observed = (await f.identity.probe([entry.pid], { groups: true })).get(entry.pid);
  assert.deepEqual(observed.startToken, token);
  assert.equal(observed.groupId, entry.pid);
});

test('group membership changing between proc reads stays unknown even while birth identity matches', async () => {
  // Catches trusting just the first or final membership sample across the identity bracket.
  let stats = 0;
  const observer = new ProcessIdentityProbe({ platform: 'linux', state: () => 'alive', readFile: name =>
    name.endsWith('boot_id') ? token.bootId : name.endsWith('/stat') ? statWith(++stats === 1 ? entry.pid : entry.pid + 1) : `node\0${entry.launcher}\0` });
  const observed = (await observer.probe([entry.pid], { groups: true })).get(entry.pid);
  assert.deepEqual(observed.startToken, token);
  assert.equal(observed.groupId, null);
});

test('a birth from another OS namespace cannot be declared gone from this platform probe', () => {
  // Catches treating a Windows owner's numeric PID absence inside Linux as permission to reap shared records.
  assert.equal(originalBirthState({ version: 1, platform: 'win32', pid: entry.pid, createdAtUs: 1700000000000000 }, { alive: false }, 'linux'), 'unknown');
});

test('a verified live recorded root/group that ignores TERM escalates once and confirms group absence', async () => {
  // Catches the old reap's attempted TERM boolean instead of #13's escalation/confirmation schedule.
  const f = fixture();
  assert.equal((await f.termination.child(entry)).state, 'gone');
  assert.deepEqual(f.signals.filter(([, name]) => name !== 0), [[-entry.pid, 'SIGTERM'], [-entry.pid, 'SIGKILL']]);
  assert.equal(f.elapsed(), 30, 'one half-budget grace; confirmation finishes immediately after KILL');
});

test('root exit during an already acquired attempt does not strand a surviving group at escalation', async () => {
  // Different from dead-before-acquisition: the real owning root/member was positively observed for this attempt.
  const f = fixture({ rootExitsOnTerm: true });
  assert.equal((await f.termination.child(entry)).state, 'gone');
  assert.deepEqual(f.signals.filter(([, name]) => name !== 0).map(([, name]) => name), ['SIGTERM', 'SIGKILL']);
});

test('a root already dead with a surviving recorded group is unverified and never signalled', async () => {
  // The #13 retained-custody case17 must hold, not turn into a fake live ChildProcess.
  const f = fixture({ rootAlive: false });
  const outcome = await f.termination.child(entry);
  assert.equal(outcome.state, 'unknown');
  assert.match(outcome.problem, /unverified group/);
  assert.deepEqual(f.signals, [[-entry.pid, 0]], 'only an absence probe, never TERM or KILL');
});

test('positive group absence may retire a dead-root group while EPERM must retain it', async () => {
  const absent = fixture({ rootAlive: false, group: 'gone' });
  assert.equal((await absent.termination.child(entry)).state, 'gone');
  const denied = fixture({ rootAlive: false, group: 'unknown' });
  assert.equal((await denied.termination.child(entry)).state, 'unknown');
  assert.deepEqual(denied.signals, [[-entry.pid, 0]]);
});

for (const [name, setup, row] of [
  ['another group membership', { membership: entry.pid + 1 }, entry],
  ['another child birth', { ticks: '9007199254740992' }, entry],
  ['legacy record without group custody', {}, { ...entry, groupScope: undefined }],
  ['malformed group custody', {}, { ...entry, groupScope: { ...entry.groupScope, guessed: true } }],
]) {
  test(`recovered termination refuses ${name} before any group effect`, async () => {
    // Independent input guards; all other fields still satisfy the owning-child record.
    const healthy = fixture();
    assert.equal((await healthy.termination.child(entry)).state, 'gone');
    const f = fixture(setup);
    assert.equal((await f.termination.child(row)).state, 'unknown');
    assert.deepEqual(f.signals, []);
  });
}

for (const pid of [0, 1, 200, 199]) {
  test(`recovered protected PID ${pid} is refused before observation or signal`, async () => {
    // Recovered rows can be malformed; a direct effect adapter must retain its own protected-target guard.
    const probes = [], signals = [];
    const row = { ...entry, pid, startToken: { ...token, pid }, groupScope: { kind: 'posix-process-group', pgid: pid } };
    const identity = { probe: async pids => { probes.push(pids); return new Map([[pid,
      { alive: true, platform: 'linux', startToken: row.startToken, commandLine: ['node', row.launcher, ''].join(String.fromCharCode(0)), groupId: pid }]]); } };
    const termination = new RecoveredProcessTermination({ platform: 'linux', identity, selfPid: 200, parentPid: 199,
      signal: (...args) => signals.push(args) });
    assert.equal((await termination.child(row)).state, 'unknown');
    assert.deepEqual({ probes, signals }, { probes: [], signals: [] });
  });
}

test('an unconfirmed KILL leaves the recorded group unknown within one total budget', async () => {
  const f = fixture({ killWorks: false });
  assert.equal((await f.termination.child(entry)).state, 'unknown');
  assert.equal(f.elapsed(), 60);
  assert.equal(f.signals.filter(([, name]) => name === 'SIGKILL').length, 1);
});

test('an incumbent PID reused before escalation is not signalled again', async () => {
  // Catches a root-only numeric KILL after original birth has positively disappeared.
  let ticks = token.startTicks, clock = 0;
  const calls = [], identity = { probe: async () => new Map([[entry.pid,
    { alive: true, platform: 'linux', startToken: { ...token, startTicks: ticks } }]]) };
  const termination = new RecoveredProcessTermination({ platform: 'linux', identity, selfPid: 200, parentPid: 199,
    signal: (pid, name) => { calls.push([pid, name]); ticks = '9007199254740992'; },
    now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 60 });
  assert.equal((await termination.incumbent(token)).state, 'gone');
  assert.deepEqual(calls, [[entry.pid, 'SIGTERM']]);
});

function helperFixture({ line = 'held 133444736000000000\n', allow = true, timeoutMs = null, silent = false, noCloseAfterGo = false } = {}) {
  const child = new EventEmitter(), inputs = [], killed = [];
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { end: text => { inputs.push(text); if (noCloseAfterGo && text === 'go\n') return;
      queueMicrotask(() => { child.stdout.emit('data', 'done\n'); child.emit('close', 0); }); } },
    kill: signal => { killed.push(signal); queueMicrotask(() => child.emit('close', 1)); } });
  let proof;
  const pending = heldKill(424250, { powershell: 'C:/fixture/powershell.exe', timeoutMs,
    start: () => { if (!silent) queueMicrotask(() => child.stdout.emit('data', line)); return child; },
    stillOurs: held => { proof = held; return allow; } });
  return { pending, inputs, killed, proof: () => proof };
}

test('the held-helper handshake exposes its actual creation ticks before permitting go', async () => {
  // Pins the real shared helper protocol seam used by recovery, not a made-up held callback value.
  const f = helperFixture();
  await f.pending;
  assert.deepEqual(f.proof(), { createdAt100ns: '133444736000000000' });
  assert.deepEqual(f.inputs, ['go\n']);
});

test('an unapproved held root receives no, not go', async () => {
  const f = helperFixture({ allow: false });
  await assert.rejects(f.pending, error => {
    assert.match(error.message, /held root could not be verified, so nothing was killed/);
    assert.doesNotMatch(error.message, /client exited/, 'a birth mismatch or deliberate no-go is not proof of exit');
    return true;
  });
  assert.deepEqual(f.inputs, ['no\n']);
});

test('held-helper timeout after go never writes a second command to ended stdin', async () => {
  // Catches ERR_STREAM_WRITE_AFTER_END while cancelling an already-authorized but hung helper.
  const f = helperFixture({ noCloseAfterGo: true, timeoutMs: 1 });
  let watchdog;
  const outcome = await Promise.race([f.pending.then(() => 'unexpected success', error => error),
    new Promise(resolve => { watchdog = setTimeout(() => resolve('fixture watchdog'), 50); })]);
  clearTimeout(watchdog);
  assert.ok(outcome instanceof Error, 'post-go hang must also settle within the helper budget');
  assert.match(outcome.message, /exceeded its budget/);
  assert.deepEqual(f.inputs, ['go\n']);
  assert.deepEqual(f.killed, ['SIGKILL']);
});

test('a silent held helper times out by cancelling only the newly owned helper and never grants go', async () => {
  const f = helperFixture({ silent: true, timeoutMs: 1 });
  let watchdog;
  const outcome = await Promise.race([f.pending.then(() => 'unexpected success', error => error),
    new Promise(resolve => { watchdog = setTimeout(() => resolve('fixture watchdog'), 50); })]);
  clearTimeout(watchdog);
  assert.ok(outcome instanceof Error, 'the held-helper budget must settle even when no protocol event arrives');
  assert.match(outcome.message, /exceeded its budget/);
  assert.deepEqual(f.inputs, ['no\n']);
  assert.deepEqual(f.killed, ['SIGKILL']);
});
