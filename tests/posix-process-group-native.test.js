// Native qualification only; NEVER select this file for mutants. Every target is this rig's own detached group.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
const RIG = fileURLToPath(new URL('./test-data/owned-posix-group.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
function linuxPath(value) {
  const text = value.split(path.sep).join('/');
  if (process.platform === 'linux') return text;
  const found = /^([A-Za-z]):\/(.*)$/.exec(text);
  assert.ok(found, 'NOT_RUN: native fixture needs an explicit WSL path');
  return `/mnt/${found[1].toLowerCase()}/${found[2]}`;
}
for (const mode of ['normal', 'parent-trap', 'pipe-holder', 'shutdown-SIGINT', 'shutdown-SIGTERM']) {
  test(`native Linux/WSL ${mode}: owned group and descendants are gone before success`, { timeout: 25000 }, t => {
    assert.ok(['linux', 'win32'].includes(process.platform), 'NOT_RUN: native Linux or WSL prerequisite required');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-group-native-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const args = ['--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${linuxPath(dir)}`, `TMPDIR=${linuxPath(dir)}`,
      '/usr/bin/timeout', '--kill-after=2s', '15s', '/usr/bin/node', linuxPath(RIG), mode, linuxPath(dir), process.env.AIFY_TEST_NATIVE_RECORD_ONLY === '1' ? 'record-only' : 'native'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
    const run = process.platform === 'win32' ? spawnSync('wsl.exe', args, { env, encoding: 'utf8', timeout: 20000 })
      : spawnSync('/usr/bin/env', args.slice(2), { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, `NOT_RUN or native rig failure: ${run.error?.message || ''}\n${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(run.stdout.trim());
    // Persistent evidence is opt-in and confined to this checkout's ignored output, never a live profile.
    const evidence = process.env.AIFY_TEST_EVIDENCE_DIR;
    if (evidence) {
      const owned = path.resolve(ROOT, '.check-output'), selected = path.resolve(evidence);
      assert.ok(selected.startsWith(owned + path.sep), 'evidence directory must be inside this checkout output');
      fs.mkdirSync(selected, { recursive: true });
      const target = path.join(selected, `${mode}.json`); assert.equal(fs.existsSync(target), false, 'retain each native round separately');
      fs.writeFileSync(target, JSON.stringify({ ...result, rigSha256: createHash('sha256').update(fs.readFileSync(RIG)).digest('hex') }, null, 2));
    }
    assert.equal(result.platform, 'linux'); assert.equal(result.answer.stopped, true, JSON.stringify(result));
    assert.equal(result.groupState, 'gone'); assert.equal(result.remaining, 0);
    assert.deepEqual(result.gone, { root: true, worker: true, grandchild: true }, JSON.stringify(result));
    assert.equal(result.observedGroups.every(row => row.group === result.pids.root), true);
    assert.equal(result.signalled.filter(name => name === 'SIGKILL').length <= 1, true);
    if (mode === 'parent-trap' || mode === 'pipe-holder' || mode.startsWith('shutdown-')) assert.ok(result.signalled.includes('SIGKILL'));
    for (const [name, before] of Object.entries(result.inputs.before)) {
      assert.equal(before.present, true); assert.deepEqual(result.inputs.after[name], { present: true, sha256: before.sha256 });
    }
    if (result.shutdown) { assert.equal(result.shutdown.code, 0); assert.equal(result.shutdown.cleared, true); }
    console.log('OWNED_POSIX_GROUP', JSON.stringify({ mode, pids: result.pids, groupState: result.groupState, stopped: result.answer.stopped, signals: result.signalled }));
  });
}
