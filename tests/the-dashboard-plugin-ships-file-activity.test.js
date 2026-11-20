// New ownership: real producer spool -> configured production plugin -> HTTP -> reopened cursor.
// Existing head/secrets lifecycle tests own legacy behavior, not activity delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { fixture, prerequisite, until } from './_activity-fixture.mjs';
new ProcessEffectTripwire();

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
  // The provider wait starts from the first watched tick and does not read the activity switch (ef0679e), so it is
  // part of the legacy lifecycle. Wait for that request rather than a fixed delay, then detach: detach awaits the tick,
  // including its activity pass, so nothing the switch should stop can arrive after the assertion.
  const legacy = ['/api/v1/host/fixture/watch-list', '/api/v1/host/fixture/provider/pending?waitSeconds=25'];
  const p = f.plugin(); await p.start(f.host);
  await until(() => legacy.every(path => f.requests.some(r => r.path === path)), 'the legacy watch and provider wait ran');
  await p.detach();
  const activity = f.requests.filter(({ path }) => path === '/.well-known/aify-service' || path === '/api/v1/file-activity');
  assert.deepEqual(activity, [], 'no capability discovery and no activity post while off');
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

// New property: the consumer's absent grant resolves installed owners and ships a resident source.
// Existing configured-delivery coverage cannot catch a shipper that silently remains off without that grant.
// This creates an existing spool record with real producer code, not a resident runtime/default-on claim.
// Producer trace: aify-lifetime.sh exports AIFY_ENV_INSTANCE=residents and AIFY_LIFETIME;
// aify-tool-event.mjs passes those as instanceId/incarnation to activityEvent and uses leaseDirectory.
for (const failFirst of [false, true]) test(failFirst
  ? 'a failed default-source lookup is retried on the next tick and ships the existing record'
  : 'absent activity grant ships an existing resident record through the real plugin without an env contribution', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 0 });
  const wrapper = process.env.AIFY_WRAPPER_REPO;
  const { activityEvent } = await import(pathToFileURL(path.join(wrapper, 'lib/file-activity.mjs')));
  const record = activityEvent({ input: { session_id: 'resident-session', cwd: 'C:/fixture/project', tool_name: 'Read', tool_input: { file_path: 'resident.txt' } },
    identity: { machineId: 'win32:fixture', instanceId: 'residents', agentId: 'agent-1', incarnation: randomUUID() },
    outcome: 'success', observedAt: Date.now() });
  assert.ok(record, 'actual wrapper validator admits the resident producer shape');
  assert.equal(f.producer().append(record).ok, true);
  delete f.config.activity; f.save();
  const packages = path.join(f.root, 'global-node-modules'), linked = path.join(packages, 'aify-wrapper');
  fs.mkdirSync(packages); fs.symlinkSync(wrapper, linked, 'junction');
  const cp = createRequire(import.meta.url)('node:child_process'), original = cp.spawnSync;
  const oldLease = process.env.AIFY_AGENT_LEASE_DIR; let queries = 0;
  cp.spawnSync = (command, args) => {
    assert.deepEqual([command, args], ['npm', ['root', '-g']], 'only the installed-root query is admitted');
    queries++;
    return failFirst && queries === 1 ? { status: 1, stdout: '' } : { status: 0, stdout: packages };
  };
  process.env.AIFY_AGENT_LEASE_DIR = f.leases; syncBuiltinESMExports();
  const p = f.plugin({ overrides: { tickMs: 1 } });
  try {
    await p.start(f.host);
    await until(() => (p.state().activity?.passes ?? 0) >= (failFirst ? 3 : 2), 'absent-grant plugin must execute its existing activity ticks');
    assert.deepEqual({ batches: f.bodies.length, events: f.bodies[0]?.events, source: f.bodies[0]?.source },
      { batches: 1, events: [record.event], source: record.source });
    assert.equal(f.open().read().token, null, 'the real receipt commits the reopened cursor');
    assert.equal(queries, failFirst ? 2 : 1, 'only a failed lookup is retried; successful source resolution stays cached');
  } finally {
    await p.stop(); cp.spawnSync = original; syncBuiltinESMExports(); fs.unlinkSync(linked);
    if (oldLease === undefined) delete process.env.AIFY_AGENT_LEASE_DIR; else process.env.AIFY_AGENT_LEASE_DIR = oldLease;
  }
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
