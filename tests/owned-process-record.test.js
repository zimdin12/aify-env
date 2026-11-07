// OwnedProcessRecord, the owned-process record's one reader and durable writer (lib/owned-process-record.mjs).
//
// Filesystem only, in private fixture directories. Every process syscall and child_process entry throws here
// (ProcessEffectTripwire): nothing in this file may observe, signal or start a process. Each case names the bug it
// would catch and what covered that before.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeFileDurably } from '../lib/durable-file.mjs';
import { OwnedProcessRecord } from '../lib/owned-process-record.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';

new ProcessEffectTripwire();

function box(t, name = 'owned.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-owned-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, name) };
}
const besides = (dir) => fs.readdirSync(dir).filter((name) => name !== 'owned.json');
const row = (id, extra = {}) => ({ id, pid: 100, service: 's', launcher: '/l/x', owner: 7, startedAt: 1, ...extra });
const failure = (code) => Object.assign(new Error(code), { code });

test('a read failure other than ENOENT is not "missing", and no change writes over the unread file', (t) => {
  // BUG: readOwned turned every read error into [] and the old guard read a failed read as "missing", so the next
  // spawn replaced a file nobody had read. COVERED BEFORE: nothing; the damaged-record test only feeds readable bytes.
  const { dir, file } = box(t);
  const original = Buffer.from(`${JSON.stringify([row('a')])}\n`);
  fs.writeFileSync(file, original);
  assert.deepEqual(new OwnedProcessRecord(file).load().entries, [row('a')], 'control: the fixture holds a readable row');
  assert.equal(new OwnedProcessRecord(path.join(dir, 'absent.json')).load().status, 'missing', 'control: ENOENT is missing');

  const lines = [];
  const denied = { ...fs, readFileSync: () => { throw failure('EACCES'); } };
  const record = new OwnedProcessRecord(file, { io: denied, report: (line) => lines.push(line) });
  const loaded = record.load();
  assert.deepEqual([loaded.status, loaded.reason, loaded.entries], ['unreadable', 'read-failed', []]);

  const started = record.started(row('b'));
  assert.deepEqual([started.ok, started.entry.id], [false, 'b'], 'a failed write still returns the attempted identity');
  assert.equal(record.retain([row('c')]).ok, false);
  assert.equal(record.retire([row('a')]).ok, false);
  assert.deepEqual(fs.readFileSync(file), original, 'an unread record was written over');
  assert.deepEqual(besides(dir), [], 'nothing was copied aside, since nothing was read');
  assert.equal(lines.length, 3, 'each refused change is reported');
});

test('a write that fails before its rename leaves the old bytes, and is reported rather than thrown', (t) => {
  // BUG: the record was written in place with writeFileSync, which truncates first, and every failure was swallowed
  // silently. COVERED BEFORE: durable-file's own tests cover writeFileDurably, not this record's use of it.
  const { dir, file } = box(t);
  const original = Buffer.from(`${JSON.stringify([row('a')])}\n`);
  fs.writeFileSync(file, original);
  const refused = (target, text, options) => writeFileDurably(target, text, { ...options, renameSync: () => { throw failure('EIO'); } });

  const lines = [];
  const outcome = new OwnedProcessRecord(file, { writeDurably: refused, report: (line) => lines.push(line) }).started(row('b'));
  assert.deepEqual([outcome.ok, outcome.targetReplaced, outcome.entry], [false, false, row('b')]);
  assert.deepEqual(fs.readFileSync(file), original, 'a failed write changed the record');
  assert.deepEqual(besides(dir), [], 'the temporary file was left behind');
  assert.match(lines.join(''), /could not record a started process/);

  const silent = new OwnedProcessRecord(file, { writeDurably: refused, report: () => { throw new Error('stderr closed'); } });
  let quiet;
  assert.doesNotThrow(() => { quiet = silent.started(row('c')); }, 'a reporter that throws must not throw through the caller');
  assert.equal(quiet.ok, false);
});

