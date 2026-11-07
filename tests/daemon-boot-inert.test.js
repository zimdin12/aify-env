// A new import boundary must be inert even when no caller supplies safe fake factories.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();

test('importing daemon boot binds no listener, arms no timer and starts no process', async t => {
  const effects = { listeners: 0, intervals: 0 };
  t.mock.method(net.Server.prototype, 'listen', () => { effects.listeners++; throw Error('listener forbidden'); });
  t.mock.method(globalThis, 'setInterval', () => { effects.intervals++; throw Error('interval forbidden'); });
  assert.throws(() => net.createServer().listen(0), /listener forbidden/);
  assert.throws(() => setInterval(() => {}, 1000), /interval forbidden/);
  assert.deepEqual(effects, { listeners: 1, intervals: 1 }, 'positive controls: both effect instruments really fire');
  effects.listeners = 0; effects.intervals = 0;
  await import('node:path');
  assert.deepEqual(effects, { listeners: 0, intervals: 0 }, 'negative control: pure import is not itself counted');
  const imported = await import('../lib/daemon-boot.mjs?inert-probe').then(api => typeof api.startDaemonBoot === 'function', () => false);
  assert.deepEqual({ imported, ...effects }, { imported: true, listeners: 0, intervals: 0 });
});
