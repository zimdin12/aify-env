// Exact identity -> reap decisions and real recovery batching. OS effects are injected; record IO uses private fixtures.
// The old Linux verifier reads procfs directly: block that IO while watching the new contract fail on old source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { before, after, test } from 'node:test';
import { defaultVerify, planOrphanReap, START_TIME_TOLERANCE_MS } from '../lib/orphan-reap.mjs';
import os from 'node:os';
import path from 'node:path';
import { OwnedProcessRecord } from '../lib/owned-process-record.mjs';
import { RecoveredProcessTermination } from '../lib/recovered-process-termination.mjs';
import { SuccessorRecovery } from '../lib/successor-recovery.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
const originalRead = fs.readFileSync;
before(() => {
  fs.readFileSync = (file, ...rest) => {
    if (String(file).startsWith('/proc/')) throw Error('native proc observation forbidden in decision tests');
    return originalRead(file, ...rest);
  };
  syncBuiltinESMExports();
});
after(() => { fs.readFileSync = originalRead; syncBuiltinESMExports(); });
const noIO = () => { throw Error('OS IO forbidden in verification'); };
const token = fixture.token, at = Date.parse('2026-10-02T15:00:00Z');
const base = { id: 'synthetic-orphan', pid: token.pid, service: 'fixture', owner: 17,
  launcher: fixture.legacyResident.launcher, startedAt: at, startToken: token };
const linuxAnswer = { platform: 'linux', alive: true, createdAtUs: null, startToken: token, commandLine: `bash\0${base.launcher}\0` };
function decide(entry, answer, platform = 'linux') {
  const killed = [], killer = pid => killed.push(pid);
  const plan = planOrphanReap([entry], { isAlive: () => true, ownerIsAlive: () => false,
    verify: candidate => defaultVerify(candidate, { platform, answer, run: noIO, startedAtOf: noIO }) });
  for (const candidate of plan.reap) killer(candidate.pid);
  return { killed, plan };
}

for (const [name, over, answer] of [
  ['tokenless', { startToken: undefined }, linuxAnswer], ['malformed', { startToken: { ...token, startTicks: 1 } }, linuxAnswer],
  ['another boot', {}, { ...linuxAnswer, startToken: { ...token, bootId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' } }],
  ['another pid', {}, { ...linuxAnswer, startToken: { ...token, pid: token.pid + 1 } }],
  ['another tick', {}, { ...linuxAnswer, startToken: { ...token, startTicks: '9007199254740992' } }],
  ['unreadable identity', {}, { ...linuxAnswer, startToken: null }],
  ['unanswered OS', {}, { ...linuxAnswer, alive: null }],
  ['another launcher', {}, { ...linuxAnswer, commandLine: `bash\0${base.launcher}-old\0` }],
]) {
  test(`reap refuses ${name} with every other identity field matching`, () => {
    assert.deepEqual(decide(base, linuxAnswer).killed, [base.pid], 'control: this same launcher/token can be reaped');
    const refused = decide({ ...base, ...over }, answer);
    assert.deepEqual({ admitted: refused.plan.reap.map(entry => entry.pid), killed: refused.killed }, { admitted: [], killed: [] },
      'unknown/mismatched identity grants neither a reap admission nor a killer call');
  });
}

test('Linux recovery ignores wall-clock startedAt when the owning token and launcher match', () => {
  assert.deepEqual(decide({ ...base, startedAt: at - 86_400_000 }, linuxAnswer).killed, [base.pid]);
  assert.deepEqual(decide({ ...base, startedAt: at + 86_400_000 }, linuxAnswer).killed, [base.pid]);
  assert.deepEqual(decide({ ...base, startedAt: 0 }, linuxAnswer).killed, [base.pid]);
  const timeless = { ...base }; delete timeless.startedAt;
  assert.deepEqual(decide(timeless, linuxAnswer).killed, [base.pid]);
});

for (const [name, createdAtUs, admitted] of [
  ['same millisecond', at * 1000 + 999, true],
  ['tolerance edge', (at + START_TIME_TOLERANCE_MS) * 1000 + 999, true],
  ['outside tolerance', (at + START_TIME_TOLERANCE_MS + 1) * 1000, false],
  ['missing creation', null, false],
]) {
  test(`Windows reap retains its legacy millisecond policy at ${name}`, () => {
    const entry = { ...base }; delete entry.startToken;
    const answer = { alive: true, createdAtUs, commandLine: entry.launcher };
    assert.deepEqual(decide(entry, answer, 'win32').killed, admitted ? [entry.pid] : []);
  });
}

function batchFixture(t, ownerAlive) {
  // Real core body and exact record deltas; independent top-level cases keep either failure from hiding the other.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-batch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'owned.json');
  const entries = Array.from({ length: 10 }, (_, index) => ({ ...base, id: `entry-${index}`, pid: 100 + index, launcher: 'C:/fixture/launcher' }));
  for (const entry of entries) delete entry.startToken;
  const calls = [], killed = [], messages = [];
  const identity = new ProcessIdentityProbe({ platform: 'win32', readFile: noIO, state: noIO, runSync: noIO,
    run: (command, args, options, done) => {
      calls.push({ command, args: [...args] });
      const rows = entries.map(entry => ({ pid: entry.pid, created: new Date(at).toISOString(), cmd: entry.launcher }));
      if (ownerAlive) rows.push({ pid: 17, created: null, cmd: null });
      done(null, JSON.stringify(rows), '');
    } });
  const record = new OwnedProcessRecord(file, { report: noIO });
  const termination = new RecoveredProcessTermination({ platform: 'win32', identity, selfPid: 999, parentPid: 998,
    held: async (pid, { stillOurs }) => {
      const createdAt100ns = String((BigInt(at * 1000) + 11644473600000000n) * 10n);
      assert.equal(stillOurs({ createdAt100ns }), true, 'the actual observed child birth admits the held scope');
      killed.push(pid);
    } });
  fs.writeFileSync(file, JSON.stringify(entries));
  const recovery = new SuccessorRecovery({ record, identity, termination, platform: 'win32', selfPid: 999, parentPid: 998, report: text => messages.push(text) });
  return { entries, calls, killed, messages, record, recovery };
}

test('boot reap batches ten recorded PIDs and the owner into one asynchronous Windows query, with a held-birth-verified injected killer', async t => {
  const f = batchFixture(t, false);
  await f.recovery.recover();
  assert.equal(f.calls.length, 1, 'one asynchronous admission population query, not one per entry');
  assert.equal(f.calls[0].command, 'powershell.exe');
  const wanted = [...f.calls[0].args.at(-1).matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual(new Set(wanted), new Set([...f.entries.map(entry => entry.pid), 17]));
  assert.deepEqual(f.killed, f.entries.map(entry => entry.pid));
  assert.deepEqual(f.record.load().entries, []);
  assert.equal(f.messages.filter(text => text.includes('confirmed reachable-held-tree cleanup')).length, f.entries.length);
});

test('a live legacy PID-only owner still protects its records without a new owner identity or kill permission', async t => {
  const f = batchFixture(t, true);
  await f.recovery.recover();
  assert.equal(f.calls.length, 1, 'still one asynchronous observation batch');
  assert.deepEqual({ killed: f.killed, retained: f.record.load().entries }, { killed: [], retained: f.entries },
    'the conservative legacy owner guard still prevents both kill and record loss');
});
