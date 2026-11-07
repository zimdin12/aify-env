// One probe owner's Linux raw identity and Windows batch protocol. All OS/process ports are injected; no native PID is read or killed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { ProcessProbeCache, probeProcessesAsync, PROBE_REUSE_MS } from '../lib/process-probe.mjs';
import { verifyLifetime } from '../lib/resident-lifetimes.mjs';
import { HermesGatewayBook, isRecordedGateway } from '../lib/hermes-gateway-book.mjs';
const f = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
const { token, procStat } = f;
const forbidden = () => { throw Error('unexpected OS port'); };

class LinuxFixture {
  reads = [];
  constructor() {
    this.files = new Map([
      ['/proc/sys/kernel/random/boot_id', token.bootId + '\n'],
      [`/proc/${token.pid}/stat`, procStat],
      [`/proc/${token.pid}/cmdline`, `bash\0${f.legacyResident.launcher}\0`],
    ]);
  }
  observer(extra = {}) {
    return new ProcessIdentityProbe({ platform: 'linux', selfPid: 200, run: forbidden, runSync: forbidden, state: forbidden,
      readFile: file => {
        this.reads.push(file);
        if (!this.files.has(file)) throw Object.assign(Error('fixture absent'), { code: 'ENOENT' });
        const value = this.files.get(file);
        if (value instanceof Error) throw value;
        return typeof value === 'function' ? value() : value;
      }, ...extra });
  }
}

for (const method of ['probe', 'probeSync']) {
  test(`ProcessIdentityProbe.${method} observes matching Linux token and raw argv without a subprocess or btime`, async () => {
    const fixture = new LinuxFixture();
    fixture.files.set('/proc/stat', 'btime 1700000000');
    const result = await fixture.observer()[method]([token.pid, token.pid]);
    assert.deepEqual([...result.keys()], [token.pid]);
    assert.deepEqual(result.get(token.pid), { platform: 'linux', alive: true, createdAtUs: null,
      commandLine: `bash\0${f.legacyResident.launcher}\0`, startToken: token });
    assert.deepEqual(fixture.reads, ['/proc/sys/kernel/random/boot_id', `/proc/${token.pid}/stat`, `/proc/${token.pid}/cmdline`, `/proc/${token.pid}/stat`]);
    fixture.files.set('/proc/stat', 'btime 1800000000');
    assert.deepEqual((await fixture.observer()[method]([token.pid])).get(token.pid).startToken, token, 'changed btime does not change identity');
    assert.equal(fixture.reads.includes('/proc/stat'), false);
  });
}

for (const changed of ['boot', 'stat', 'cmdline', 'invalid-stat', 'reused-during-read']) {
  test(`Linux ${changed} uncertainty cannot yield a verified identity`, async () => {
    const fixture = new LinuxFixture();
    assert.equal((await fixture.observer().probe([token.pid])).get(token.pid).alive, true);
    if (changed === 'boot') fixture.files.delete('/proc/sys/kernel/random/boot_id');
    if (changed === 'stat') fixture.files.delete(`/proc/${token.pid}/stat`);
    if (changed === 'cmdline') fixture.files.set(`/proc/${token.pid}/cmdline`, Object.assign(Error('denied'), { code: 'EACCES' }));
    if (changed === 'invalid-stat') fixture.files.set(`/proc/${token.pid}/stat`, 'broken');
    if (changed === 'reused-during-read') {
      let reads = 0;
      fixture.files.set(`/proc/${token.pid}/stat`, () => ++reads === 1 ? procStat : procStat.replace(token.startTicks, '9007199254740992'));
    }
    const answer = (await fixture.observer({ state: () => 'alive' }).probe([token.pid])).get(token.pid);
    assert.equal(answer.alive, null); assert.equal(answer.startToken, null);
  });
}

for (const state of ['gone', 'alive', 'unknown']) {
  test(`an absent proc entry with OS liveness ${state} is gone only for definite absence`, async () => {
    const fixture = new LinuxFixture(); fixture.files.delete(`/proc/${token.pid}/stat`);
    assert.equal((await fixture.observer({ state: () => state }).probe([token.pid])).get(token.pid).alive, state === 'gone' ? false : null);
  });
}

test('a denied stat read remains unknown even when an unrelated existence answer says gone', async () => {
  const fixture = new LinuxFixture();
  fixture.files.set(`/proc/${token.pid}/stat`, Object.assign(Error('denied'), { code: 'EACCES' }));
  assert.equal((await fixture.observer({ state: () => 'gone' }).probe([token.pid])).get(token.pid).alive, null);
});

test('captureChild records only a new child whose proc parent is this owner, never another parent or exited child', () => {
  const fixture = new LinuxFixture(), observer = fixture.observer();
  assert.deepEqual(observer.captureChild({ pid: token.pid, exitCode: null }), token);
  assert.equal(fixture.observer({ selfPid: 201 }).captureChild({ pid: token.pid, exitCode: null }), null);
  fixture.reads.length = 0;
  assert.equal(observer.captureChild({ pid: token.pid, exitCode: 0 }), null);
  assert.equal(observer.captureChild({ pid: 0 }), null);
  assert.deepEqual(fixture.reads, [], 'an ended or invalid child never triggers a proc read');
});

