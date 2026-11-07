// New #17 coverage: real shared observer -> recovery/termination -> record deltas -> real Runner/raw start.
// Existing supersede tests launch the daemon; these cases exercise the maintained body with no native effects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { OwnedProcessRecord } from '../lib/owned-process-record.mjs';
import { RecoveredProcessTermination } from '../lib/recovered-process-termination.mjs';
import { SuccessorRecovery } from '../lib/successor-recovery.mjs';
import { RecoveryPending } from '../lib/start-admission-refusal.mjs';
import { Runner } from '../lib/runner.mjs';
import { handleRequest } from '../lib/protocol.mjs';
import { askIncumbent } from '../lib/incumbent.mjs';
import { ownerReapState } from '../lib/orphan-reap.mjs';
new ProcessEffectTripwire();
const AT = Date.parse('2026-11-07T08:00:00Z'), OWNER = 424240, CHILD = 424241, SELF = 424242;
const birth = pid => ({ version: 1, platform: 'win32', pid, createdAtUs: (pid === OWNER ? AT - 1000 : AT) * 1000 });
const oldRow = (launcher, over = {}) => ({ id: 'original', pid: CHILD, owner: OWNER, service: 'fixture', launcher, startedAt: AT, ...over });

function fixture(t, { surviving = false, rowFields = {}, terminationResult = null, clearOnIncumbent = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'successor-recovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'owned.json'), launcher = path.join(home, 'fixture-launcher');
  const fileText = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1.0"\n';
  fs.writeFileSync(launcher, fileText);
  const original = oldRow(launcher, rowFields);
  fs.writeFileSync(file, JSON.stringify([original]));
  const states = new Map([[OWNER, { createdAtUs: birth(OWNER).createdAtUs, commandLine: 'node aify-env.mjs' }],
    [CHILD, { createdAtUs: AT * 1000, commandLine: launcher }]]);
  const probes = [], heldCalls = [], goCalls = [], logs = [], spawns = [];
  const identity = new ProcessIdentityProbe({ platform: 'win32', runSync: () => { throw Error('no synchronous OS query'); },
    readFile: () => { throw Error('no procfs IO'); }, state: () => { throw Error('no native liveness'); },
    run: (_command, args, _options, done) => {
      const pids = [...args.at(-1).matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1]));
      probes.push(pids);
      const rows = pids.filter(pid => states.has(pid)).map(pid => ({ pid,
        created: states.get(pid).createdAtUs === null ? null : new Date(states.get(pid).createdAtUs / 1000).toISOString(), cmd: states.get(pid).commandLine }));
      done(null, JSON.stringify(rows), '');
    } });
  const record = new OwnedProcessRecord(file, { ownerPid: SELF, ownerIdentity: birth(SELF), report: line => logs.push(line) });
  const held = async (pid, options) => {
    heldCalls.push(pid);
    const state = states.get(pid);
    const createdAt100ns = state ? String((BigInt(state.createdAtUs) + 11644473600000000n) * 10n) : null;
    if (!options.stillOurs({ createdAt100ns })) throw Error('held root birth mismatched');
    goCalls.push(pid);
    if ((pid === OWNER && surviving) || (pid === CHILD && terminationResult === 'failed')) throw Error('fixture cleanup unconfirmed');
    if (pid === OWNER && clearOnIncumbent) fs.writeFileSync(file, '[]');
    states.delete(pid);
  };
  const actualTermination = new RecoveredProcessTermination({ platform: 'win32', identity, held, selfPid: SELF, parentPid: 424239 });
  const unconfirmed = { attempted: true, 'root-only': { state: 'gone', scope: 'incumbent-root' }, untyped: { state: 'gone' } };
  const termination = Object.hasOwn(unconfirmed, terminationResult) ? {
    incumbent: (...args) => actualTermination.incumbent(...args), absentRoot: (...args) => actualTermination.absentRoot(...args),
    child: async () => unconfirmed[terminationResult] } : actualTermination;
  const recovery = new SuccessorRecovery({ record, identity, termination, platform: 'win32', report: line => logs.push(line), selfPid: SELF, parentPid: 424239 });
  const runner = new Runner({ platform: 'win32', ownedRecord: record, startGate: () => recovery.admitStart(),
    openTerminal: null, loadCheckpoint: null, processIdentity: { captureChild: () => null },
    spawnProcess: () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 424250 + spawns.length, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} }, exitCode: null });
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); };
      spawns.push(child);
      return spawnedPipe(child);
    }, isAlive: () => true, killTree: async () => {} });
  t.after(() => { for (const child of spawns) child.kill(); });
  const spec = { command: 'fixture', service: 'fixture', launcher, fileText, cwd: home, env: {} };
  const raw = () => handleRequest({ method: 'POST', path: '/processes', body: { service: 'fixture', launcher, cwd: home } },
    { runner, readFile: name => fs.readFileSync(name, 'utf8'), platform: 'win32' });
  const legacyHolder = () => askIncumbent({ host: 'fixture.invalid', port: 1, fetchImpl: async () => ({ status: 200,
    json: async () => ({ status: 'healthy', version: '0.9.12-dev', pid: OWNER, instance: 'dde9d6d-fixture', processes: [], terminals: { available: false } }) }) });
  return { file, launcher, record, original, states, probes, heldCalls, goCalls, logs, spawns, identity, recovery, runner, spec, raw, legacyHolder };
}

