// Native effect-adapter qualification, not real daemon takeover. Never a mutation selector.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
const RIG = fileURLToPath(new URL('./test-data/recovered-posix-group.mjs', import.meta.url));
const ROOT = path.resolve(import.meta.dirname, '..');
function linuxPath(value) {
  const slashed = value.split(path.sep).join('/');
  if (process.platform === 'linux') return slashed;
  const match = /^([A-Za-z]):\/(.*)$/.exec(slashed);
  assert.ok(match, 'NOT_RUN: explicit WSL fixture path is required');
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}
for (const mode of ['live', 'root-dead']) {
  test(`native Linux/WSL recovered ${mode}: actual owning capture controls group cleanup or durable hold`, { timeout: 25000 }, t => {
    assert.ok(['win32', 'linux'].includes(process.platform), 'NOT_RUN: requires Linux or WSL');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovered-posix-native-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const args = ['--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${linuxPath(dir)}`, `TMPDIR=${linuxPath(dir)}`,
      '/usr/bin/timeout', '--kill-after=2s', '15s', '/usr/bin/node', linuxPath(RIG), mode, linuxPath(dir),
      process.env.AIFY_TEST_RECOVERY_RECORD_ONLY === '1' ? 'record-only' : 'native'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
    const run = process.platform === 'win32' ? spawnSync('wsl.exe', args, { env, encoding: 'utf8', timeout: 20000 })
      : spawnSync('/usr/bin/env', args.slice(2), { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, `native rig failed or NOT_RUN: ${run.error?.message || ''}\n${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(run.stdout.trim());
    const selected = process.env.AIFY_TEST_EVIDENCE_DIR;
    if (selected) {
      const output = path.resolve(selected), allowed = path.resolve(ROOT, '.check-output');
      assert.ok(output.startsWith(allowed + path.sep)); fs.mkdirSync(output, { recursive: true });
      const target = path.join(output, `recovered-posix-${mode}.json`); assert.equal(fs.existsSync(target), false);
      fs.writeFileSync(target, JSON.stringify({ ...result, rigSha256: createHash('sha256').update(fs.readFileSync(RIG)).digest('hex') }, null, 2));
    }
    assert.equal(result.platform, 'linux');
    assert.ok(result.observedGroups.every(row => row.group === result.pids.root));
    if (mode === 'live') {
      assert.deepEqual(result.answer, { state: 'gone', scope: 'recorded-posix-group' });
      assert.equal(result.groupState, 'gone'); assert.equal(result.retained, false);
      assert.deepEqual(result.signals.filter(signal => signal !== 0), ['SIGTERM', 'SIGKILL']);
    } else {
      assert.equal(result.answer.state, 'unknown'); assert.match(result.answer.problem, /unverified group/);
      assert.equal(result.groupState, 'present'); assert.equal(result.retained, true);
      assert.deepEqual(result.signals.filter(signal => signal !== 0), []);
    }
    assert.deepEqual(result.inputs.after, result.inputs.before);
  });
}
