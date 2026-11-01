// Real private definition lock/store/journal; effects are injected and never reach an OS process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentLifecycle, LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { DefinitionLock } from '../lib/definition-lock.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'lifecycle-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'definitions');
  const store = new DefinitionStore({ dir, lockWaitMs: 0 });
  await store.set('a', { name: 'A', role: 'coder', harness: 'hermes', mode: 'managed', workspace: root,
    model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['hermes']) });
  const listing = await store.list(), reading = listing.definitions[0];
  const file = path.join(root, 'journal.json');
  const journal = new LifecycleJournal({ file });
  journal.initialize({ priorBoot: false });
  let raw = { current: { agentId: 'a', lifetime: 'old', pid: 424242, handle: 'old-h', instance: 'fixture' }, conflict: false, unknown: false };
  const effects = [];
  const deps = { journal, definitions: store, machineId: 'm', identity: () => raw,
    installed: async () => new Set(['hermes']), buildSpec: async () => ({ command: 'fixture' }),
    stop: async () => { effects.push('stop'); raw = { current: null, conflict: false, unknown: false }; return true; },
    start: async () => { effects.push('start'); raw = { current: { agentId: 'a', lifetime: 'new' }, conflict: false, unknown: false }; } };
  const request = (patch = {}) => ({ id: 'r1', agentId: 'a', machineId: 'm', storeId: listing.storeId,
    expectedIncarnation: reading.incarnation, expectedRevision: reading.revision, expectedLifetime: 'old',
    action: 'stop', requestedBy: 'fixture', ...patch });
  const execute = r => new AgentLifecycle(deps).execute(r);
  const hold = new DefinitionLock({ dir, waitMs: 0 });
  t.after(() => hold.release());
  return { root, file, store, journal, deps, request, execute, effects, hold, setRaw: v => { raw = v; } };
}

for (const point of ['listing', 'stop admission', 'start admission', 'already running', 'release admission']) {
  test(`a real definition lock timeout at ${point} refuses durably before effects`, async t => {
    const f = await fixture(t);
    let attempts = 0;
    const list = f.store.list.bind(f.store);
    f.store.list = async () => { attempts++; return list(); };
    let request = f.request();
    if (point === 'listing') await f.hold.take();
    else {
      if (point === 'start admission') {
        f.setRaw({ current: null, conflict: false, unknown: false });
        request = f.request({ action: 'start', expectedLifetime: null });
      }
      if (point === 'already running') request = f.request({ action: 'start' });
      if (point === 'release admission') request = f.request({ action: 'release' });
      // Competing writer acquires after the initial real listing, before the next admission.
      f.store.list = async () => { attempts++; const answer = await list(); await f.hold.take(); return answer; };
    }
    const answer = await f.execute(request);
    assert.deepEqual([answer.status, answer.outcome], ['refused', 'definition-lock-timeout'], 'pre-effect timeout must be a terminal refusal');
    assert.deepEqual(f.effects, [], 'no kill or birth before admission');
    assert.equal(f.journal.open().length, 0, 'pre-effect refusal must free the agent');
    const rows = JSON.parse(fs.readFileSync(f.file)).records;
    assert.equal(rows.r1.phase, 'terminal', 'receipt retained, never deleted');
    const before = attempts;
    // Reopen custody as another executor would, and replay while the lock is STILL held.
    f.deps.journal = new LifecycleJournal({ file: f.file });
    assert.deepEqual(await f.execute(request), answer);
    assert.equal(attempts, before, 'same request replay must not make another lock attempt');
    f.hold.release();
    f.store.list = list;
    const next = await f.execute({ ...request, id: 'r2' });
    assert.equal(next.status, 'done', `control: new request after unlock: ${next.outcome}`);
  });
}

for (const action of ['kill', 'start']) {
  test(`a timeout-coded error thrown inside ${action} keeps ambiguous custody`, async t => {
    const f = await fixture(t);
    const failure = () => { f.effects.push(action); throw Object.assign(new Error('adapter partially acted'), { code: 'DEFINITION_LOCK_TIMEOUT' }); };
    f.deps[action === 'kill' ? 'stop' : 'start'] = failure;
    if (action === 'start') f.setRaw({ current: null, conflict: false, unknown: false });
    const request = f.request({ action, expectedLifetime: action === 'start' ? null : 'old' });
    const answer = await f.execute(request);
    assert.deepEqual(f.effects, [action], 'the effect was entered before it threw');
    assert.deepEqual([answer.status, answer.outcome], ['failed', 'execution-unknown']);
    assert.equal(f.journal.open().length, 1, 'post-effect custody must remain pending');
    assert.deepEqual(await f.execute(request), answer, 'ambiguous request never replays the effect');
    assert.equal((await f.execute({ ...request, id: 'r2' })).outcome, 'agent-reserved');
    assert.deepEqual(f.effects, [action]);
  });
}

for (const action of ['restart', 'delete']) {
  test(`a lock timeout after ${action}'s stop preserves the pending request`, async t => {
    const f = await fixture(t);
    if (action === 'restart') f.deps.buildSpec = async () => { await f.hold.take(); return { command: 'fixture' }; };
    else f.deps.installed = async () => { await f.hold.take(); return new Set(['hermes']); };
    const answer = await f.execute(f.request({ action }));
    assert.deepEqual(f.effects, ['stop']);
    assert.deepEqual([answer.status, answer.outcome], ['failed', 'execution-unknown']);
    assert.equal(f.journal.open().length, 1, 'the earlier stop forbids pre-effect classification');
    assert.equal(f.journal.stopFacts().get(`${f.request().storeId}:1:a`), true);
  });
}

test('invocation terminal creation is an effect even before managed start admission', async t => {
  const f = await fixture(t);
  f.setRaw({ current: null, conflict: false, unknown: false });
  const request = f.request({ action: 'start', expectedLifetime: null });
  const answer = await new AgentLifecycle(f.deps).execute(request, {
    buildSpec: async () => ({ command: 'fixture' }),
    start: async () => { f.effects.push('terminal'); throw Object.assign(new Error('terminal created'), { code: 'DEFINITION_LOCK_TIMEOUT' }); },
  });
  assert.deepEqual(f.effects, ['terminal']);
  assert.deepEqual([answer.status, answer.outcome], ['failed', 'execution-unknown']);
  assert.equal(f.journal.open().length, 1);
});

test('a different error before any effect is not classified as a lock timeout', async t => {
  const f = await fixture(t);
  f.store.list = async () => { throw Object.assign(new Error('definition-lock-timeout'), { code: 'EIO' }); };
  const answer = await f.execute(f.request());
  assert.deepEqual([answer.status, answer.outcome], ['failed', 'execution-unknown']);
  assert.equal(f.journal.open().length, 1);
  assert.deepEqual(f.effects, []);
});
