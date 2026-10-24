// Durable consumer storage boundaries. HTTP in _activity-fixture is only a reply stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, prerequisite } from './_activity-fixture.mjs';
import { sourceName, LIMITS } from '../lib/plugins/aify-dashboard/activity-raw.mjs';
import { ActivityState } from '../lib/plugins/aify-dashboard/activity-state.mjs';
const receipt = r => ({ committed: true, eventIds: r.token.eventIds, gapIds: r.token.gapIds });

test('a live lock owner cannot be displaced by another consumer operation', { skip: prerequisite }, async t => {
  const f = await fixture(t); f.open().read(); const before = fs.readFileSync(f.checkpoint);
  const storage = new ActivityState({ directory: f.directory, endpoint: f.endpoint });
  storage.transaction(() => {
    assert.equal(f.open().read().ok, false, 'same-process owner also refuses a nested operation');
    assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'live lock refusal changes no checkpoint');
  });
  assert.equal(f.open().read().ok, true, 'released operation admits the next consumer');
});

test('an lstat-reported state symlink refuses reads and replacement writes', { skip: prerequisite }, async t => {
  const f = await fixture(t); f.open().read(); const before = fs.readFileSync(f.checkpoint);
  // Metadata stub only. Native Windows file-symlink creation needs a privilege this worker lacks.
  // Real junction traversal is independently exercised below and in the raw-root tests.
  const original = fs.lstatSync;
  fs.lstatSync = function(file, ...args) {
    const stat = original.call(this, file, ...args);
    if (file === f.checkpoint) { stat.isSymbolicLink = () => true; stat.isFile = () => false; }
    return stat;
  };
  try { await f.pass(); } finally { fs.lstatSync = original; }
  assert.deepEqual(f.bodies, [], 'state symlink cannot authorize a report');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'state symlink refusal leaves checkpoint byte-identical');
});

test('raw and checkpoint byte caps refuse without resetting known state', { skip: prerequisite }, async t => {
  const f = await fixture(t); f.open().read(); const before = fs.readFileSync(f.checkpoint);
  const file = path.join(f.directory, sourceName(f.events[0].source)), original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.alloc(LIMITS.sessionBytes + 1));
  assert.equal(f.open().read().ok, false, 'oversized raw source refuses before decoding');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'raw cap preserves checkpoint');
  fs.writeFileSync(file, original); fs.writeFileSync(f.checkpoint, Buffer.concat([before, Buffer.alloc(256 * 1024 + 1 - before.length, 32)]));
  assert.equal(f.open().read().ok, false, 'oversized checkpoint refuses before parsing');
  assert.equal(fs.statSync(f.checkpoint).size, 256 * 1024 + 1, 'checkpoint cap never resets the file');
});

test('a pending batch never absorbs later append bytes before it is ACKed', { skip: prerequisite }, async t => {
  const f = await fixture(t); const first = f.open().read();
  assert.equal(f.producer().append({ ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } }).ok, true);
  const next = f.open().read();
  assert.deepEqual(next.token, first.token, 'pending interval and obligations stay frozen');
  assert.deepEqual(next.records, first.records, 'pending body stays immutable');
});

test('same-byte inode replacement refuses the old ACK without changing its checkpoint', { skip: prerequisite }, async t => {
  const f = await fixture(t); const first = f.open().read(); const before = fs.readFileSync(f.checkpoint);
  const file = path.join(f.directory, sourceName(f.events[0].source)), original = fs.readFileSync(file);
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, original); fs.unlinkSync(file + '.old');
  assert.equal(f.open().ack(first.token, receipt(first)).ok, false, 'physical replacement cannot inherit an ACK');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'same-byte replacement ACK mutates no checkpoint');
});

for (const marker of ['!', '??']) {
  test(`invalid ${marker.length}-byte marker refuses without producer or checkpoint mutation`, { skip: prerequisite }, async t => {
    const f = await fixture(t); f.open().read(); const before = fs.readFileSync(f.checkpoint);
    fs.writeFileSync(path.join(f.directory, 'uncertain'), marker); const raw = f.raw();
    await f.pass(); assert.deepEqual(f.bodies, [], 'invalid marker cannot authorize a report');
    assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'invalid marker changes no checkpoint');
    assert.deepEqual(f.raw(), raw, 'invalid marker is not silently repaired');
  });
}

test('a stricter local source-count cap refuses rather than dropping sources', { skip: prerequisite }, async t => {
  const f = await fixture(t); f.open().read(); const before = fs.readFileSync(f.checkpoint);
  const extra = { ...f.events[0], source: { ...f.events[0].source, sessionId: 'second-source' } };
  assert.equal(f.producer().append(extra).ok, true, 'second admitted raw source healthy control');
  f.config.activity.maxSessions = 1; f.save(); await f.pass();
  assert.deepEqual(f.bodies, [], 'source cap refuses before sending a partial discovery');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'source cap preserves consumer state');
});

test('an invalid local clock refuses without replacing persisted continuity', { skip: prerequisite }, async t => {
  const f = await fixture(t); f.open().read(); const before = fs.readFileSync(f.checkpoint);
  assert.equal(f.open({ clock: () => ({ wallMs: NaN, uptimeMs: 0 }) }).read().ok, false, 'invalid local clock refuses delivery');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'invalid local clock never renews freshness');
});

