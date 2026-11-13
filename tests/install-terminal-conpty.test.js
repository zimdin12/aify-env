// Actual Windows CONIN$/CONOUT$ and readline, with private wrapper policy/connect effects.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sealedDaemonEnv } from './_sealed-daemon-env.mjs';

for (const answer of ['y', 'n']) {
  test(`native Windows ConPTY ${answer}: prompt resolves and target exits naturally`, {
    skip: process.platform !== 'win32' ? 'NOT_RUN: requires native Windows ConPTY' : false, timeout: 30000,
  }, () => {
    const rig = fileURLToPath(new URL('./test-data/install-terminal-conpty.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [rig, answer, ...(process.env.AIFY_TEST_INSTALL_ENTRY ? [process.env.AIFY_TEST_INSTALL_ENTRY] : [])], { env: sealedDaemonEnv(), encoding: 'utf8', timeout: 25000 });
    assert.equal(result.status, 0, `${result.error?.message || ''}\n${result.stderr}\n${result.stdout}`);
    const record = JSON.parse(result.stdout.trim());
    console.log('NATIVE_INSTALL_CONPTY', JSON.stringify(record));
    assert.equal(record.platform, 'win32'); assert.equal(record.conptyDll, true); assert.ok(record.pid > 0);
    assert.equal(record.promptAnswered, true, 'must answer the real unspoofed Windows terminal prompt');
    assert.equal(record.completionSeen, true, record.output);
    assert.equal(record.naturalExit, true, 'target must naturally exit within3seconds of its report');
    assert.equal(record.exit, answer === 'y' ? 0 : 78);
    assert.ok(record.afterCompletionMs < 3000); assert.deepEqual(record.cleanup, []);
    assert.deepEqual(record.prepared, answer === 'y' ? { args: ['prepare-policy'], homeIsPrivate: true } : null);
    assert.equal(record.readinessReads, answer === 'y' ? 2 : 1);
    assert.equal(record.registry, answer === 'y', 'refusal must publish no registry');
    assert.ok(record.paths.every(p => p === '/.well-known/aify-service'), 'no service API or external install effects');
  });
}
