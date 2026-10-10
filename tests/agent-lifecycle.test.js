import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LifecycleJournal, AgentLifecycle } from '../lib/agent-lifecycle.mjs';

const req = (patch = {}) => ({ id: 'r1', agentId: 'a', machineId: 'm', storeId: 's', expectedIncarnation: 1,
  expectedRevision: 1, expectedLifetime: 'old', action: 'stop', requestedBy: 'agent', freshContext: false, ...patch });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'd9-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'journal.json');
  const journal = new LifecycleJournal({ file });
  journal.initialize({ priorBoot: false });
  const calls = [];
  let raw = { current: { lifetime: 'old', pid: 42, handle: 'h', instance: 'i' }, conflict: false, unknown: false };
  let reading = { id: 'a', incarnation: 1, revision: 1, problems: [], agent: { mode: 'managed', harness: 'hermes' } };
  const definitions = { list: async () => ({ storeId: 's', definitions: [reading] }),
    withLifecycleDefinition: async work => work(await definitions.list()),
    admitStart: async (launch, produce) => { calls.push(['locked', launch]); return { produced: await produce() }; },
    applyRequest: async (r) => { calls.push(['remove', r]); return { status: 'done', outcome: '', resultIncarnation: 1, resultRevision: 1 }; } };
  const deps = { journal, definitions, machineId: 'm', identity: () => raw,
    installed: async () => new Set(['hermes']),
    buildSpec: async () => ({ service: 'caller-owned', command: 'injected', args: [] }),
    start: async (spec) => { calls.push(['start', spec]); raw = { current: { lifetime: 'new', pid: 43, handle: 'new-h' }, unknown: false, conflict: false }; },
    stop: async (witness) => { calls.push(['stop', witness]); raw = { current: null, unknown: false, conflict: false }; return true; } };
  return { file, journal, deps, calls, execute: (r) => new AgentLifecycle(deps).execute(r),
    setRaw: (r) => { raw = r; }, setReading: (r) => { reading = r; } };
}
test('durable first result survives lost report and changed intent refuses', async (t) => {
  const f = fixture(t); const result = await f.execute(req());
  assert.equal(result.status, 'done'); assert.equal(f.calls.length, 1);
  const replay = new AgentLifecycle({ ...f.deps, journal: new LifecycleJournal({ file: f.file }) });
  assert.deepEqual(await replay.execute(req()), result); assert.equal(f.calls.length, 1);
  assert.equal((await replay.execute(req({ action: 'kill' }))).outcome, 'idempotency-conflict');
  assert.equal(f.journal.stopFacts().get('s:1:a'), true);
});
test('crashed intent stays unknown and reserves agent across executor instances', async (t) => {
  const f = fixture(t); assert.equal(f.journal.reserve(req()).fresh, true);
  assert.equal((await f.execute(req())).outcome, 'execution-unknown');
  assert.equal((await f.execute(req({ id: 'r2' }))).outcome, 'agent-reserved');
  assert.equal(f.calls.length, 0); assert.equal(f.journal.open().length, 1);
});
test('malformed and unreadable journal fail closed', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.file, '{bad');
  await assert.rejects(() => f.execute(req())); assert.equal(f.calls.length, 0);
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, records: {}, stops: { bad: 'yes' } }));
  assert.throws(() => f.journal.stopFacts());
});
for (const [name, patch, raw] of [
  ['wrong machine', { machineId: 'foreign' }], ['wrong store', { storeId: 'x' }],
  ['wrong incarnation', { expectedIncarnation: 2 }], ['wrong revision', { expectedRevision: 2 }],
  ['moved lifetime', { expectedLifetime: 'other' }],
  ['conflict', {}, { current: null, conflict: true, unknown: false }],
  ['unknown identity', {}, { current: null, conflict: false, unknown: true }],
]) test(`${name} refuses durably before effects`, async (t) => {
  const f = fixture(t); if (raw) f.setRaw(raw); const r = req(patch);
  const result = await f.execute(r); assert.equal(result.status, 'refused'); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.execute(r), result);
});
test('kill verifies death but does not produce stop fact', async (t) => {
  const f = fixture(t); assert.equal((await f.execute(req({ action: 'kill' }))).status, 'done');
  assert.equal(f.journal.stopFacts().size, 0);
});
test('survivor is unknown, not stopped, even after list release', async (t) => {
  const f = fixture(t); f.deps.stop = async (w) => { f.calls.push(['stop', w]); f.setRaw({ current: null }); return false; };
  assert.equal((await f.execute(req())).outcome, 'execution-unknown');
  assert.equal(f.calls[0][1].pid, 42); assert.equal(f.calls.length, 1); assert.equal(f.journal.open().length, 1);
  assert.equal(f.journal.stopFacts().size, 0);
});
for (const action of ['delete', 'spawn']) test(`D9a refuses deferred managed ${action} before effects`, async (t) => {
  const f = fixture(t); const request = req({ action });
  const answer = await f.execute(request);
  assert.equal(answer.status, 'refused'); assert.equal(answer.outcome, 'action-unavailable-in-d9a');
  assert.deepEqual(f.calls, []); assert.equal(f.journal.stopFacts().size, 0);
  assert.deepEqual(await f.execute(request), answer);
});
for (const action of ['start', 'spawn', 'restart']) test(`${action} refuses resident relaunch explicitly`, async (t) => {
  const f = fixture(t); f.setReading({ id: 'a', incarnation: 1, revision: 1, problems: [], agent: { mode: 'resident' } });
  assert.equal((await f.execute(req({ action }))).outcome, 'a resident runs in its own terminal: start it there');
  assert.equal(f.calls.length, 0);
});
for (const action of ['start']) test(`${action} creates under lock and clears stop only on successful lifetime`, async (t) => {
  const f = fixture(t); await f.execute(req());
  assert.equal(f.journal.stopFacts().get('s:1:a'), true);
  assert.equal((await f.execute(req({ id: 'r2', action, expectedLifetime: null }))).resultLifetime, 'new');
  assert.deepEqual(f.calls.map(c => c[0]), ['stop', 'locked', 'start']);
  assert.equal(f.journal.stopFacts().get('s:1:a'), false);
});
test('restart retains stop after failed start and never renews moved revision', async (t) => {
  const f = fixture(t); f.deps.definitions.admitStart = async () => ({ refused: 'revision-moved' });
  const result = await f.execute(req({ action: 'restart' }));
  assert.equal(result.status, 'refused'); assert.equal(f.journal.stopFacts().get('s:1:a'), true);
  assert.deepEqual(f.calls.map(c => c[0]), ['stop']);
});
test('running matched start is no-op without second worker', async (t) => {
  const f = fixture(t); assert.equal((await f.execute(req({ action: 'start' }))).outcome, 'already-running');
  assert.equal(f.calls.length, 0);
});
test('identity is revalidated immediately before destructive effect', async (t) => {
  const f = fixture(t); let reads = 0; f.deps.identity = () => (++reads === 1
    ? { current: { lifetime: 'old', pid: 42, handle: 'h' } } : { current: { lifetime: 'replacement', pid: 42, handle: 'h2' } });
  assert.equal((await f.execute(req())).status, 'refused'); assert.equal(f.calls.length, 0);
});

