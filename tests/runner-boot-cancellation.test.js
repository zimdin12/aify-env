// Per-start guards are covered by in-flight-spawn-custody; this adds the mandatory Runner-wide boot fence.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { BootSession, BootCancelled } from '../lib/daemon-boot-session.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { fixture, child, tick, failed } from './fixtures/spawn-outcomes.mjs';
new ProcessEffectTripwire();

for (const boundary of ['checkpoint', 'gate', 'roots']) {
  test(`Runner-wide boot cancellation during ${boundary} refuses creation after the final await`, async t => {
    const session = new BootSession(); let resume, created = 0;
    const waiting = new Promise(resolve => { resume = resolve; }), c = child();
    c.onData = fn => c.on('data', fn); c.onExit = fn => c.on('pty-exit', fn);
    const spawn = () => { created++; queueMicrotask(() => c.emit('spawn')); return c; };
    const f = fixture(t, { assertOpen: session.assertOpen,
      openTerminal: boundary === 'checkpoint' ? spawn : null, spawnProcess: spawn,
      loadCheckpoint: boundary === 'checkpoint' ? () => waiting : null,
      startGate: boundary === 'gate' ? () => waiting : null });
    const starting = failed(f.runner.start(f.spec, { admitSpawn: () => boundary === 'roots' ? waiting : f.home }));
    await tick(); session.cancel(); resume(boundary === 'roots' ? f.home : null);
    const result = await starting, effects = structuredClone(f.effects());
    c.emit('close', 0, null); c.emit('pty-exit', { exitCode: 0 });
    assert.deepEqual({ typed: result.error instanceof BootCancelled, created, effects },
      { typed: true, created: 0, effects: f.untouched }, 'the mandatory guard must refuse and leave process success bookkeeping untouched');
  });
}

async function lifecycleStart(f) {
  const stateHost = new AgentStateHost({ aifyHome: f.home, instance: 'fixture', population: 'managed', probe: () => new Map(), nowUs: () => 1_000_000 });
  stateHost.boot();
  new LifecycleJournal({ file: path.join(f.home, 'agent-lifecycle.json') }).initialize({ priorBoot: false });
  const definitions = new DefinitionStore({ dir: path.join(f.home, 'definitions') });
  await definitions.set('fixture', { id: 'fixture', name: 'Fixture', role: 'worker', harness: 'claude', mode: 'managed',
    workspace: f.home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['claude']) });
  const listing = await definitions.list(), row = listing.definitions[0];
  const ports = createAgentLifecyclePorts({ aifyHome: f.home, machineId: 'fixture', stateHost, runner: f.runner, definitions,
    probe: () => new Map(), installed: async () => new Set(['claude']), buildSpec: async () => f.spec,
    cwdRoots: [f.home], currentCwd: () => f.home });
  return ports.lifecycle.execute({ id: 'boot-cancelled', agentId: 'fixture', machineId: 'fixture', storeId: listing.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: null, action: 'start', requestedBy: 'fixture' });
}

for (const route of ['raw HTTP', 'plugin process port', 'core lifecycle']) {
  test(`the shared Runner boot fence protects the actual ${route} start without per-start options`, async t => {
    const session = new BootSession(); let created = 0, checked = 0;
    const c = child(), f = fixture(t, { assertOpen: () => { checked++; session.assertOpen(); }, spawnProcess: () => {
      created++; queueMicrotask(() => c.emit('spawn')); return c;
    } });
    assert.doesNotThrow(session.assertOpen, 'positive control: the initial session is open'); session.cancel();
    let refused;
    if (route === 'raw HTTP') {
      const answer = await f.post({ service: 'fixture', launcher: '/fixture' }, { platform: 'linux' });
      refused = answer.status === 503 && answer.body.error === 'daemon boot was cancelled';
    } else if (route === 'plugin process port') {
      const port = new PluginProcesses(f.runner, { cwdRoots: [f.home], currentCwd: () => f.home });
      refused = (await failed(port.start(f.spec))).error instanceof BootCancelled;
    } else {
      const answer = await lifecycleStart(f);
      refused = answer.status === 'refused' && answer.outcome === 'daemon boot was cancelled';
    }
    const effects = structuredClone(f.effects()); c.emit('close', 0, null);
    assert.deepEqual({ refused, checked, created, effects }, { refused: true, checked: 1, created: 0, effects: f.untouched });
  });
}

test('a per-start assertion cannot override or disable the Runner-wide boot fence', async t => {
  const session = new BootSession(); session.cancel(); let created = 0;
  const f = fixture(t, { assertOpen: session.assertOpen, spawnProcess: () => { created++; const c = child(); queueMicrotask(() => c.emit('spawn')); return c; } });
  const outcome = await failed(f.runner.start(f.spec, { assertOpen: null }));
  assert.deepEqual({ refused: outcome.error instanceof BootCancelled, created, effects: f.effects() },
    { refused: true, created: 0, effects: f.untouched });
});

test('a thenable Runner-wide guard cannot turn deferred permission into a spawn', async t => {
  let created = 0;
  const f = fixture(t, { assertOpen: () => Promise.resolve(), spawnProcess: () => { created++; const c = child(); queueMicrotask(() => c.emit('spawn')); return c; } });
  const outcome = await failed(f.runner.start(f.spec));
  assert.deepEqual({ error: outcome.error?.name, created, effects: f.effects() }, { error: 'TypeError', created: 0, effects: f.untouched });
});
