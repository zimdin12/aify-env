// Exercise the real POSIX policy through succession and the durable record, without running a daemon or signalling a PID.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OwnedProcessRecord } from '../lib/owned-process-record.mjs';
import { RecoveredProcessTermination } from '../lib/recovered-process-termination.mjs';
import { SuccessorRecovery } from '../lib/successor-recovery.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';

new ProcessEffectTripwire();
const [PREDECESSOR, CHILD, PEER, PEER_CHILD, SUCCESSOR, NEW_CHILD] = [424240, 424241, 424242, 424243, 424244, 424245];
const token = pid => ({ version: 1, platform: 'linux', pid, bootId: '11111111-1111-4111-8111-111111111111', startTicks: String(pid) });
const launcher = pid => `/fixture/worker-${pid}`;
const observed = pid => ({ alive: true, platform: 'linux', startToken: token(pid), groupId: pid,
  commandLine: ['node', launcher(pid)].join(String.fromCharCode(0)) });
const row = (id, pid) => ({ id, pid, launcher: launcher(pid), service: 'fixture', startedAt: 1,
  startToken: token(pid), groupScope: { kind: 'posix-process-group', pgid: pid } });
const error = code => Object.assign(new Error(code), { code });

for (const afterKill of ['gone', 'unreadable']) test(`POSIX successor: TERM-resistant predecessor group ${afterKill} after escalation`, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'posix-successor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'owned.json');
  const writer = ownerPid => new OwnedProcessRecord(file, { ownerPid, ownerIdentity: token(ownerPid), report() {} });
  const old = writer(PREDECESSOR), peer = writer(PEER), record = writer(SUCCESSOR);
  const original = old.started(row('old', CHILD));
  const protectedRow = peer.started(row('peer', PEER_CHILD));
  assert.ok(original.ok && protectedRow.ok, 'both owning writers stored their exact group rows');

  const processes = new Map([PREDECESSOR, CHILD, PEER, PEER_CHILD].map(pid => [pid, observed(pid)]));
  const identity = { async probe(pids) { return new Map(pids.map(pid => [pid, processes.get(pid) ?? { alive: false }])); } };
  const effects = [];
  const observations = [];
  const recordedDuringRecovery = [];
  let clock = 0, killed = false, groupGone = false;
  const termination = new RecoveredProcessTermination({ identity, platform: 'linux', selfPid: SUCCESSOR, parentPid: 1,
    timeoutMs: 20, now: () => clock, wait: async ms => {
      clock += ms;
      if (killed && afterKill === 'gone') { groupGone = true; processes.delete(CHILD); }
    }, signal(pid, signal) {
      if (signal !== 0) effects.push([pid, signal]);
      if (pid === PREDECESSOR && signal === 'SIGTERM') { processes.delete(PREDECESSOR); return; }
      assert.equal(pid, -CHILD, 'no PID or group outside the recorded predecessor child may be touched');
      recordedDuringRecovery.push(record.load().entries.some(entry => entry.id === 'old'));
      if (signal === 'SIGTERM') return; // The group refuses TERM, including inherited pipes.
      if (signal === 'SIGKILL') { killed = true; return; }
      assert.equal(signal, 0);
      const state = groupGone ? 'ESRCH' : killed && afterKill === 'unreadable' ? 'EPERM' : 'present';
      observations.push(state);
      if (state !== 'present') throw error(state);
    } });
  const recovery = new SuccessorRecovery({ record, identity, termination, platform: 'linux', selfPid: SUCCESSOR, parentPid: 1, report() {} });

  assert.deepEqual(await recovery.supersede({ pid: PREDECESSOR }), {
    birth: token(PREDECESSOR), outcome: { state: 'gone', scope: 'incumbent-root' },
  });
  assert.equal(processes.has(CHILD), true, 'superseding the owner did not reap the child; boot must do it');
  assert.deepEqual(effects, [[PREDECESSOR, 'SIGTERM']]);
  const result = await recovery.recover();
  assert.deepEqual(effects, [[PREDECESSOR, 'SIGTERM'], [-CHILD, 'SIGTERM'], [-CHILD, 'SIGKILL']]);
  assert.ok(recordedDuringRecovery.length > 1 && recordedDuringRecovery.every(Boolean), 'the exact row is held through the final observation');
  assert.deepEqual([observations[0], observations.at(-1)], ['present', afterKill === 'gone' ? 'ESRCH' : 'EPERM']);
  assert.equal(result.ready && result.recorded, true);
  assert.deepEqual(result.confirmedGone, afterKill === 'gone' ? [original.entry] : []);
  assert.deepEqual(record.load().entries, afterKill === 'gone' ? [protectedRow.entry] : [original.entry, protectedRow.entry]);
  assert.equal(processes.has(PEER_CHILD), true);

  if (afterKill === 'gone') {
    const successor = record.started(row('old', NEW_CHILD));
    assert.ok(successor.ok);
    assert.deepEqual(old.retire([original.entry]).unmatched, [original.entry]);
    assert.deepEqual(writer(SUCCESSOR).load().entries, [protectedRow.entry, successor.entry], 'a late predecessor retire cannot remove the replacement');
  }
});
