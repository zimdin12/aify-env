import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { AgentLifecycle, LifecycleJournal } from '../lib/agent-lifecycle.mjs';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'd9-invocation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'definitions');
  const definitions = new DefinitionStore({ dir });
  const agent = { id: 'a', name: 'Fixture', role: 'worker', harness: 'hermes', mode: 'managed',
    workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false };
  await definitions.set('a', agent, { installed: new Set(['hermes']) });
  const listing = await definitions.list();
  const row = listing.definitions[0];
  const request = { id: 'r1', agentId: 'a', machineId: 'm', storeId: listing.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision,
    expectedLifetime: null, action: 'start', requestedBy: 'fixture', freshContext: true };
  const file = path.join(home, 'journal.json');
  const journal = new LifecycleJournal({ file });
  journal.initialize({ priorBoot: false });
  let raw = { current: null, conflict: false, unknown: false };
  const events = [];
  const deps = { journal, definitions, machineId: 'm', installed: async () => new Set(['hermes']),
    identity: () => raw, stop: async () => { throw Error('unexpected stop'); },
    buildSpec: async () => { events.push('default-build'); throw Error('no service adapter'); },
    start: async () => { events.push('default-start'); throw Error('no carrier'); } };
  return { definitions, request, journal, deps, events, lock: path.join(dir, '.lock'),
    execute: (r, ports) => new AgentLifecycle(deps).execute(r, ports),
    setRaw(value) { raw = value; },
    started() { raw = { current: { lifetime: 'new-life', pid: 123, handle: 'h' }, conflict: false, unknown: false }; } };
}
function adapter(f, { attachmentLost = false, repeatBirth = false } = {}) {
  const prepared = Object.freeze({ agentId: 'a', command: 'fixture', terminalId: 't' });
  return {
    async buildSpec(agent, request) {
      assert.equal(agent.mode, 'managed'); assert.equal(agent.harness, 'hermes');
      assert.equal(request, f.request); assert.equal(fs.existsSync(f.lock), false);
      f.events.push('prepare'); return prepared;
    },
    async start(spec, runLocked) {
      assert.equal(spec, prepared, 'plugin must receive the exact prepared object');
      assert.equal(typeof runLocked, 'function', 'host supplies the locked birth capability');
      const produce = () => {
        assert.equal(fs.existsSync(f.lock), true, 'actual DefinitionStore holds the birth lock');
        f.events.push('birth'); f.started(); return { id: 'h', pid: 123 };
      };
      const admitted = await runLocked(produce);
      if (admitted.refused) return admitted;
      assert.deepEqual(admitted.produced, { id: 'h', pid: 123 });
      assert.equal(fs.existsSync(f.lock), false, 'output and attachment must be outside the lock');
      await f.definitions.list();
      if (repeatBirth) await runLocked(produce);
      f.events.push('output');
      if (attachmentLost) throw Error('attachment acknowledgement lost after possible effect');
      f.events.push('attachment'); return admitted.produced;
    },
  };
}
test('invocation preparation and output adapter surround one real locked birth', async t => {
  const f = await fixture(t); const ports = adapter(f);
  const answer = await f.execute(f.request, ports);
  assert.deepEqual(f.events, ['prepare', 'birth', 'output', 'attachment']);
  assert.equal(answer.status, 'done'); assert.equal(answer.resultLifetime, 'new-life');
  assert.equal(f.journal.open().length, 0);
  assert.deepEqual(await f.execute(f.request, ports), answer);
  assert.deepEqual(f.events, ['prepare', 'birth', 'output', 'attachment']);
});
test('revision moved after preparation refuses the locked birth without renewing its tuple', async t => {
  const f = await fixture(t); const ports = adapter(f); const prepare = ports.buildSpec;
  ports.buildSpec = async (...args) => {
    const spec = await prepare(...args);
    await f.definitions.set('a', { ...args[0], model: 'different' }, { installed: new Set(['hermes']) });
    return spec;
  };
  const answer = await f.execute(f.request, ports);
  assert.equal(answer.status, 'refused');
  assert.equal(answer.outcome, 'a changed since this start was queued: revision 1 -> 2; start it again');
  assert.deepEqual(f.events, ['prepare']); assert.equal(f.journal.open().length, 0);
});
test('possible birth and lost attachment retain unknown custody across executor instances', async t => {
  const f = await fixture(t);
  const answer = await f.execute(f.request, adapter(f, { attachmentLost: true }));
  assert.deepEqual(f.events, ['prepare', 'birth', 'output']);
  assert.equal(answer.outcome, 'execution-unknown'); assert.equal(f.journal.open().length, 1);
  assert.equal((await f.execute(f.request, adapter(f))).outcome, 'execution-unknown');
  assert.equal((await f.execute({ ...f.request, id: 'r2' }, adapter(f))).outcome, 'agent-reserved');
  assert.deepEqual(f.events, ['prepare', 'birth', 'output']);
  assert.notEqual(f.journal.stopFacts().get(`${f.request.storeId}:${f.request.expectedIncarnation}:a`), false);
});
test('a retained locked capability cannot produce a second birth', async t => {
  const f = await fixture(t); const answer = await f.execute(f.request, adapter(f, { repeatBirth: true }));
  assert.deepEqual(f.events, ['prepare', 'birth']);
  assert.equal(answer.outcome, 'execution-unknown'); assert.equal(f.journal.open().length, 1);
});
test('identity incompleteness after preparation blocks birth inside the actual lock', async t => {
  const f = await fixture(t); const ports = adapter(f); const prepare = ports.buildSpec;
  ports.buildSpec = async (...args) => {
    const spec = await prepare(...args);
    f.setRaw({ current: null });
    return spec;
  };
  const answer = await f.execute(f.request, ports);
  assert.equal(answer.status, 'refused'); assert.equal(answer.outcome, 'identity-moved');
  assert.deepEqual(f.events, ['prepare']); assert.equal(f.journal.open().length, 0);
});

