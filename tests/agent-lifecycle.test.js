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
test('delete ends the matched lifetime first, then removes the definition under the same request id', async (t) => {
  const f = fixture(t); const request = req({ action: 'delete' });
  const answer = await f.execute(request);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['stop', 'remove'], 'never a removal under a running worker');
  assert.deepEqual(f.calls[1][1], { id: 'r1', agentId: 'a', storeId: 's', expectedIncarnation: 1, expectedRevision: 1,
    patch: { remove: true } });
  assert.equal(answer.status, 'done'); assert.equal(answer.outcome, 'delete');
  assert.equal(answer.resultIncarnation, 1); assert.equal(answer.resultRevision, 1);
  assert.equal(f.journal.stopFacts().get('s:1:a'), true);
  assert.deepEqual(await f.execute(request), answer); assert.equal(f.calls.length, 2, 'a replay repeats nothing');
});
test('delete whose worker survives removes nothing and stays unknown', async (t) => {
  const f = fixture(t); f.deps.stop = async () => false;
  assert.equal((await f.execute(req({ action: 'delete' }))).outcome, 'execution-unknown');
  assert.deepEqual(f.calls, []);
});
test('delete refused by the store after its stop says so, and the agent stays stopped', async (t) => {
  const f = fixture(t);
  f.deps.definitions.applyRequest = async () => ({ status: 'refused', outcome: 'changed on the host since you asked' });
  const answer = await f.execute(req({ action: 'delete' }));
  assert.equal(answer.status, 'refused');
  assert.equal(answer.outcome, 'stopped; the definition was not removed: changed on the host since you asked');
  assert.equal(f.journal.stopFacts().get('s:1:a'), true);
});
test('spawn starts the existing definition like start', async (t) => {
  const f = fixture(t); f.setRaw({ current: null, conflict: false, unknown: false });
  const answer = await f.execute(req({ action: 'spawn', expectedLifetime: null }));
  assert.deepEqual(f.calls.map(([kind]) => kind), ['locked', 'start']);
  assert.equal(answer.status, 'done'); assert.equal(answer.outcome, 'spawn'); assert.equal(answer.resultLifetime, 'new');
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
test('delete against the real definition store removes the file once; a replay changes nothing', async (t) => {
  const { DefinitionStore } = await import('../lib/agent-definitions.mjs');
  const f = fixture(t);
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(process.env.TMPDIR, 'd9-defs-')) });
  await store.set('a', { name: 'A', role: 'coder', harness: 'hermes', mode: 'managed', workspace: 'C:/work',
    model: '', effort: '', instructions: '', env: {}, herdrSpace: true }, { installed: new Set(['hermes']) });
  const { storeId, definitions: [held] } = await store.list();
  f.deps.definitions = store;
  const request = req({ action: 'delete', storeId, expectedIncarnation: held.incarnation, expectedRevision: held.revision });
  const answer = await new AgentLifecycle(f.deps).execute(request);
  assert.equal(answer.status, 'done', answer.outcome);
  assert.deepEqual([answer.resultIncarnation, answer.resultRevision], [held.incarnation, held.revision]);
  assert.deepEqual((await store.list()).definitions, []);
  assert.deepEqual(await store.applyRequest({ id: 'r1', agentId: 'a', storeId, expectedIncarnation: held.incarnation,
    expectedRevision: held.revision, patch: { remove: true } }, { installed: new Set(['hermes']) }),
  { status: 'done', outcome: 'already applied', resultIncarnation: held.incarnation, resultRevision: held.revision });
});
