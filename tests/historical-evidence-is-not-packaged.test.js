// Exercise npm's actual files expansion, not just package.json's spelling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { sealedHomeEnv } from './_sealed-daemon-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
function filesAt(file) {
  return fs.statSync(file).isDirectory()
    ? fs.readdirSync(file).flatMap(name => filesAt(path.join(file, name))) : [file];
}

test('the installed package retains runtime and current docs but contains no historical evidence', { timeout: 60000 }, () => {
  const npm = process.env.npm_execpath;
  assert.equal(typeof npm, 'string', 'run through the maintained npm test entry');
  assert.equal(fs.existsSync(npm), true, 'use the actual npm that started this suite');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const env = sealedHomeEnv({ ...inherited,
    NPM_CONFIG_CACHE: path.join(os.tmpdir(), 'pack-cache'),
    NPM_CONFIG_USERCONFIG: path.join(os.tmpdir(), 'no-user-npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(os.tmpdir(), 'no-global-npmrc'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false' });
  const run = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 55000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const [pack] = JSON.parse(run.stdout);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pack.name, pkg.name);
  assert.equal(pack.version, pkg.version);
  const files = new Set(pack.files.map(file => file.path));
  for (const file of ['package.json', 'README.md', 'VERSION', 'lib/install-chain.mjs', 'bin/aify-env.mjs']) {
    assert.equal(files.has(file), true, `missing runtime or package identity: ${file}`);
  }
  const docs = filesAt(path.join(ROOT, 'docs')).map(file => path.relative(ROOT, file).split(path.sep).join('/'));
  for (const file of docs.filter(file => !file.startsWith('docs/evidence/'))) {
    assert.equal(files.has(file), true, `current documentation omitted: ${file}`);
  }
  assert.equal(fs.statSync(path.join(ROOT, 'docs/evidence')).isDirectory(), true, 'the repository keeps its evidence');
  assert.deepEqual([...files].filter(file => file.startsWith('docs/evidence/')), [], 'historical captures must not ship');
});
