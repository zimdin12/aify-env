import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { requireWslIsolation } from '../scripts/rehearsal/fresh-pc/rehearse.mjs';

const script = fileURLToPath(new URL('../scripts/rehearsal/fresh-pc/rehearse.mjs', import.meta.url));
const template = JSON.parse(fs.readFileSync(new URL('../scripts/rehearsal/fresh-pc/pins.template.json', import.meta.url), 'utf8'));
function fixture(t, change = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-pc-gates-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = structuredClone(template);
  m.approve = ['3'.repeat(64)];
  m.dashboardGitRepo = 'fixture-owner/dashboard';
  change(m);
  const file = path.join(dir, 'pins.json');
  fs.writeFileSync(file, JSON.stringify(m));
  return (mode, env = process.env) => {
    const result = spawnSync(process.execPath, [script, mode, file], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
    assert.deepEqual(fs.readdirSync(dir), ['pins.json'], 'validation must stop before writing a home or evidence');
    return result;
  };
}
test('preflight accepts a syntactically valid exact tuple without any services', t => {
  const result = fixture(t)('--preflight');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no checkout, child process or endpoint was touched/);
});
test('preflight rejects the production Comms port', t => {
  const result = fixture(t, m => { m.origins.comms = 'http://127.0.0.1:8800'; })('--preflight');
  assert.equal(result.status, 1, 'a production port must be refused');
  assert.match(result.stderr, /dedicated guest loopback ports/);
});
test('preflight refuses an unresolved wrapper pin', t => {
  const result = fixture(t, m => { m.pins.wrapper = null; })('--preflight');
  assert.equal(result.status, 1, 'a missing revision must be refused');
  assert.match(result.stderr, /missing exact wrapper pin/);
});
test('install mode refuses an inherited agent identity before touching fixtures', t => {
  const result = fixture(t)('--run', { ...process.env, AIFY_AGENT_ID: 'fixture-inherited-no-live-identity' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing inherited agent identity/);
});

const wsl = '[automount]\nenabled=false\n[interop]\nenabled=false\nappendWindowsPath=false\n';
test('imported WSL needs observed isolation as well as its config', () => {
  const mounts = '0 1 8:0 / / rw - ext4 /dev/sda rw';
  assert.doesNotThrow(() => requireWslIsolation(wsl, mounts, ['/usr/bin']));
  assert.throws(() => requireWslIsolation(wsl.replace('appendWindowsPath=false', 'appendWindowsPath=true'), mounts, ['/usr/bin']), /appendWindowsPath=false/);
  assert.throws(() => requireWslIsolation(wsl, `${mounts}\n1 2 8:0 / /mnt/c rw - 9p C: rw`, ['/usr/bin']), /filesystem is mounted/);
  assert.throws(() => requireWslIsolation(wsl, mounts, ['/usr/bin', '/mnt/c/Windows']), /Windows PATH leaked/);
});
