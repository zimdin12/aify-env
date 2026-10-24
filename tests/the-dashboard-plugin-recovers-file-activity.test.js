// New coverage: every reply guard must preserve the reopened prefix, not just an in-memory verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activityDecision } from '../lib/plugins/aify-dashboard/activity-protocol.mjs';
import { fixture, prerequisite, ack, conflict } from './_activity-fixture.mjs';

const invalidAcks = {
  'version': b => ({ ...ack(b), version: 2 }),
  'batch identity': b => ({ ...ack(b), batchId: randomUUID() }),
  'missing result': b => ({ ...ack(b), results: ack(b).results.slice(0, -1) }),
  'extra result': b => ({ ...ack(b), results: [...ack(b).results, ack(b).results[0]] }),
  'ordered result identities': b => ({ ...ack(b), results: ack(b).results.reverse() }),
  'disposition': b => ({ ...ack(b), results: ack(b).results.map(r => ({ ...r, disposition: 'accepted' })) }),
  'stored code': b => ({ ...ack(b), results: ack(b).results.map(r => ({ ...r, code: 'event_purged' })) }),
  'refusal code': b => ({ ...ack(b), results: ack(b).results.map(r => ({ ...r, disposition: 'refused', code: 'remote-text' })) }),
  'coverage generation': b => ({ ...ack(b), coverage: { ...ack(b).coverage, generation: b.coverage.generation + 1 } }),
  'unsubmitted gap': b => ({ ...ack(b), coverage: { ...ack(b).coverage, acknowledgedGapIds: [randomUUID()] } }),
};
for (const [guard, response] of Object.entries(invalidAcks)) {
  test(`invalid ACK ${guard} cannot advance or resolve the persisted prefix`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.open().read();
    f.respond(b => ({ status: 200, body: response(b) })); await f.pass();
    assert.equal(f.bodies.length, 1, 'invalid ACK was actually received');
    assert.equal(activityDecision({ status: 200, body: response(f.bodies[0]) }, f.bodies[0]), null, `ACK ${guard} validation refuses before storage`);
    assert.deepEqual(f.open().read().token, before.token, `ACK ${guard} preserves actual cursor and recovery`);
    assert.deepEqual(f.open().read().gaps, [], 'malformed ACK creates no invented gap');
  });
}
for (const mode of ['disconnect', '503', 'no JSON ACK']) {
  test(`${mode} retries immutable bodies after plugin restart`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.open().read();
    f.respond(() => mode === 'disconnect' ? { destroy: true } : mode === '503' ? { status: 503, body: { error: 'down' } } : { raw: 'not JSON' });
    await f.pass();
    assert.deepEqual(f.open().read().token, before.token, `${mode} leaves real cursor unchanged`);
    f.respond(b => ({ body: ack(b) })); await f.pass();
    assert.deepEqual(f.bodies[1].events, f.bodies[0].events, 'immutable retry event IDs and bodies');
    assert.notEqual(f.bodies[1].batchId, f.bodies[0].batchId, 'new delivery batch');
    assert.equal(f.open().read().token, null, 'valid ACK retires prefix on restart');
  });
}

test('terminal refusal persists a stable recovery gap before any line retires', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  f.respond(b => { const a = ack(b); a.results[0] = { eventId: b.events[0].eventId, disposition: 'refused', code: 'no_containing_project' }; return { body: a }; });
  await f.pass();
  const recovery = f.open().read();
  assert.deepEqual(recovery.records.map(r => r.record.event), [f.events[1].event], 'unaffected event retained');
  assert.equal(recovery.token.segment.start, 0, 'refused ACK alone never advances cursor');
  assert.equal(recovery.gaps[0].reason, 'refused'); assert.equal(recovery.gaps[0].lostCount, null);
  assert.deepEqual(f.open().read().gaps, recovery.gaps, 'recovery gap survives reopen');
  f.respond(b => ({ body: ack(b) })); await f.pass();
  assert.deepEqual(f.bodies[1].coverage.gaps, recovery.gaps, 'stable gap body submitted on restart');
  assert.equal(f.open().read().token, null, 'gap commit authorizes contiguous retirement');
});

