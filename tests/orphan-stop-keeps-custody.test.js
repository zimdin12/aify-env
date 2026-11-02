// R2: exercise orphan cleanup through the ordinary control pass, independently for ended rows and 404.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Runner } from '../lib/runner.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/handle-book.mjs';
import { ORPHAN_QUIET_MS, runTerminalControlPass } from '../lib/plugins/aify-comms/terminal-controls.mjs';

async function fixture(route, outcome) {
  const effects = [], calls = [], logs = [];
  const child = new EventEmitter();
  Object.assign(child, { pid: 424242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} } });
  const handles = createHandleBook();
  child.kill = () => {
    effects.push('console');
    if (outcome === 'replacement') handles.remember('T', 'replacement-handle');
    if (outcome === 'verified' || outcome === 'replacement') child.emit('close', null, 'SIGTERM');
  };
  const runner = new Runner({ openTerminal: null, loadCheckpoint: null, ownedFile: null,
    spawnProcess: () => child, isAlive: () => true, stopExitWaitMs: 1,
    killTree: async () => { effects.push('tree'); if (outcome === 'rejected') throw Error('uncertain tree kill'); } });
  const handle = await runner.start({ service: 'fixture', command: 'fixture', env: {},
    fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"' });
  handles.remember('T', handle.id, '', 1);
  const processes = new PluginProcesses(runner), stop = processes.stop.bind(processes);
  processes.stop = (id, options) => {
    calls.push({ id, requestId: options?.requestId });
    if (outcome === 'missing') return Promise.resolve(undefined);
    if (outcome === 'throws') throw Error('synchronous refusal');
    return stop(id, options);
  };
  let heartbeats = 0;
  const api = { claimControls: async () => ({ controls: [] }), terminalOutput: async () => {
    heartbeats++;
    if (route === '404') throw Object.assign(new Error('gone'), { status: 404 });
    return { terminal: { status: 'ended' } };
  } };
  const pass = () => runTerminalControlPass({ api, processes, handles, environmentId: 'fixture',
    now: () => ORPHAN_QUIET_MS + 2, log: text => logs.push(text) });
  return { effects, calls, logs, handles, runner, child, handle, pass, heartbeats: () => heartbeats };
}

for (const route of ['ended', '404']) {
  for (const outcome of ['surviving', 'missing', 'throws', 'rejected']) {
    test(`${route} orphan with ${outcome} proof keeps its binding across passes`, async () => {
      const f = await fixture(route, outcome);
      await f.pass();
      assert.equal(f.handles.handleFor('T'), f.handle.id, 'unverified orphan retains the original binding');
      assert.equal(f.runner.list()[0]?.id, f.handle.id, 'underlying held child remains tracked');
      await f.pass();
      assert.equal(f.heartbeats(), 2, 'both ordinary passes really reached the orphan condition');
      assert.equal(f.calls.length, 2, 'same attempted cleanup is addressed on both passes');
      assert.deepEqual(f.effects, ['surviving', 'rejected'].includes(outcome) ? ['console', 'tree'] : [], 'per-pass cleanup must not re-kill');
      assert.equal(typeof f.calls[0].requestId, 'string', 'a stable orphan attempt id is required');
      assert.ok(f.calls[0].requestId);
      assert.equal(f.calls[1].requestId, f.calls[0].requestId, 'stable id suppresses another physical kill');
      assert.ok(f.logs.some(line => line.includes('stop-unverified')));
      f.child.emit('close', null, 'SIGTERM');
    });
  }
  test(`${route} orphan with verified death forgets only its matching handle`, async () => {
    const f = await fixture(route, 'verified');
    await f.pass();
    assert.equal(f.handles.handleFor('T'), '');
    assert.deepEqual(f.runner.list(), []);
    assert.deepEqual(f.effects, ['console', 'tree'], 'healthy control really attempted the kill');
    await f.pass();
    assert.equal(f.calls.length, 1);
  });
  test(`${route} orphan proof never forgets a replacement binding`, async () => {
    const f = await fixture(route, 'replacement');
    await f.pass();
    assert.equal(f.handles.handleFor('T'), 'replacement-handle');
    assert.deepEqual(f.effects, ['console', 'tree']);
  });
}
