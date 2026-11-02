// Exercise the maintained npm entrypoint; a valid peer must not hide a missing named file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = 'tests/lifecycle-failure.test.js';
const MISSPELLED = 'tests/a-stop-is-reported-onlyonce-the-process-is-gone.test.js';
function run(files) {
  assert.equal(fs.existsSync(path.join(ROOT, REAL)), true, 'positive control file exists');
  assert.equal(fs.existsSync(path.join(ROOT, MISSPELLED)), false, 'negative control really is absent');
  // As in the suite's other nested-run probes: keeping NODE_TEST_CONTEXT skips every child file with exit 0.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'NODE_TEST_CONTEXT'));
  return spawnSync(`npm test -- ${files.join(' ')}`, { cwd: ROOT, env, shell: true, encoding: 'utf8', timeout: 30000 });
}
test('npm test executes a real named file, including its known assertion', () => {
  const answer = run([REAL]);
  assert.equal(answer.status, 0, answer.stdout + answer.stderr);
  assert.match(answer.stdout, /known acquisition timeout before effects/);
  assert.match(answer.stdout, /# fail 0/);
  assert.match(answer.stdout, /# skipped 0/);
});
test('npm test refuses a missing named file even beside a real one and names it', () => {
  const answer = run([REAL, MISSPELLED]);
  assert.equal(answer.status, 2, 'missing named file must refuse, not run a smaller passing population');
  assert.ok(answer.stderr.includes('named test file does not exist: ' + MISSPELLED), 'the refusal must name the exact missing path, not just npm echoing its argv');
  assert.doesNotMatch(answer.stdout, /known acquisition timeout before effects/, 'no partial suite starts after refusal');
});