for (const target of ['segment', 'marker']) {
  test(`a nonregular ${target} cannot authorize delivery or change a checkpoint`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const read = f.open().read(), state = fs.readFileSync(f.checkpoint);
    const file = path.join(f.directory, sourceName(f.events[0].source));
    if (target === 'segment') { fs.unlinkSync(file); fs.mkdirSync(file); }
    else fs.mkdirSync(file.replace('.jsonl', '.loss'));
    await f.pass(); assert.deepEqual(f.bodies, [], 'nonregular raw target sends no activity');
    assert.deepEqual(fs.readFileSync(f.checkpoint), state, 'nonregular target never changes consumer checkpoint');
    assert.equal(read.token.segment.start, 0, 'healthy prefix was staged before the unsafe target');
  });
}
for (const key of ['generation', 'offset', 'checked', 'clock', 'sources', 'version', 'prefix', 'latches', 'items']) {
  test(`corrupt consumer ${key} fails closed without raw or checkpoint mutation`, { skip: prerequisite }, async t => {
    const f = await fixture(t); f.open().read();
    const state = JSON.parse(fs.readFileSync(f.checkpoint)); const s = Object.values(state.sources)[0];
    if (key === 'sources') state.sources = [];
    else if (key === 'version') state.version = 1;
    else if (key === 'prefix') s.prefix = 'invalid';
    else if (key === 'latches') s.latches = ['invented'];
    else if (key === 'items') s.stage.items = Array(129).fill(s.stage.items[0]);
    else s[key] = key === 'clock' ? { wallMs: 1, uptimeMs: -1 } : -1;
    fs.writeFileSync(f.checkpoint, JSON.stringify(state)); const before = fs.readFileSync(f.checkpoint), raw = f.raw();
    await f.pass(); assert.deepEqual(f.bodies, [], `${key} refuses activity`);
    assert.deepEqual(fs.readFileSync(f.checkpoint), before, `${key} corrupt checkpoint is not silently reset`);
    assert.deepEqual(f.raw(), raw, `${key} failure preserves producer bytes`);
  });
}

test('a consumer-state junction refuses all writes into its target', { skip: prerequisite }, async t => {
  const f = await fixture(t); const parent = path.dirname(path.dirname(f.checkpoint));
  const outside = path.join(f.root, 'outside-state'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'untouched'); fs.symlinkSync(outside, parent, 'junction');
  await f.pass();
  assert.deepEqual(f.bodies, [], 'consumer state path cannot traverse a junction');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel'], 'junction target receives no state artifacts');
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
});

test('a missing gap commit cannot advance the reopened contiguous prefix', { skip: prerequisite }, async t => {
  const f = await fixture(t); const first = f.open().read();
  assert.equal(f.open().resolve(first.token, { eventIds: [first.token.eventIds[0]], reason: 'refused' }).ok, true);
  const pending = f.open().read(), before = fs.readFileSync(f.checkpoint);
  assert.equal(f.open().ack(pending.token, { ...receipt(pending), gapIds: [] }).ok, false, 'missing gap ACK refuses prefix advancement');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'missing gap ACK writes nothing');
  assert.equal(f.open().read().token.segment.start, 0, 'prefix is still contiguous from byte zero');
  assert.equal(f.open().ack(pending.token, receipt(pending)).ok, true, 'healthy exact gap ACK commits');
  assert.equal(f.open().read().token, null, 'healthy commit survives reopen');
});

test('a stale stage token cannot ACK newly recovered obligations', { skip: prerequisite }, async t => {
  const f = await fixture(t); const first = f.open().read();
  f.open().resolve(first.token, { eventIds: [first.token.eventIds[0]], reason: 'event_conflict' });
  const before = fs.readFileSync(f.checkpoint);
  assert.equal(f.open().ack(first.token, receipt(first)).ok, false, 'stale token refuses before checkpoint advancement');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'stale token preserves recovered obligations byte-for-byte');
  assert.equal(f.open().read().gaps[0]?.reason, 'event_conflict');
});

test('per-line session-byte policy applies to the original full segment position', { skip: prerequisite }, async t => {
  const f = await fixture(t); const file = path.join(f.directory, sourceName(f.events[0].source));
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  lines[1].policy.sessionBytes = 900;
  fs.writeFileSync(file, lines.map(v => JSON.stringify(v) + '\n').join(''));
  const read = f.open().read();
  assert.deepEqual(read.records.map(r => r.record.event), [f.events[0].event], 'original segment byte policy refuses the later record');
  assert.equal(read.gaps[0]?.reason, 'policy', 'per-line byte allowance is represented as a gap');
});

test('unidentified malformed raw bytes leave coverage unknown even without a producer marker', { skip: prerequisite }, async t => {
  const f = await fixture(t); const file = path.join(f.directory, sourceName(f.events[0].source)); fs.writeFileSync(file, 'torn');
  const p = await f.pass();
  assert.deepEqual(f.bodies, [], 'unknown raw bytes do not invent a source');
  assert.ok(p.state().problems.some(p => p.startsWith('file activity:')), 'unidentified malformed bytes are visible unknown coverage');
});

test('replacement retains pending recovery gap identities rather than silently abandoning them', { skip: prerequisite }, async t => {
  const f = await fixture(t); const first = f.open().read();
  f.open().resolve(first.token, { eventIds: [first.token.eventIds[0]], reason: 'event_conflict' });
  const pending = f.open().read();
  const file = path.join(f.directory, sourceName(f.events[0].source)); const bytes = fs.readFileSync(file);
  fs.renameSync(file, file + '.old'); fs.writeFileSync(file, bytes); fs.unlinkSync(file + '.old');
  const next = f.open().read();
  assert.ok(next.gaps.some(g => g.id === pending.gaps[0].id), 'replacement must retain the stable pending recovery marker');
  assert.ok(next.gaps.some(g => g.reason === 'identity'), 'replacement additionally records lost prefix identity');
});
