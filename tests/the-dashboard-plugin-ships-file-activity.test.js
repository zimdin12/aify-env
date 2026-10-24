// New ownership: real producer spool -> configured production plugin -> HTTP -> reopened cursor.
// Existing head/secrets lifecycle tests own legacy behavior, not activity delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, prerequisite, delay, until } from './_activity-fixture.mjs';

test('activity test worker uses the selected native runtime', () => {
  console.log(JSON.stringify({ activityWorker: { version: process.version, execPath: process.execPath } }));
  const expected = process.env.EXPECTED_ACTIVITY_NODE ?? process.env.npm_node_execpath;
  assert.ok(expected, 'npm supplies the selected runtime');
  assert.equal(path.resolve(process.execPath).toLowerCase(), path.resolve(expected).toLowerCase());
});

test('activity off preserves the legacy lifecycle without discovery or spool writes', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  f.config.activity = { enabled: false, wrapperCheckout: 'not-an-execution-grant' }; f.save();
  const before = f.open().read();
  const p = f.plugin(); await p.start(f.host); await delay(40); await p.detach();
  assert.deepEqual(f.requests.map(r => r.path), ['/api/v1/host/fixture/watch-list']);
  assert.deepEqual(f.open().read().token, before.token, 'off does not advance the spool');
});

test('configured plugin ships only immutable event metadata and commits the real reopened cursor', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  await f.pass();
  assert.equal(f.bodies.length, 1, 'one bounded pass sends one source batch');
  assert.deepEqual(f.bodies[0].events, f.events.map(r => r.event), 'ship event, never the storage envelope');
  assert.deepEqual(f.bodies[0].source, f.events[0].source);
  assert.equal(f.bodies[0].source.incarnation, null, 'unproven incarnation stays null');
  assert.equal(f.bodies[0].coverage.reportEveryMs, null, 'no invented freshness cadence');
  assert.equal(Object.hasOwn(f.bodies[0], 'wsl'), false, 'no changing WSL retry facts');
  assert.equal(f.open().read().token, null, 'committed ACK retires actual source bytes');
});

test('plugin startup checks activity capability once across idle ticks', { skip: prerequisite }, async t => {
  for (const declared of [true, false]) await t.test(declared ? 'declared' : 'absent', async t => {
    const f = await fixture(t);
    if (!declared) f.capability(null);
    const before = f.open().read().token;
    const p = f.plugin({ overrides: { tickMs: 1 } });
    await p.start(f.host);
    try { await until(() => (p.state().activity?.passes ?? 0) >= 3, 'three existing plugin ticks complete'); }
    finally { await p.stop(); }
    assert.equal(f.bodies.length, declared ? 1 : 0, 'healthy delivery and absent-capability refusal both execute');
    assert.deepEqual(f.open().read().token, declared ? null : before, 'idle or refused ticks preserve the real cursor');
    assert.equal(f.requests.filter(r => r.path === '/.well-known/aify-service').length, 1,
      'idle ticks do not rediscover the same capability');
  });
});