test('missing raw identity completeness refuses rather than inferring absence', async (t) => {
  const f = fixture(t); f.setRaw({ current: null });
  const result = await f.execute(req({ action: 'start', expectedLifetime: null }));
  assert.equal(result.status, 'refused'); assert.equal(result.outcome, 'identity-unknown');
  assert.equal(f.calls.length, 0);
});
test('bounded identifier constructor is not confused with object prototype', async (t) => {
  const f = fixture(t); assert.equal((await f.execute(req({ id: 'constructor' }))).status, 'done');
});


test('generic locked birth refuses identity becoming incomplete after preparation', async t => {
  const f = fixture(t);
  f.setRaw({ current: null, conflict: false, unknown: false });
  f.deps.buildSpec = async () => { f.setRaw({}); return { command: 'injected' }; };
  const answer = await f.execute(req({ action: 'start', expectedLifetime: null }));
  assert.equal(f.calls.some(call => call[0] === 'start'), false, 'final actual birth must require complete cold identity');
  assert.equal(answer.status, 'refused');
  assert.equal(answer.outcome, 'identity-moved');
});

test('explicit expected absence requires own typed complete raw fields', async t => {
  const f = fixture(t);
  f.setRaw(Object.assign(Object.create({ conflict: false, unknown: false }), { current: null }));
  const answer = await f.execute(req({ expectedLifetime: null }));
  assert.equal(answer.outcome, 'identity-unknown');
  assert.deepEqual(f.calls, []);
  assert.equal(f.journal.stopFacts().size, 0);
});
