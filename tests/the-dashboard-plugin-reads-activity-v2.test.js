// These tests pin raw producer-format adoption, not a real dashboard receiver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, prerequisite } from './_activity-fixture.mjs';

test('approved activity-v2 raw records reach the maintained plugin lifecycle', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  await f.pass();
  assert.equal(f.bodies.length, 1, 'approved v2 records must actually leave through the plugin');
  assert.deepEqual(f.bodies[0].events, f.events.map(r => r.event));
});

test('disabled activity-v2 leaves raw producer records unchanged', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  f.config.activity.enabled = false; f.save();
  const p = f.plugin(); await p.start(f.host); await p.stop();
  assert.deepEqual(f.bodies, [], 'off sends no activity');
});
