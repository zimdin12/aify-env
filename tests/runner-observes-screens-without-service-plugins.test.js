import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { Runner } from '../lib/runner.mjs';
import { handleRequest } from '../lib/protocol.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/handle-book.mjs';
import { carryTerminal } from '../lib/plugins/aify-comms/terminal-controls.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';

const trust = ['❯ No, exit', '  Yes, I trust this folder', '', '  Enter to confirm · Esc to cancel'];
const spec = { service: 'fixture', agentId: 'worker', launcher: '/fixture/claude-aify', command: '/fixture/claude-aify',
  fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"\n', env: {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-screen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const born = Date.now() * 1000;
  const host = new AgentStateHost({ aifyHome: root, instance: 'owner', population: 'managed', nowUs: () => Date.now() * 1000,
    probe: pids => new Map(pids.map(pid => [pid, { alive: true, createdAtUs: born, commandLine: 'claude-aify' }])) });
  host.boot();
  const timers = new Set();
  const screenTimers = { schedule(fn) { timers.add(fn); return fn; }, cancel: fn => timers.delete(fn) };
  let onData, onExit, reads = 0, changes = 0, viewport = null;
  const terminal = { cols: 80, rows: 20, pid: 8192, onData: fn => onData = fn, onExit: fn => onExit = fn };
  const runner = new Runner({ openTerminal: () => terminal, managedHost: () => ({ host, instance: 'owner', url: 'http://127.0.0.1:1' }),
    screenTimers, onScreenChange: () => changes++, loadCheckpoint: async () => () => ({ feed() { viewport = trust; },
      async text() { reads++; return viewport && { rows: viewport }; }, dispose() {} }) });
  const tick = async () => {
    for (const fn of [...timers]) { timers.delete(fn); await fn(); }
  };
  const read = () => handleRequest({ method: 'GET', path: '/agents/state' }, {
    stateHost: host, definitions: { list: async () => ({ definitions: [], unreadable: [] }) },
    observedHarnesses: () => new Set(), lifecycle: { stopFacts: () => new Map() },
    screens: () => runner.screenSightings?.() ?? [],
  });
  return { runner, host, tick, read, output: () => onData('pty'), exit: () => onExit({ exitCode: 0 }),
    counts: () => [reads, changes], pending: () => timers.size };
}

// Exercise RunnerScreens through its owner and the real HTTP route, not a second screen producer.
test('the core sees the bound trust dialog before any service subscribes', async t => {
  const f = fixture(t);
  const started = await f.runner.start(spec);
  assert.equal((await f.read()).body.agents[0].state, 'idle', 'without a screen there is no blocker');
  await f.tick(); // Consume the open-time read before proving that output wakes the observer.
  f.output(); await f.tick();
  const before = (await f.read()).body.agents[0];
  assert.deepEqual([before.state, before.stateCause], ['blocked', 'folder-trust']);
  assert.deepEqual(f.runner.screenSightings().map(({ handle, lifetime }) => [handle, lifetime]), [[started.id, before.lifetime]]);
  assert.deepEqual(f.counts(), [2, 1]);

  const handles = createHandleBook(), reported = [];
  handles.remember('service-terminal', started.id);
  const release = carryTerminal({ processes: new PluginProcesses(f.runner), handles, terminalId: 'service-terminal', handle: started.id,
    api: { async terminalOutput(_, body) { reported.push(body.activity?.rule); } }, log() {},
    sender: { send() {}, async drained() { return true; }, forget() {} } });
  handles.carriedBy('service-terminal', release);
  await f.tick();
  assert.deepEqual(reported, ['folder-trust'], 'late service subscription consumed the existing sighting');
  assert.deepEqual(f.counts(), [3, 1], 'subscription requests one look, not a second evaluator or observation');
  f.output(); f.exit(); await f.tick();
  assert.deepEqual(f.runner.screenSightings(), []);
  assert.equal(f.pending(), 0, 'exit revoked the queued look');
  assert.equal(handles.activityFor('service-terminal'), null);
});

test('a manifest-free launcher cannot turn a lookalike viewport into evidence', async t => {
  const f = fixture(t);
  await f.runner.start({ ...spec, launcher: '/fixture/pi-aify' });
  f.output(); await f.tick();
  assert.deepEqual(f.counts(), [0, 0]);
  assert.equal((await f.read()).body.agents[0].state, 'idle');
});
