// npm test runs at most four test files at once unless AIFY_TEST_CONCURRENCY says otherwise (2026-10-30).
//
// Without a bound Node 22 ran availableParallelism - 1 files at once, 31 on this 32-thread host, on a host three teams
// share. A bad value is refused before anything runs, so a typo cannot put the suite back on every core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONCURRENCY, suiteArgs } from './_suite-args.mjs';

test('four files at once by default, the hang timeout kept, and the files last', () => {
  assert.equal(DEFAULT_CONCURRENCY, 4);
  assert.deepEqual(suiteArgs(['tests/a.test.js', 'tests/b.test.js'], {}),
    ['--test', '--test-timeout=600000', '--test-concurrency=4', 'tests/a.test.js', 'tests/b.test.js']);
  assert.ok(suiteArgs([], { AIFY_TEST_CONCURRENCY: '' }).includes('--test-concurrency=4'), 'an empty value is not the default');
  assert.ok(suiteArgs([], { AIFY_TEST_CONCURRENCY: '6' }).includes('--test-concurrency=6'), 'AIFY_TEST_CONCURRENCY was not read');
});

test('a value that is not a whole number of 1 or more is refused, naming the variable', () => {
  for (const bad of ['0', '-1', '2.5', 'four', ' ']) {
    assert.throws(() => suiteArgs([], { AIFY_TEST_CONCURRENCY: bad }), /AIFY_TEST_CONCURRENCY must be a whole number of 1 or more/, bad);
  }
});

test('THROUGH THE RUNNER: a bad value runs nothing and exits 2; a good one runs the file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-suite-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Without NODE_TEST_CONTEXT: a `node --test` that inherits it reports to this run instead of running the file.
  const { NODE_TEST_CONTEXT, ...outer } = process.env;
  const run = (value, out) => spawnSync(process.execPath, ['tests/run-in-a-temp-root.mjs', 'tests/data/print-env-names.mjs'], {
    env: { ...outer, AIFY_TEST_CONCURRENCY: value, ENV_NAMES_OUT: out }, encoding: 'utf8', timeout: 60000,
  });
  const refused = run('zero', path.join(dir, 'refused.txt'));
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /AIFY_TEST_CONCURRENCY must be a whole number of 1 or more, not "zero"/);
  assert.equal(fs.existsSync(path.join(dir, 'refused.txt')), false, 'a refused value still ran the suite');
  const ran = run('1', path.join(dir, 'ran.txt'));
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), true, 'CONTROL: a good value runs the file');
});