test('joint-switch fixture: dde9d6d health without birth fields exits and the successor admits real Runner and raw starts', async t => {
  // Catches a fence that requires a predecessor-published birth, which would strand the next real switch.
  const f = fixture(t), holder = await f.legacyHolder();
  assert.equal(Object.hasOwn(holder, 'ownerIdentity'), false);
  let captured;
  await assert.doesNotReject(async () => { captured = await f.recovery.supersede(holder); }, 'legacy health must not require a predecessor-published birth');
  assert.deepEqual(captured.birth, birth(OWNER), 'birth came from the shared OS probe, not health or a stored legacy owner');
  assert.deepEqual(f.probes[0], [OWNER]);
  assert.equal((await f.recovery.recover()).ready, true);
  await f.runner.start(f.spec);
  assert.equal((await f.raw()).status, 201);
  assert.equal(f.spawns.length, 2);
  assert.deepEqual(f.goCalls, [OWNER, CHILD]);
  const rows = f.record.load().entries;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.owner === SELF && row.ownerIdentity.pid === SELF));
});

test('the pre-signal snapshot survives a legacy clear during incumbent termination, before boot recovery can read', async t => {
  // A late writer can run before the first post-bind read, not only between two recovery requests.
  const f = fixture(t, { clearOnIncumbent: true, terminationResult: 'failed' });
  await f.recovery.supersede(await f.legacyHolder());
  assert.deepEqual(f.record.load().entries, [], 'the legacy writer actually cleared during termination');
  assert.equal((await f.recovery.recover()).ready, true);
  assert.deepEqual(f.record.load().entries, [f.original]);
  assert.deepEqual(f.goCalls, [OWNER, CHILD]);
});

test('joint-switch inverse: a surviving observed legacy predecessor keeps managed and raw starts refused visibly', async t => {
  // Catches socket/attempt success being mistaken for the original writer's death.
  const f = fixture(t, { surviving: true }), before = fs.readFileSync(f.file);
  await f.recovery.supersede(await f.legacyHolder());
  assert.equal((await f.recovery.recover()).ready, false);
  await assert.rejects(f.runner.start(f.spec), RecoveryPending);
  const response = await f.raw();
  assert.equal(response.status, 503);
  assert.match(response.body.error, /ownership recovery is incomplete/);
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.heldCalls, [OWNER], 'the live legacy PID-only owner protects its child');
  assert.deepEqual(fs.readFileSync(f.file), before, 'no successor write while predecessor can still clear');
  assert.ok(f.logs.some(line => line.includes('operator') && line.includes('owning terminal')));
});

