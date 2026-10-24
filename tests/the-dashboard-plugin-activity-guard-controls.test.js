// Consumer guards and native HTTP body cancellation. Receiver responses below are HTTP stubs.
// Pure assertions complement actual HTTP/reopened-storage checks; they do not replace them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { activityDecision, activityBatch } from '../lib/plugins/aify-dashboard/activity-protocol.mjs';
import { activityGrant, existingDirectory } from '../lib/plugins/aify-dashboard/activity-source.mjs';
import { fixture, prerequisite, ack, conflict, until, delay } from './_activity-fixture.mjs';

for (const kind of ['ACK', 'refusal', '409']) {
  test(`stop ignores late ${kind} and carries abort to the activity transport`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.open().read().token;
    let release, observedSignal;
    const fetchImpl = async (url, options) => {
      if (!String(url).endsWith('/api/v1/file-activity')) return fetch(url, options);
      observedSignal = options.signal; const b = JSON.parse(options.body);
      let reply = { status: 200, body: ack(b) };
      if (kind === '409') reply = conflict(b, [b.events[0].eventId]);
      if (kind === 'refusal') reply.body.results[0] = { eventId: b.events[0].eventId, disposition: 'refused', code: 'event_purged' };
      await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    };
    const p = f.plugin({ overrides: { fetch: fetchImpl } }); await p.start(f.host);
    await until(() => release, 'held activity transport entered');
    const stopping = p.stop();
    try { assert.equal(observedSignal.aborted, true, 'stop signal cancels actual activity transport'); }
    finally { release(); }
    await stopping;
    assert.deepEqual(f.open().read().token, before, `late ${kind} cannot ACK or resolve`);
  });
}

test('stop cancels native HTTP while its successful response body is incomplete', { skip: prerequisite }, async t => {
  const f = await fixture(t); const before = f.open().read().token; let opened = false, closed = false;
  f.respond(() => ({ stream: response => { opened = true; response.on('close', () => { closed = true; }); } }));
  const p = f.plugin(); await p.start(f.host); await until(() => opened, 'native response body held');
  await p.detach(); await until(() => closed, 'stop closes native response connection');
  assert.deepEqual(f.open().read().token, before, 'cancelled body read preserves actual cursor');
});

test('native HTTP body deadline refuses an incomplete ACK without advancing cursor', { skip: prerequisite }, async t => {
  const f = await fixture(t); const before = f.open().read().token; let opened = false;
  f.respond(() => ({ stream: () => { opened = true; } }));
  const p = f.plugin(); const started = Date.now(); await p.start(f.host);
  await until(() => opened, 'native response body entered');
  await until(() => (p.state().activity?.passes ?? 0) === 1, 'activity body deadline must settle bounded pass', 12500);
  assert.ok(Date.now() - started >= 9000, 'actual deadline, not immediate fixture refusal');
  await p.stop(); assert.deepEqual(f.open().read().token, before, 'deadline is not an ACK');
});

test('mixed event and gap conflict uses event precedence and retains an unrelated fact', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 3 }); const first = f.open().read();
  f.open().resolve(first.token, { eventIds: [first.token.eventIds[0]], reason: 'refused' });
  const old = f.open().read();
  f.respond(b => conflict(b, [b.events[0].eventId], [b.coverage.gaps[0].id])); await f.pass();
  const read = f.open().read();
  assert.deepEqual(read.records.map(r => r.record.event), [f.events[2].event], 'unrelated mixed-conflict event survives');
  assert.equal(read.gaps.find(g => g.reason === 'event_conflict')?.lostCount, null);
  assert.equal(read.gaps.find(g => g.reason === 'gap_conflict')?.lostCount, null);
  assert.equal(read.gaps.some(g => g.id === old.gaps[0].id), false, 'conflicting gap replaced');
  assert.deepEqual(f.open().read().gaps, read.gaps, 'both markers durable');
  f.respond(b => ({ body: ack(b) })); await f.pass(); assert.equal(f.open().read().token, null);
});

for (const guard of ['missing event population', 'duplicate gap population', 'gap code with events', 'event code without events']) {
  test(`409 ${guard} refuses before invoking recovery`, { skip: prerequisite }, async t => {
    const f = await fixture(t, { records: 3 }); const first = f.open().read();
    f.open().resolve(first.token, { eventIds: first.token.eventIds.slice(0, 2), reason: 'refused' });
    const before = f.open().read();
    const reply = b => {
      if (guard === 'missing event population') { const r = conflict(b, [], [b.coverage.gaps[0].id]); delete r.body.error.eventIds; return r; }
      if (guard === 'duplicate gap population') return conflict(b, [], [b.coverage.gaps[0].id, b.coverage.gaps[0].id]);
      if (guard === 'gap code with events') return conflict(b, [b.events[0].eventId], [b.coverage.gaps[0].id], 'gap_conflict');
      return conflict(b, [], [b.coverage.gaps[0].id], 'event_conflict');
    };
    f.respond(reply); await f.pass();
    const r = reply(f.bodies[0]);
    assert.equal(activityDecision({ status: r.status, body: r.body }, f.bodies[0]), null, `409 ${guard} decision rejected`);
    assert.deepEqual(f.open().read().token, before.token, `409 ${guard} preserves disk obligations`);
  });
}

