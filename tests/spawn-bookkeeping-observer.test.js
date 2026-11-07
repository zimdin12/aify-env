// The pre-spawn absence assertion needs an observer that sees both actual publication mechanisms.
// The old positive control caught the missing durable path; this pins the instrument without native spawn cases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { fixture } from './fixtures/spawn-outcomes.mjs';
import { writeFileDurably } from '../lib/durable-file.mjs';
new ProcessEffectTripwire();

test('spawn bookkeeping observer sees direct and durable owned publications but not unrelated or temporary files', t => {
  const f = fixture(t);
  const direct = [{ id: 'direct', pid: 424242 }], durable = [{ id: 'durable', pid: 424243 }];
  fs.writeFileSync(f.ownedFile, JSON.stringify(direct));
  writeFileDurably(f.ownedFile, JSON.stringify(durable));
  assert.deepEqual(f.writes, [direct, durable], 'positive controls: both successful target publications are observed');
  fs.writeFileSync(f.ownedFile + '.tmp', JSON.stringify(direct));
  writeFileDurably(path.join(f.home, 'another-record.json'), JSON.stringify(direct));
  assert.deepEqual(f.writes, [direct, durable], 'negative controls: no invented owned publication');
});
