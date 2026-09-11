import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('actual dedicated daemon obeys isolation in owned Windows Jobs', { skip: process.platform !== 'win32', timeout: 120000 }, () => {
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'manual/herdr-dedicated-env.mjs')],
    { encoding: 'utf8', timeout: 110000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}\n${run.error || ''}`);
});