test('an explicit later start observes legacy predecessor death, survives its final clear and preserves another live owner', async t => {
  // Catches an indefinite fence and stale keep-array replacement; no periodic timer is needed.
  const f = fixture(t, { surviving: true });
  await f.recovery.supersede(await f.legacyHolder());
  assert.equal((await f.recovery.recover()).ready, false);
  const other = oldRow(f.launcher, { id: 'unrelated', pid: 424260, owner: 424261 });
  f.states.set(other.pid, { createdAtUs: AT * 1000, commandLine: f.launcher });
  f.states.set(other.owner, { createdAtUs: AT * 1000, commandLine: 'another env --port 0' });
  f.states.delete(OWNER);
  fs.writeFileSync(f.file, JSON.stringify([other])); // legacy predecessor's final clear before successor admission
  assert.equal((await f.raw()).status, 201);
  assert.equal(f.recovery.status().ready, true);
  assert.deepEqual(f.record.load().entries.map(row => row.id), ['unrelated', f.runner.list()[0].id]);
  assert.equal(f.goCalls.includes(other.pid), false);
});

test('failed cleanup erased by a legacy final clear is restored as unresolved, never reported reaped', async t => {
  // Catches dropping a dead-owner entry merely because it was eligible or a kill was attempted.
  const f = fixture(t, { surviving: true, terminationResult: 'failed' });
  await f.recovery.supersede(await f.legacyHolder());
  await f.recovery.recover();
  f.states.delete(OWNER);
  fs.writeFileSync(f.file, '[]');
  await f.recovery.admitStart();
  assert.deepEqual(f.record.load().entries, [f.original]);
  assert.equal(f.recovery.status().unresolvedRecords, 1);
  assert.ok(f.logs.some(line => line.includes('cleanup unconfirmed')));
});

test('a confirmed group/tree is not resurrected when a later owner-death observation releases the fence', async t => {
  // Catches reclassifying an already confirmed tree as an unknown dead-root tree on request-driven retry.
  const f = fixture(t, { surviving: true, rowFields: { ownerIdentity: birth(OWNER) } });
  await f.recovery.supersede(await f.legacyHolder());
  assert.equal((await f.recovery.recover()).ready, false);
  assert.ok(!f.states.has(CHILD), 'healthy composed held adapter really ended the verified child');
  assert.deepEqual(f.record.load().entries, [f.original], 'writes remain fenced');
  f.states.delete(OWNER);
  fs.writeFileSync(f.file, JSON.stringify([f.original])); // a late predecessor rewrote an old row
  await f.recovery.admitStart();
  assert.deepEqual(f.record.load().entries, []);
  assert.equal(f.recovery.status().unresolvedRecords, 0, 'confirmed scope cannot become unresolved again on the later request');
  assert.equal(f.heldCalls.filter(pid => pid === CHILD).length, 1, 'no second kill after confirmed cleanup');
});

for (const [name, ownerIdentity] of [
  ['mismatching stored owner birth', { ...birth(OWNER), createdAtUs: birth(OWNER).createdAtUs + 1000 }],
  ['malformed stored owner birth', { pid: OWNER }],
]) {
  test(`the displaced-owner exception refuses ${name}`, async t => {
    const f = fixture(t, { surviving: true, rowFields: { ownerIdentity } });
    await f.recovery.supersede(await f.legacyHolder());
    // The new stored owner remains live after the displaced PID's original birth has ended.
    if (ownerIdentity.createdAtUs) f.states.get(OWNER).createdAtUs = ownerIdentity.createdAtUs;
    await f.recovery.recover();
    assert.deepEqual(f.heldCalls, [OWNER]);
    assert.deepEqual(f.record.load().entries, [f.original]);
    const observed = await f.identity.probe([OWNER]);
    assert.equal(ownerReapState(f.original, { observed, displaced: birth(OWNER), platform: 'win32' }),
      ownerIdentity.createdAtUs ? 'protected' : 'unknown');
  });
}