for (const method of ['probe', 'probeSync']) {
  test(`Windows ${method} asks ten unique PIDs in one query and retains sub-millisecond creation precision`, async () => {
    const pids = Array.from({ length: 10 }, (_, index) => 100 + index), calls = [], fileReads = [];
    const stdout = JSON.stringify(pids.map(pid => ({ pid, created: '2026-10-02T15:00:00.1234567Z', cmd: `fixture-${pid}` })));
    const recordCall = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout, stderr: '' }; };
    const observer = new ProcessIdentityProbe({ platform: 'win32', readFile: file => { fileReads.push(file); return forbidden(); }, state: forbidden,
      runSync: recordCall, run: (command, args, options, done) => { recordCall(command, args, options); done(null, stdout, ''); } });
    const answers = await observer[method]([...pids, pids[0], 0, -1, 1.5, '200']);
    assert.equal(calls.length, 1); assert.equal(calls[0].command, 'powershell.exe');
    assert.deepEqual([...calls[0].args.at(-1).matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1])), pids);
    assert.deepEqual([...answers.keys()], pids);
    for (const pid of pids) {
      assert.equal(answers.get(pid).createdAtUs, Date.parse('2026-10-02T15:00:00Z') * 1000 + 123456);
      assert.equal(answers.get(pid).commandLine, `fixture-${pid}`);
    }
    assert.equal(observer.captureChild({ pid: pids[0], exitCode: null }), null, 'Windows launch captures no token or PowerShell');
    assert.equal(calls.length, 1);
    assert.deepEqual(fileReads, [], 'neither a Windows probe nor its launcher capture reads Linux procfs');
  });
}

for (const [name, result] of [
  ['nonzero exit', { status: 1, stdout: '[]' }], ['stderr', { status: 0, stdout: '[]', stderr: 'refused' }],
  ['malformed JSON', { status: 0, stdout: '{' }], ['wrong JSON shape', { status: 0, stdout: '{}' }],
  ['OS error', { status: 0, stdout: '[]', error: Error('unanswered') }],
]) {
  test(`Windows ${name} answers unknown, not an empty successful population`, () => {
    const observer = new ProcessIdentityProbe({ platform: 'win32', readFile: forbidden, state: forbidden, run: forbidden, runSync: () => result });
    assert.equal(observer.probeSync([123]).get(123).alive, null);
  });
}

test('Windows successful empty answer is absence; unsupported platforms and invalid PID lists perform no OS IO', async () => {
  const empty = new ProcessIdentityProbe({ platform: 'win32', readFile: forbidden, state: forbidden, run: forbidden,
    runSync: () => ({ status: 0, stdout: '[]', stderr: '' }) });
  assert.equal(empty.probeSync([123]).get(123).alive, false);
  const observer = new ProcessIdentityProbe({ platform: 'darwin', readFile: forbidden, state: forbidden, run: forbidden, runSync: forbidden });
  assert.equal((await observer.probe([123])).get(123).alive, null);
  assert.equal(observer.probeSync([123]).get(123).alive, null);
  assert.equal((await observer.probe([0, -1, NaN, '123'])).size, 0);
});

// The older cache suite supplies Windows timestamp answers; this pins the new Linux token composition.
test('ProcessProbeCache preserves a Linux token through boot and serving, then unreadability revokes the old proof', async () => {
  const fixture = new LinuxFixture(), identity = fixture.observer();
  let now = 100;
  const cache = new ProcessProbeCache({ identity, state: () => 'alive', nowMs: () => now });
  const record = { ...f.legacyResident, startToken: token };
  const boot = cache.answers([token.pid]).get(token.pid);
  assert.deepEqual(boot.startToken, token);
  assert.equal(verifyLifetime(record, boot).verified, 'yes');
  cache.serve();
  assert.deepEqual(cache.answers([token.pid]).get(token.pid).startToken, token);
  now += PROBE_REUSE_MS + 1;
  fixture.files.delete(`/proc/${token.pid}/stat`);
  await cache.refresh([token.pid]);
  assert.equal(verifyLifetime(record, cache.answers([token.pid]).get(token.pid)).verified, 'unknown', 'signal zero cannot preserve a now-unreadable Linux identity');
});

test('tokenless Linux gateway keeps its prior replacement decision even while the new shared owner can observe Linux', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-gateway-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const killed = [], probes = [], fixture = new LinuxFixture();
  const book = new HermesGatewayBook({ aifyHome: home, isFree: async () => true, probe: async () => null,
    processes: async pids => { probes.push([...pids]); return probeProcessesAsync(pids, { platform: 'linux', run: forbidden }); },
    kill: async pid => { killed.push(pid); } });
  const first = await book.prepare({ agentId: 'fixture-gateway', lifetime: 'old' });
  assert.equal((await book.register({ agentId: 'fixture-gateway', lifetime: 'old', port: first.port, pid: token.pid })).registered, true);
  const recorded = book.records()[0].record;
  fixture.files.set(`/proc/${token.pid}/cmdline`, `bash\0-c\0hermes dashboard --port ${first.port}\0`);
  const observed = (await fixture.observer().probe([token.pid])).get(token.pid);
  assert.equal(observed.alive, true);
  assert.equal(isRecordedGateway(recorded, observed), true, 'control: feeding the new Linux answer would activate the command-only matcher');
  const next = await book.prepare({ agentId: 'fixture-gateway', lifetime: 'new' });
  assert.deepEqual({ port: next.port, live: next.live, killed, records: book.records().map(row => row.record) },
    { port: first.port, live: null, killed: [], records: [{ port: first.port, pid: 0, lifetime: 'new' }] });
  assert.deepEqual(probes, [[token.pid]], 'the unchanged legacy Linux probe stays unanswered and no killer is called');
});