test('event conflict retains unrelated event and stable replacement gap through restart', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  f.respond(b => conflict(b, [b.events[0].eventId])); await f.pass();
  const recovery = f.open().read();
  assert.deepEqual(recovery.records.map(r => r.record.event), [f.events[1].event], 'only named conflicting event excluded');
  assert.equal(recovery.token.segment.start, 0, '409 is not a cursor ACK');
  assert.equal(recovery.gaps[0].reason, 'event_conflict');
  assert.deepEqual(f.open().read().gaps, recovery.gaps, 'conflict marker durable');
  f.respond(b => ({ body: ack(b) })); await f.pass();
  assert.deepEqual(f.bodies[1].events, [f.events[1].event], 'unrelated event actually resubmitted');
  assert.deepEqual(f.bodies[1].coverage.gaps, recovery.gaps);
  assert.notEqual(f.bodies[1].batchId, f.bodies[0].batchId, 'recovery gets fresh batch ID');
  assert.equal(f.open().read().token, null);
});

test('gap conflict replaces only the named gap with stable new identity through restart', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  const first = f.open().read(); assert.equal(f.open().resolve(first.token, { eventIds: [first.token.eventIds[0]], reason: 'refused' }).ok, true);
  const old = f.open().read();
  f.respond(b => conflict(b, [], [b.coverage.gaps[0].id])); await f.pass();
  const next = f.open().read();
  assert.notEqual(next.gaps[0].id, old.gaps[0].id, 'conflicting gap identity never reused');
  assert.equal(next.gaps[0].reason, 'gap_conflict');
  assert.deepEqual(next.records, old.records, 'unaffected event is not discarded');
  assert.deepEqual(f.open().read().gaps, next.gaps, 'replacement gap stable across reopen');
  f.respond(b => ({ body: ack(b) })); await f.pass();
  assert.deepEqual(f.bodies[1].coverage.gaps, next.gaps, 'replacement actually sent');
  assert.equal(f.open().read().token, null);
});

const invalidConflicts = {
  'version': b => { const r = conflict(b, [b.events[0].eventId]); r.body.version = 2; return r; },
  'batch identity': b => { const r = conflict(b, [b.events[0].eventId]); r.body.batchId = randomUUID(); return r; },
  'unknown code': b => conflict(b, [b.events[0].eventId], [], 'unknown'),
  'outside event': b => conflict(b, [randomUUID()]),
  'duplicate events': b => conflict(b, [b.events[0].eventId, b.events[0].eventId]),
  'missing gap population': b => { const r = conflict(b, [b.events[0].eventId]); delete r.body.error.gapIds; return r; },
  'outside gap': b => conflict(b, [b.events[0].eventId], [randomUUID()]),
  'empty population': b => conflict(b, [], [], 'event_conflict'),
  'mixed precedence': b => conflict(b, [b.events[0].eventId], [], 'gap_conflict'),
};
for (const [guard, response] of Object.entries(invalidConflicts)) {
  test(`invalid 409 ${guard} cannot discard persisted data`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.open().read();
    f.respond(response); await f.pass();
    assert.equal(f.bodies.length, 1, '409 actually received');
    const reply = response(f.bodies[0]);
    assert.equal(activityDecision({ status: reply.status, body: reply.body }, f.bodies[0]), null, `409 ${guard} validation refuses before storage`);
    assert.deepEqual(f.open().read().token, before.token, `409 ${guard} preserves cursor and recovery`);
  });
}

test('ACK gap IDs must be exact and unique before recovery retires', { skip: prerequisite }, async t => {
  const f = await fixture(t); const read = f.open().read();
  f.open().resolve(read.token, { eventIds: [read.token.eventIds[0]], reason: 'refused' });
  const before = f.open().read();
  f.respond(b => { const a = ack(b); a.coverage.acknowledgedGapIds.push(...a.coverage.acknowledgedGapIds); return { body: a }; });
  await f.pass(); assert.deepEqual(f.open().read().token, before.token, 'duplicate gap ACK preserves recovery');
  f.respond(b => { const a = ack(b); a.coverage.acknowledgedGapIds = []; return { body: a }; });
  await f.pass(); assert.deepEqual(f.open().read().token, before.token, 'missing gap ACK preserves recovery');
  f.respond(b => ({ body: ack(b) })); await f.pass(); assert.equal(f.open().read().token, null);
});