test('an unanswered initial incumbent birth probe refuses takeover before any signal and diagnoses the bounded hold', async t => {
  // Catches granting takeover from health shape alone after a failed OS observation.
  const f = fixture(t), before = fs.readFileSync(f.file);
  f.states.get(OWNER).createdAtUs = null;
  await assert.rejects(f.recovery.supersede(await f.legacyHolder()), RecoveryPending);
  assert.deepEqual(f.heldCalls, []);
  assert.equal(f.probes.length, 1, 'one bounded probe, not a new retry timer');
  assert.deepEqual(fs.readFileSync(f.file), before);
  await assert.rejects(f.runner.start(f.spec), RecoveryPending);
  assert.ok(f.logs.some(line => line.includes('could not be captured') && line.includes('No new')));
});

for (const groupPresent of [true, false, null]) {
  test(groupPresent === null ? 'an unanswered root cannot authorize even a positive-absence group probe'
    : `dead-root recorded group ${groupPresent ? 'survives durably without signal' : 'retires only on positive absence'}`, async t => {
    // Closes the13->17 persistence seam, not only the pure termination decision.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-root-recovery-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const { token } = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
    const file = path.join(home, 'owned.json'), signals = [], logs = [];
    const record = new OwnedProcessRecord(file, { ownerPid: 200, ownerIdentity: { ...token, pid: 200, startTicks: '1' }, report: line => logs.push(line) });
    const written = record.started({ id: 'crashed-root', pid: token.pid, launcher: '/fixture/launcher', startToken: token,
      groupScope: { kind: 'posix-process-group', pgid: token.pid } }).entry;
    const identity = new ProcessIdentityProbe({ platform: 'linux', state: () => 'gone', readFile: name => {
      if (name.endsWith('boot_id')) return token.bootId;
      if (groupPresent === null && name.includes(`/${token.pid}/`)) throw Object.assign(Error('denied'), { code: 'EACCES' });
      throw Object.assign(Error('absent'), { code: 'ENOENT' });
    } });
    const termination = new RecoveredProcessTermination({ platform: 'linux', identity, selfPid: SELF, parentPid: SELF - 1,
      signal: (pid, signal) => { signals.push([pid, signal]); if (!groupPresent) throw Object.assign(Error('gone'), { code: 'ESRCH' }); } });
    const recovery = new SuccessorRecovery({ record, identity, termination, platform: 'linux', selfPid: SELF, parentPid: SELF - 1, report: line => logs.push(line) });
    assert.equal((await recovery.recover()).ready, true);
    await recovery.admitStart();
    assert.deepEqual(record.load().entries, groupPresent !== false ? [written] : []);
    assert.deepEqual(signals, groupPresent === null ? [] : [[-token.pid, 0]]);
    assert.equal(recovery.status().unresolvedRecords, groupPresent !== false ? 1 : 0);
    if (groupPresent) assert.ok(logs.some(line => line.includes('unverified group')));
  });
}

for (const kind of ['root-only', 'untyped']) {
  test(`a ${kind} gone answer cannot certify a recorded tree`, async t => {
    // Whole-tree custody cannot be retired by a different scope or a missing scope field.
    const f = fixture(t, { terminationResult: kind });
    f.states.delete(OWNER);
    assert.equal((await f.recovery.recover()).ready, true);
    assert.deepEqual(f.record.load().entries, [f.original]);
    assert.equal(f.recovery.status().unresolvedRecords, 1);
  });
}

test('a legacy attempted-only killer answer cannot remove a record', async t => {
  // Catches accidentally carrying killTree's boolean success into the new death-confirmation contract.
  const f = fixture(t, { terminationResult: 'attempted' });
  f.states.delete(OWNER);
  assert.equal((await f.recovery.recover()).ready, true);
  assert.deepEqual(f.record.load().entries, [f.original]);
  assert.equal(f.recovery.status().unresolvedRecords, 1);
});
