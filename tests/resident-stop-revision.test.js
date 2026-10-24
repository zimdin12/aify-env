import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';

const binding = { agentId: 'fixture', storeId: 'store', incarnation: 1 };
const key = 'store:1:fixture';
const request = id => ({ id, agentId: 'fixture', machineId: 'machine', storeId: 'store',
  expectedIncarnation: 1, expectedRevision: 1, expectedLifetime: null, action: 'stop', requestedBy: 'operator' });
const done = { status: 'done', outcome: 'stop', resultLifetime: null, finishedAt: '2026-10-24T00:00:00Z' };

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-stop-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'journal.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: {}, stops: { [key]: true }, ...extra }));
  return { file, journal: new LifecycleJournal({ file }), bytes: () => fs.readFileSync(file, 'utf8') };
}

function stop(journal, id) {
  const r = request(id);
  assert.equal(journal.reserve(r).fresh, true);
  journal.markStopped(r);
  journal.finish(r, done);
}

function snapshot(journal, address = binding) {
  const { receipt, ...state } = journal.stopSnapshot(address);
  return state;
}
function capture(journal) {
  const state = journal.stopSnapshot(binding);
  return { ...binding, stopRevision: state.revision, stopReceipt: state.receipt };
}

test('legacy boolean stops have revision zero without rewriting the journal', t => {
  const f = fixture(t);
  const before = f.bytes();
  assert.deepEqual(snapshot(f.journal), { stopped: true, revision: 0 });
  assert.deepEqual(snapshot(f.journal, { ...binding, incarnation: 2 }), { stopped: false, revision: 0 });
  assert.equal(f.bytes(), before);
});

test('separate Stops advance a durable revision and a resident clear consumes that revision once', t => {
  const f = fixture(t);
  stop(f.journal, 'first');
  assert.deepEqual(snapshot(f.journal), { stopped: true, revision: 1 });
  const first = capture(f.journal);
  stop(f.journal, 'second');
  assert.deepEqual(f.journal.consumeResidentStart(first, { live: () => true }), { consumed: false, reason: 'stop-moved' });
  assert.deepEqual(snapshot(f.journal), { stopped: true, revision: 2 });
  const second = capture(f.journal);
  assert.deepEqual(f.journal.consumeResidentStart(second, { live: () => true }), { consumed: true, reason: 'resident-start' });
  const reopened = new LifecycleJournal({ file: f.file });
  assert.deepEqual(snapshot(reopened), { stopped: false, revision: 3 });
  const before = f.bytes();
  assert.deepEqual(reopened.consumeResidentStart(second, { live: () => true }), { consumed: false, reason: 'stop-moved' });
  assert.equal(f.bytes(), before);
});

test('capturing a revision reserves nothing and a pending Stop prevents the resident clear', t => {
  const f = fixture(t);
  const captured = capture(f.journal);
  assert.deepEqual(f.journal.open(), []);
  const r = request('later-stop');
  assert.equal(f.journal.reserve(r).fresh, true);
  assert.deepEqual(f.journal.consumeResidentStart(captured, { live: () => true }), { consumed: false, reason: 'agent-reserved' });
  assert.equal(f.journal.stopFacts().get(key), true);
  f.journal.markStopped(r);
  f.journal.finish(r, done);
  assert.deepEqual(f.journal.consumeResidentStart(captured, { live: () => true }), { consumed: false, reason: 'stop-moved' });
  assert.equal(f.journal.stopFacts().get(key), true);
});

test('a resident clear requires the role both before mutation and at the durable rename', t => {
  const f = fixture(t);
  const captured = capture(f.journal);
  const before = f.bytes();
  assert.deepEqual(f.journal.consumeResidentStart(captured, { live: () => false }), { consumed: false, reason: 'not-owner' });
  assert.equal(f.bytes(), before);
  let checks = 0, refused;
  try { f.journal.consumeResidentStart(captured, { live: () => ++checks === 1 }); }
  catch (error) { refused = error; }
  assert.equal(f.bytes(), before, 'role loss before rename must leave the complete journal unchanged');
  assert.equal(refused?.code, 'NOT_OWNER');
});

test('a changed receipt invalidates a resident snapshot even when the stop boolean and counter do not move', t => {
  const f = fixture(t);
  const captured = capture(f.journal);
  const r = request('legacy-stop');
  assert.equal(f.journal.reserve(r).fresh, true);
  f.journal.finish(r, done); // The legacy writer records a Stop but cannot advance the new counter.
  assert.deepEqual(snapshot(f.journal), { stopped: true, revision: 0 });
  const before = f.bytes();
  assert.deepEqual(f.journal.consumeResidentStart(captured, { live: () => true }), { consumed: false, reason: 'stop-moved' });
  assert.equal(f.bytes(), before);
  const fresh = capture(f.journal);
  assert.match(fresh.stopReceipt, /^[0-9a-f]{64}$/);
  assert.notEqual(fresh.stopReceipt, captured.stopReceipt);
  assert.equal(f.journal.consumeResidentStart(fresh, { live: () => true }).consumed, true);
});

test('a resident snapshot with the current receipt but a wrong counter cannot clear', t => {
  const f = fixture(t), captured = capture(f.journal);
  const before = f.bytes();
  assert.deepEqual(f.journal.consumeResidentStart({ ...captured, stopRevision: captured.stopRevision + 1 },
    { live: () => true }), { consumed: false, reason: 'stop-moved' });
  assert.equal(f.bytes(), before);
});

test('a resident snapshot with the current counter but a wrong receipt cannot clear', t => {
  const f = fixture(t), captured = capture(f.journal);
  const before = f.bytes();
  assert.deepEqual(f.journal.consumeResidentStart({ ...captured, stopReceipt: '0'.repeat(64) },
    { live: () => true }), { consumed: false, reason: 'stop-moved' });
  assert.equal(f.bytes(), before);
});

for (const [name, stopRevisions] of [
  ['null', null], ['array', []], ['negative', { [key]: -1 }],
  ['fraction', { [key]: 0.5 }], ['unsafe', { [key]: Number.MAX_SAFE_INTEGER + 1 }],
]) test(`malformed stop revision ${name} refuses before a write`, t => {
  const f = fixture(t, { stopRevisions });
  const before = f.bytes();
  assert.throws(() => f.journal.stopSnapshot(binding), /lifecycle-journal-malformed/);
  assert.equal(f.bytes(), before);
});

test('an exhausted stop revision cannot wrap or clear the durable stop', t => {
  const f = fixture(t, { stopRevisions: { [key]: Number.MAX_SAFE_INTEGER } });
  const r = request('exhausted-stop');
  assert.equal(f.journal.reserve(r).fresh, true);
  const before = f.bytes();
  assert.throws(() => f.journal.markStopped(r), /lifecycle-stop-revision-exhausted/);
  assert.equal(f.bytes(), before);
  assert.equal(f.journal.stopFacts().get(key), true);
});