test('definition recovery conflict introduced after preparation refuses actual locked birth', async t => {
  const f = await fixture(t); const ports = adapter(f); const prepare = ports.buildSpec;
  ports.buildSpec = async (...args) => {
    const spec = await prepare(...args);
    fs.writeFileSync(path.join(path.dirname(f.lock), '.intent.json'), '{}');
    const current = await f.definitions.list();
    assert.ok(current.conflict, 'actual recovery has an unresolved intent');
    const target = current.definitions.find(row => row.id === 'a');
    assert.deepEqual(target.problems, [], 'otherwise valid target is not the refusing gate');
    assert.equal(target.incarnation, f.request.expectedIncarnation);
    assert.equal(target.revision, f.request.expectedRevision);
    return spec;
  };
  const answer = await f.execute(f.request, ports);
  assert.equal(answer.status, 'refused'); assert.equal(answer.outcome, 'definition-unresolved');
  assert.deepEqual(f.events, ['prepare'], 'no birth or downstream output/attachment');
  assert.equal(f.journal.open().length, 0, 'known pre-effect refusal closes its own reservation');
  assert.deepEqual(await f.execute(f.request, ports), answer);
});

test('first postbirth uncertainty is the exact durable unknown receipt on later clock ticks', async t => {
  const f = await fixture(t);
  let timestamp = '2026-10-08T00:00:00.000Z';
  t.mock.method(Date.prototype, 'toISOString', () => timestamp);
  const ports = adapter(f, { attachmentLost: true }); const start = ports.start;
  ports.start = async (...args) => {
    timestamp = '2026-10-08T00:00:01.000Z';
    return await start(...args);
  };
  const answer = await f.execute(f.request, ports);
  assert.deepEqual(f.events, ['prepare', 'birth', 'output']);
  assert.equal(answer.outcome, 'execution-unknown');
  const durable = f.journal.open()[0].unknown;
  assert.equal(durable.finishedAt, '2026-10-08T00:00:00.000Z');
  assert.deepEqual(answer, durable, 'first report must use the journal receipt, not failure-time reconstruction');
  const replay = new AgentLifecycle({ ...f.deps, journal: new LifecycleJournal({ file: path.join(path.dirname(f.lock), '..', 'journal.json') }) });
  assert.deepEqual(await replay.execute(f.request, ports), answer);
  assert.equal(f.journal.open().length, 1);
  assert.deepEqual(f.events, ['prepare', 'birth', 'output'], 'replay must not retry a possible effect');
});
