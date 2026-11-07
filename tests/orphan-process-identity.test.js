// Exact identity -> reap decisions and actual boot batching. All killers, OS queries and record IO are injected.
// The old Linux verifier reads procfs directly: block that IO while watching the new contract fail on old source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { before, after, test } from 'node:test';
import { defaultVerify, planOrphanReap, START_TIME_TOLERANCE_MS } from '../lib/orphan-reap.mjs';
import { entriesOwnedElsewhere } from '../lib/owned-processes.mjs';
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

test('boot reap batches ten recorded PIDs and the owner into one asynchronous Windows query, with an injected killer', async t => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ ...base, id: `entry-${index}`, pid: 100 + index, launcher: 'C:/fixture/launcher' }));
  for (const entry of entries) delete entry.startToken;
  const calls = [], killed = [], messages = [], writes = [];
  let ownerAlive = false;
  class InjectedIdentity extends ProcessIdentityProbe {
    constructor() {
      super({ platform: 'win32', readFile: noIO, state: noIO, runSync: noIO,
        run: (command, args, options, done) => {
          calls.push({ command, args: [...args] });
          const rows = entries.map(entry => ({ pid: entry.pid, created: new Date(at).toISOString(), cmd: entry.launcher }));
          if (ownerAlive) rows.push({ pid: 17, created: null, cmd: null }); // legacy owner PID, no stored birth/token
          done(null, JSON.stringify(rows), '');
        } });
    }
  }
  const source = originalRead(new URL('../bin/aify-env.mjs', import.meta.url), 'utf8');
  const body = source.match(/^async function reapLeftovers\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(body, 'the exact boot recovery function was found; the daemon is never imported');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const run = new AsyncFunction('readOwned', 'OWNED_FILE', 'ProcessIdentityProbe', 'planOrphanReap', 'defaultIsAlive',
    'defaultVerify', 'killTree', 'process', 'chr10', 'clearOwned', 'entriesOwnedElsewhere', body + '\nreturn reapLeftovers();');
  const execute = () => run(() => entries, 'fixture-only-owned-file', InjectedIdentity, planOrphanReap, pid => pid !== 17 || ownerAlive,
    (entry, options) => defaultVerify(entry, { platform: 'win32', run: noIO, startedAtOf: noIO, ...options }),
    async pid => { killed.push(pid); return true; }, { stderr: { write: text => messages.push(text) } }, '\n',
    (file, options) => writes.push({ file, options }), entriesOwnedElsewhere);
  await execute();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  const wanted = [...calls[0].args.at(-1).matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual(new Set(wanted), new Set([...entries.map(entry => entry.pid), 17]));
  assert.deepEqual(killed, entries.map(entry => entry.pid));
  assert.equal(writes.length, 1); assert.equal(messages.length, entries.length);
  await t.test('a live legacy PID-only owner still protects its records without a new owner identity or kill permission', async () => {
    ownerAlive = true; calls.length = 0; killed.length = 0; messages.length = 0; writes.length = 0;
    await execute();
    assert.equal(calls.length, 1, 'still one asynchronous observation batch');
    assert.deepEqual({ killed, retained: writes[0]?.options.keep }, { killed: [], retained: entries },
      'the conservative legacy owner guard still prevents both kill and record loss');
  });
});