test('a failure after the rename says the new record is in place', (t) => {
  // BUG: reporting every write failure as "unchanged" would hide that a successful rename's directory sync failed and
  // the new bytes are the record now. COVERED BEFORE: nothing distinguished the two.
  const { file } = box(t);
  const syncFails = (target, text, options) => { writeFileDurably(target, text, options); throw failure('EIO'); };
  const outcome = new OwnedProcessRecord(file, { writeDurably: syncFails, report: () => {} }).started(row('a'));
  assert.deepEqual([outcome.ok, outcome.targetReplaced], [false, true]);
  assert.deepEqual(new OwnedProcessRecord(file).load().entries, [row('a')]);
});

test('damaged bytes are copied aside exactly before the record is replaced, and the record is kept if the copy fails', (t) => {
  // BUG: the old guard renamed a damaged file aside and wrote anyway when that rename failed; and a list holding
  // non-UTF-8 bytes decoded lossily, parsed, and was rewritten with U+FFFD and no copy. COVERED BEFORE: the
  // damaged-record test covers text that does not parse, not failed preservation, bytes or order.
  const { file } = box(t);
  const bytes = Buffer.concat([Buffer.from('[{"id":"a","pid":1,"service":"'), Buffer.from([0xff]), Buffer.from('"}]')]);
  assert.ok(Array.isArray(JSON.parse(bytes.toString('utf8'))), 'premise: a lossy decode of these bytes parses as a list');
  fs.writeFileSync(file, bytes);

  const order = [];
  const record = new OwnedProcessRecord(file, { report: () => {},
    writeDurably: (target, text, options) => { order.push(target); return writeFileDurably(target, text, options); } });
  const loaded = record.load();
  assert.deepEqual([loaded.status, loaded.reason], ['unreadable', 'unsupported']);
  const outcome = record.started(row('b'));
  assert.equal(outcome.ok, true);
  assert.deepEqual(order, [outcome.aside, file], 'the copy is made before the record is replaced');
  assert.deepEqual(fs.readFileSync(outcome.aside), bytes, 'the copy is not the exact original bytes');
  assert.deepEqual(record.load().entries, [row('b')]);

  const { dir: other, file: corrupt } = box(t);
  fs.writeFileSync(corrupt, '{ not json');
  const copyFails = (target, text, options) => {
    if (target !== corrupt) throw failure('ENOSPC');
    return writeFileDurably(target, text, options);
  };
  const refused = new OwnedProcessRecord(corrupt, { writeDurably: copyFails, report: () => {} }).started(row('c'));
  assert.equal(refused.ok, false);
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{ not json', 'the record was replaced although its copy failed');
  assert.deepEqual(besides(other), []);
});

test('rows this version cannot read, and fields it does not know, are written back byte for byte', (t) => {
  // BUG: every write filtered the list down to recognised rows, and re-serialising would turn 1e400 into null and
  // round 12345678901234567890. COVERED BEFORE: the damaged-record test asserted the discard; corrected there.
  const { file } = box(t);
  const known = '{"id": "a", "pid": 1, "service": "s", "big": 12345678901234567890}';
  const unknown = '{"future": 1e400, "pid": "not-a-number"}';
  fs.writeFileSync(file, `[${known}, 42, null, ${unknown}]`);
  const record = new OwnedProcessRecord(file, { report: () => {} });
  const loaded = record.load();
  assert.deepEqual([loaded.status, loaded.entries.map((e) => e.id), loaded.unknownRows], ['readable', ['a'], 3]);

  assert.equal(record.started(row('b')).ok, true);
  assert.equal(record.retire([record.load().entries[1]]).ok, true);
  for (const source of [known, '42', 'null', unknown]) {
    assert.ok(fs.readFileSync(file, 'utf8').includes(source), `${source} did not survive two writes exactly`);
  }
  assert.deepEqual(record.retire([loaded.entries[0]]).removed.map((e) => e.id), ['a']);
  const left = fs.readFileSync(file, 'utf8');
  assert.ok(!left.includes(known) && left.includes(unknown) && left.includes('null'), 'retire removed an unknown row or kept its own');
});

test('retire removes only the exact rows it is given, from the file as it is now', (t) => {
  // BUG: recordStopped removed by id and clearOwned wrote a caller's keep snapshot back, so a delayed stop or clear
  // erased a successor's row or resurrected one removed since. COVERED BEFORE: a-live-instances checks a fresh keep.
  const { file } = box(t);
  const writes = [];
  const options = { report: () => {}, writeDurably: (...args) => { writes.push(args[0]); return writeFileDurably(...args); } };
  const predecessor = new OwnedProcessRecord(file, { ownerPid: 7, ...options });
  const successor = new OwnedProcessRecord(file, { ownerPid: 8, ...options });
  for (const id of ['a', 'b', 'd', 'e']) predecessor.started(row(id));
  const snapshot = predecessor.load().entries;

  successor.started(row('a', { pid: 200, owner: 8 }));
  successor.retire([row('b')]);
  successor.started(row('c', { owner: 8 }));
  writes.length = 0;
  const outcome = predecessor.retire(snapshot);
  assert.deepEqual(outcome.removed.map((e) => e.id), ['d', 'e']);
  assert.deepEqual(outcome.unmatched.map((e) => e.id), ['a', 'b']);
  assert.equal(writes.length, 1, 'several rows are retired in one write');
  assert.deepEqual(successor.load().entries, [row('a', { pid: 200, owner: 8 }), row('c', { owner: 8 })]);
});

test('retain adds back only rows missing by exact identity, in one write, never replacing what is there', (t) => {
  // BUG: a legacy predecessor's final clear can erase unresolved rows before a successor may write; putting them back
  // by id, or by writing the snapshot over the file, would drop or duplicate what is there now. COVERED BEFORE: none.
  const { file } = box(t);
  const writes = [];
  const record = new OwnedProcessRecord(file, { ownerPid: 8, report: () => {},
    writeDurably: (...args) => { writes.push(args[0]); return writeFileDurably(...args); } });
  const unresolved = [row('a'), row('a2')];
  const otherInstance = row('a', { pid: 300, owner: 9 });
  // What the legacy predecessor's last clear left: another instance's row with the same id, and a row nobody reads.
  fs.writeFileSync(file, `[${JSON.stringify(otherInstance)}, {"future": 1}]\n`);

  const first = record.retain(unresolved);
  assert.deepEqual([first.ok, first.added, writes.length], [true, unresolved, 1]);
  assert.deepEqual(record.load().entries, [otherInstance, ...unresolved]);
  assert.equal(record.load().unknownRows, 1);
  const again = record.retain(unresolved);
  assert.deepEqual([again.ok, again.written, again.added, writes.length], [true, false, [], 1], 'a present row was added twice');
  assert.deepEqual(record.retire([row('b')]).unmatched, [row('b')]);

  const refused = record.retain([{ id: 'z' }]);
  assert.deepEqual([refused.ok, refused.rejected], [false, [{ id: 'z' }]], 'a row that names no process was accepted');
  assert.equal(writes.length, 1);
});

test('started returns the row exactly as stored, and binds an owner identity only to its own owner', (t) => {
  // BUG: an owner birth identity attached to a row recorded for another owner PID would vouch for the wrong owner; and
  // a returned entry unlike the stored row would make exact retirement miss. COVERED BEFORE: owned-processes tests
  // cover the default owner PID only.
  const { file } = box(t);
  const ownerIdentity = { platform: 'win32', createdMicros: '1700000000000001' };
  const groupScope = { kind: 'posix-group', pgid: 4242 };
  const record = new OwnedProcessRecord(file, { ownerPid: 7, ownerIdentity, report: () => {} });

  const mine = record.started({ id: 'a', pid: 1, service: 's', groupScope, startedAt: 5 });
  assert.deepEqual([mine.entry.owner, mine.entry.ownerIdentity, mine.entry.groupScope], [7, ownerIdentity, groupScope]);
  const theirs = record.started({ id: 'b', pid: 2, service: 's', owner: 9, startedAt: 5 });
  assert.equal(Object.hasOwn(theirs.entry, 'ownerIdentity'), false, 'this owner identity was given to owner 9');
  assert.deepEqual(record.load().entries, [mine.entry, theirs.entry]);
  assert.deepEqual(record.retire([mine.entry]).removed, [mine.entry]);

  const { file: legacy } = box(t);
  const plain = new OwnedProcessRecord(legacy, { ownerPid: 7, report: () => {} }).started({ id: 'c', pid: 3, service: 's', startedAt: 5 });
  assert.deepEqual(plain.entry, { id: 'c', pid: 3, service: 's', launcher: '', owner: 7, startedAt: 5 }, 'no identity adds no field');
});
