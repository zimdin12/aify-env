// Native tty teardown, not install admission. The Python rig stubs every install effect.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function nativePath(file) {
  if (process.platform !== 'win32') return file;
  const match = /^([A-Za-z]):\/(.*)$/.exec(file.split(path.sep).join('/'));
  assert.ok(match, 'NOT_RUN: native fixture requires an explicit WSL path');
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}
for (const answer of ['yes', 'no']) {
  test(`native terminal ${answer}: real interactive entry exits after its report`, { timeout: 25000 }, () => {
    assert.ok(['linux', 'win32'].includes(process.platform), 'NOT_RUN: Linux or WSL prerequisite required');
    const rig = nativePath(fileURLToPath(new URL('./test-data/install-terminal-pty.py', import.meta.url)));
    const entry = nativePath(fileURLToPath(new URL('../bin/aify-env-install.mjs', import.meta.url)));
    const args = ['--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/python3', '-I', rig, entry, answer, process.env.AIFY_TEST_NATIVE_NODE || '/usr/bin/node'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
    const run = process.platform === 'win32'
      ? spawnSync('wsl.exe', args, { env, encoding: 'utf8', timeout: 20000 })
      : spawnSync('/usr/bin/env', args.slice(2), { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, `${run.error?.message || ''}\n${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(run.stdout.trim());
    console.log('NATIVE_INSTALL_TERMINAL', JSON.stringify(result));
    assert.equal(result.platform, 'linux');
    assert.equal(result.promptAnswered, true, 'must answer the actual terminal prompt');
    assert.equal(result.completionSeen, true, result.output);
    assert.deepEqual(result.effects, answer === 'yes' ? ['--acquire-only', 'connect', '--assets-only'] : []);
    assert.equal(result.registry, answer === 'yes');
    assert.equal(result.naturalExit, true, 'entry must naturally exit within3seconds after its completion report');
    assert.equal(result.exit, answer === 'yes' ? 0 : 78);
    assert.deepEqual(result.cleanup, []);
    assert.ok(result.afterCompletionMs < 3000);
  });
}
