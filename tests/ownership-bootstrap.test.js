// New #17 producer/wiring boundaries, not another test of JSON or child token validation.
// All processes are fixture EventEmitters; these tests never import/run the daemon entry or observe native PIDs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
import { createOwnershipRecovery } from '../lib/ownership-bootstrap.mjs';
import { Runner } from '../lib/runner.mjs';
import { PosixProcessGroup } from '../lib/posix-process-group.mjs';
import { ServiceLaunchPolicy, LaunchRootRefusal } from '../lib/service-launch-policy.mjs';
import { RecoveryPending } from '../lib/start-admission-refusal.mjs';
new ProcessEffectTripwire();
const { token } = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
const SELF = 424200, OWNER = { ...token, pid: SELF, startTicks: '123' };
const never = () => { throw Error('unexpected native boundary'); };

function file(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-bootstrap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return path.join(home, 'owned.json');
}
function childFixture() {
  const child = new EventEmitter();
  Object.assign(child, { pid: token.pid, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} } });
  return child;
}

test('live-owner bootstrap captures only itself and the actual Runner spawn publishes separate owner/child/group evidence', async t => {
  // Catches disconnected producer fields: recovery cannot validate data no real spawn writes.
  const ownedFile = file(t), probes = [], captures = [], spawnOptions = [];
  const identity = { probe: async pids => { probes.push(pids); return new Map([[SELF, { alive: true, platform: 'linux', startToken: OWNER }]]); } };
  const boot = await createOwnershipRecovery({ file: ownedFile, identity, platform: 'linux', selfPid: SELF, parentPid: SELF - 1, recover: false, report: () => {} });
  const child = childFixture();
  let groupPresent = true;
  const runner = new Runner({ platform: 'linux', ownedRecord: boot.record, startGate: () => boot.recovery.admitStart(),
    openTerminal: null, loadCheckpoint: null, processIdentity: { captureChild: actual => { captures.push(actual); return token; } },
    makeProcessGroup: parts => new PosixProcessGroup({ ...parts, selfPid: SELF, parentPid: SELF - 1,
      signal: () => { if (!groupPresent) throw Object.assign(Error('gone'), { code: 'ESRCH' }); } }),
    spawnProcess: (_command, _args, options) => { spawnOptions.push(options); return spawnedPipe(child); }, isAlive: never, killTree: never });
  const handle = await runner.start({ service: 'fixture', command: 'fixture', launcher: '/fixture/launcher', env: {}, fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"\n' });
  const row = boot.record.load().entries[0];
  assert.deepEqual(probes, [[SELF]], 'no recovered PID was captured as an owner');
  assert.deepEqual(captures, [child]);
  assert.deepEqual(row.ownerIdentity, OWNER);
  assert.deepEqual(row.startToken, token);
  assert.equal(row.owner, SELF);
  assert.equal(row.id, handle.id);
  assert.deepEqual(row.groupScope, { kind: 'posix-process-group', pgid: child.pid });
  assert.equal(spawnOptions[0].detached, true);
  groupPresent = false;
  child.emit('exit', 0, null); child.emit('close', 0, null);
  assert.deepEqual(boot.record.load().entries, []);
});

test('a failed owning capture stays tokenless and does not scan an old record PID to repair it', async t => {
  // Catches the forbidden backfill shortcut; old #22 coverage concerned the child, not the new owner producer.
  const ownedFile = file(t), probes = [], logs = [];
  fs.writeFileSync(ownedFile, JSON.stringify([{ id: 'legacy', pid: 424230, owner: 424231 }]));
  const boot = await createOwnershipRecovery({ file: ownedFile, platform: 'linux', selfPid: SELF, parentPid: SELF - 1, recover: false,
    identity: { probe: async pids => { probes.push(pids); return new Map([[SELF, { alive: null }]]); } }, report: line => logs.push(line) });
  const started = boot.record.started({ id: 'new', pid: token.pid, launcher: '/fixture/launcher' });
  assert.equal(started.ok, true);
  assert.equal(Object.hasOwn(started.entry, 'ownerIdentity'), false);
  assert.equal(boot.ownerIdentity, null);
  assert.deepEqual(probes, [[SELF]]);
  assert.ok(logs.some(line => line.includes('owner birth could not be captured')));
});

test('dedicated recovery:none admits starts without reading or reaping a prior instance record', async t => {
  // Catches wiring a closed startup gate into dedicated instances whose listen branch deliberately skips reap.
  const ownedFile = file(t);
  const boot = await createOwnershipRecovery({ file: ownedFile, platform: 'linux', selfPid: SELF, recover: false,
    identity: { probe: async pids => { assert.deepEqual(pids, [SELF]); return new Map([[SELF, { alive: true, platform: 'linux', startToken: OWNER }]]); } }, report: () => {} });
  // A malformed file appearing after validated single-use context does not cause an unrequested recovery read.
  fs.writeFileSync(ownedFile, '{ not a recovery input');
  await assert.doesNotReject(boot.recovery.admitStart(), 'the validated dedicated recovery:none policy must not wait for a skipped reap trigger');
  assert.equal((await boot.recovery.recover()).ready, true);
  assert.equal(fs.readFileSync(ownedFile, 'utf8'), '{ not a recovery input');
});

test('the host-wide start gate runs before the final service-root check, not after it', async () => {
  // Catches a new await reopening #15's revoked-grant hole between final admission and spawn.
  let open, entered, roots = ['C:/work'], spawns = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { open = resolve; });
  const runner = new Runner({ ownedFile: null, platform: 'win32', openTerminal: null, loadCheckpoint: null,
    startGate: () => { entered(); return gate; }, spawnProcess: () => { spawns++; return spawnedPipe(childFixture()); }, isAlive: never, killTree: never });
  const policy = new ServiceLaunchPolicy({ roots: () => roots, windows: true, cwd: () => 'C:/work' });
  const pending = policy.start(runner, { service: 'fixture', command: 'fixture', cwd: 'C:/work', env: {}, fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"\n' });
  const enteredBeforeCompletion = await Promise.race([waiting.then(() => true), pending.then(() => false, () => false)]);
  assert.equal(enteredBeforeCompletion, true, 'the actual host-wide gate must be reached before completing a start');
  roots = [];
  open();
  await assert.rejects(pending, LaunchRootRefusal);
  assert.equal(spawns, 0);
});

test('ordinary boot admission is closed until the actual recovery trigger completes', async t => {
  // Catches raw start during listen-callback boot, before the non-dedicated reap trigger runs.
  const boot = await createOwnershipRecovery({ file: file(t), platform: 'linux', selfPid: SELF,
    identity: { probe: async pids => new Map(pids.map(pid => [pid, { alive: true, platform: 'linux', startToken: OWNER }])) }, report: () => {} });
  await assert.rejects(boot.recovery.admitStart(), RecoveryPending);
  assert.equal((await boot.recovery.recover()).ready, true);
  await boot.recovery.admitStart();
});

test('late owned close and shutdown retirement cannot erase a changed owner/birth row', async t => {
  // Catches production accidentally retaining the old id-only recordStopped/keep-array shutdown path.
  const ownedFile = file(t), child = childFixture();
  const boot = await createOwnershipRecovery({ file: ownedFile, platform: 'win32', selfPid: SELF, recover: false,
    identity: { probe: async () => new Map([[SELF, { alive: true, createdAtUs: 1700000000000000 }]]) }, report: () => {} });
  const runner = new Runner({ platform: 'win32', ownedRecord: boot.record, startGate: () => boot.recovery.admitStart(),
    openTerminal: null, loadCheckpoint: null, processIdentity: { captureChild: () => null }, spawnProcess: () => spawnedPipe(child), isAlive: never, killTree: never });
  await runner.start({ service: 'fixture', command: 'fixture', env: {}, fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"\n' });
  const original = boot.record.load().entries[0];
  const changed = { ...original, owner: SELF + 1, ownerIdentity: { ...original.ownerIdentity, pid: SELF + 1 } };
  fs.writeFileSync(ownedFile, JSON.stringify([changed]));
  child.emit('exit', 0, null); child.emit('close', 0, null);
  runner.retireEndedRecords();
  assert.deepEqual(boot.record.load().entries, [changed]);
});
