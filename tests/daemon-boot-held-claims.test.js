// Producer trace: comms terminal_controls_io.py:36-73/119-135 returns CLAIMED controls;
// routers/terminals.py:277-310 returns argv/env/definition launch bindings. A spawn claim only registers warm agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { HeldBootComms } from './fixtures/held-boot-comms.mjs';
new ProcessEffectTripwire();
async function until(predicate, message) {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('HELD boot keeps the real plugin claim path alive: fresh start refuses, a new request after original-owner absence rechecks and admits', { timeout: 15000 }, async t => {
  const h = await new HeldBootComms().initialize(t), before = fs.readFileSync(h.file);
  h.enqueue('control-held');
  await h.f.boot();
  await until(() => h.reports.some(row => row.id === 'control-held'), 'the real plugin never claimed/reported the held start');
  const held = h.reports.find(row => row.id === 'control-held');
  assert.deepEqual({ status: held.status, fenced: /ownership recovery is incomplete/.test(held.error),
    spawns: h.spawns.length, recovery: h.recovery.status().state, cancelled: h.f.session.cancelled },
  { status: 'failed', fenced: true, spawns: 0, recovery: 'held', cancelled: false });
  assert.ok(fs.readFileSync(h.file).equals(before), 'held work cannot publish a successor success row');
  assert.ok(h.plugins.report().some(row => row.name === 'aify-comms'), 'HELD must retain the actual claimer plugin');
  const firstLaunch = h.requests.find(row => row.route.endsWith('/terminal-control-held/launch'));
  assert.ok(firstLaunch, 'the report came through the real control poll and launch transport, not a direct handler');
  assert.ok(h.observations.some(row => row.pids.includes(424240) && !row.absent.includes(424240)), 'positive control: original owner was observed present');
  const observedBefore = h.observations.length;
  h.originalOwnerGone();
  assert.equal(h.recovery.status().state, 'held', 'changing the fake OS alone does not run a completion seam');
  h.enqueue('control-fresh');
  await until(() => h.reports.some(row => row.id === 'control-fresh'), 'the retained poller never delivered the new post-absence request');
  const admitted = h.reports.find(row => row.id === 'control-fresh');
  assert.deepEqual({ status: admitted.status, spawns: h.spawns.length, ready: h.recovery.status().ready },
    { status: 'completed', spawns: 1, ready: true });
  assert.equal(admitted.processId, String(h.spawns[0].pid));
  assert.ok(h.observations.slice(observedBefore).some(row => row.pids.includes(424240) && row.absent.includes(424240)),
    'the new start actually obtains a positive original-owner-gone observation');
  assert.deepEqual(h.ended, [424241], 'only the old verified child is recovered by the injected ending port');
  const polls = h.requests.filter(row => row.route === '/api/v1/terminals/controls/claim');
  assert.ok(polls.length >= 2 && polls.every(row => row.body.bridgeId === h.api.identity.bridgeId));
  assert.ok(h.launches.get('terminal-control-held').definition.revision === h.binding.revision
    && h.launches.get('terminal-control-fresh').definition.revision === h.binding.revision, 'both fresh controls use the actual store revision, not invented retry state');
  const journal = JSON.parse(fs.readFileSync(path.join(h.home, '.aify', 'agent-lifecycle.json'), 'utf8'));
  const automatic = Object.entries(journal.records).filter(([id]) => id.startsWith('automatic-'));
  assert.equal(automatic.length, 2, 'actual automatic admission minted a fresh operation for each claimed start');
  assert.deepEqual(automatic.map(([, row]) => row.result.status).sort(), ['done', 'refused']);
});
