// The original checkpoint tests do not count writes after a fully committed idle source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, prerequisite } from './_activity-fixture.mjs';

function publications(work) {
  const write = fs.writeFileSync, sync = fs.fsyncSync;
  let writes = 0, fsyncs = 0;
  fs.writeFileSync = function(file, ...args) {
    if (typeof file === 'number') writes++;
    return write.call(this, file, ...args);
  };
  fs.fsyncSync = function(...args) { fsyncs++; return sync.apply(this, args); };
  try { return { value: work(), counts: () => ({ writes, fsyncs }) }; }
  finally { fs.writeFileSync = write; fs.fsyncSync = sync; }
}

// This catches an idle save hidden behind a successful empty read, not merely a wrong read result.
test('committed idle activity reopens without checkpoint publication and resumes on new bytes', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 });
  const staged = publications(() => f.open().read());
  assert.deepEqual(staged.counts(), { writes: 1, fsyncs: 1 }, 'healthy batch stage is the publication positive control');
  const first = staged.value;
  assert.equal(f.open().ack(first.token, { committed: true, eventIds: first.token.eventIds, gapIds: first.token.gapIds }).ok, true);
  const before = fs.readFileSync(f.checkpoint);
  const negative = publications(() => fs.statSync(f.checkpoint));
  assert.deepEqual(negative.counts(), { writes: 0, fsyncs: 0 });
  const idle = publications(() => f.open().read());
  assert.equal(idle.value.token, null);
  assert.deepEqual(idle.counts(), { writes: 0, fsyncs: 0 }, 'idle poll rewrote a checkpoint without a batch');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'idle poll changed durable continuity without a batch');
  const later = { ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } };
  assert.equal(f.producer().append(later).ok, true);
  const resumed = publications(() => f.open().read());
  assert.deepEqual(resumed.value.records.map(r => r.record), [later]);
  assert.deepEqual(resumed.counts(), { writes: 1, fsyncs: 1 }, 'new bytes must still stage their checkpoint before HTTP');
});