test('equal-length duplicate gap ACK cannot hide a missing committed gap', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 3 }); const read = f.open().read();
  f.open().resolve(read.token, { eventIds: [read.token.eventIds[0]], reason: 'refused' });
  const second = f.open().read();
  f.open().resolve(second.token, { eventIds: [second.token.eventIds[0]], reason: 'event_conflict' });
  const before = f.open().read();
  const reply = b => { const a = ack(b); a.coverage.acknowledgedGapIds[1] = a.coverage.acknowledgedGapIds[0]; return a; };
  f.respond(b => ({ body: reply(b) })); await f.pass();
  assert.equal(activityDecision({ status: 200, body: reply(f.bodies[0]) }, f.bodies[0]), null, 'unique exact gap population validated');
  assert.deepEqual(f.open().read().token, before.token, 'duplicate ACK preserves recovery');
});

test('wrapper capacity loss and unknown producer coverage are sent without fabricated counts', { skip: prerequisite }, async t => {
  const f = await fixture(t, { policy: { sessionBytes: 1500, maxSessions: 1 }, records: 1 });
  for (let i = 0; i < 8; i++) f.producer().append({ ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } });
  const extra = { ...f.events[0], source: { ...f.events[0].source, sessionId: 'another-session' } };
  assert.equal(f.producer().append(extra).ok, false, 'producer hits its actual slot bound');
  const before = f.open().read(); assert.equal(before.coverage, 'unknown'); assert.equal(before.gaps[0].reason, 'producer_loss');
  await f.pass(); assert.equal(f.bodies[0].coverage.producer, 'unknown');
  assert.deepEqual(f.bodies[0].coverage.gaps, before.gaps, 'consumer owns stable loss identity and nullable count');
  assert.equal(f.bodies[0].coverage.gaps[0].lostCount, null);
});

for (const reason of ['expired', 'clock']) {
  test(`consumer ${reason} gaps replace unsendable events honestly`, { skip: prerequisite }, async t => {
    const f = await fixture(t, { records: 1, policy: reason === 'expired' ? { maxAgeMs: 100 } : {} });
    if (reason === 'expired') await delay(150);
    else { f.open().read(); f.open({ clock: () => ({ wallMs: Date.now() - 5000, uptimeMs: Math.floor(os.uptime() * 1000) }) }).read(); }
    const read = f.open().read(); assert.equal(read.gaps[0].reason, reason, 'actual spool owner produced gap');
    await f.pass(); assert.deepEqual(f.bodies[0].events, [], 'unsendable observations are not made young');
    assert.deepEqual(f.bodies[0].coverage.gaps, read.gaps);
    assert.equal(f.bodies[0].coverage.reportEveryMs, null);
  });
}

test('large normalized paths split at storage byte bound and preserve every event', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 9, filePath: i => String(i) + 'x'.repeat(16000) });
  await f.pass(); assert.ok(f.bodies[0].events.length < 9, 'real byte-bound split is exercised');
  assert.ok(Buffer.byteLength(JSON.stringify(f.bodies[0])) <= 256 * 1024, 'encoded bound includes metadata');
  await f.pass(); assert.deepEqual(f.bodies.flatMap(b => b.events), f.events.map(r => r.event), 'all immutable events delivered in order');
  assert.equal(f.open().read().token, null);
});

for (const budget of ['event', 'gap', 'encoded byte']) {
test(`batch transform refuses over-budget ${budget} population`, () => {
  const base = { source: {}, generation: 1, coverage: 'unknown', gaps: [], records: [] };
  const read = budget === 'event' ? { ...base, records: Array.from({ length: 129 }, () => ({ record: { event: {} } })) }
    : budget === 'gap' ? { ...base, gaps: Array(33).fill({}) } : { ...base, source: { text: 'x'.repeat(256 * 1024) } };
  assert.throws(() => activityBatch(read, randomUUID()), /batch-limit/, `${budget} budget refused`);
});
}

test('explicit grants and symlink admission fail before the storage owner is called', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  assert.equal(activityGrant({}), null, 'absent enablement stays off');
  assert.equal(activityGrant({ activity: { enabled: false } }), null, 'disabled stays off');
  for (const value of [null, true, [], { enabled: 'true' }, { enabled: true }, { enabled: true, leaseDirectory: 'relative', wrapperCheckout: f.config.activity.wrapperCheckout }]) {
    assert.throws(() => activityGrant({ activity: value }), /configuration/, 'missing or malformed grant refused');
  }
  const link = path.join(f.root, 'linked-lease'); fs.symlinkSync(f.leases, link, 'junction');
  assert.throws(() => existingDirectory(link), /unsafe-directory/, 'consumer independently refuses junction');
  assert.throws(() => existingDirectory(path.join(f.directory, fs.readdirSync(f.directory)[0])), /unsafe-directory/, 'consumer refuses nondirectory');
});

test('source attribution cannot be borrowed from a differently named agent directory', { skip: prerequisite }, async t => {
  const f = await fixture(t); const before = f.open().read().token;
  const renamed = path.join(f.leases, 'agent-2'); fs.renameSync(path.dirname(f.directory), renamed);
  await f.pass(); assert.deepEqual(f.bodies, [], 'directory mismatch cannot authorize another agent source');
  assert.equal(f.open({ directory: path.join(renamed, 'activity-v2'), agentId: 'agent-2' }).read().ok, false, 'mismatched source refuses before mutation');
});
