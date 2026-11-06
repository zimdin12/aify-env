import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
// R1: replay the original service control after its first child has exited and the terminal was reused.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Runner } from '../lib/runner.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/handle-book.mjs';
import { runOneControl } from '../lib/plugins/aify-comms/terminal-controls.mjs';

test('replayed Stop stays bound to H1 after the same terminal starts H2', async () => {
  const effects = [], reports = [];
  const children = [424241, 424242].map(pid => {
    const child = new EventEmitter();
    Object.assign(child, { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} },
      kill: () => effects.push(['console', pid]) });
    return child;
  });
  let next = 0;
  const runner = new Runner({ openTerminal: null, loadCheckpoint: null, ownedFile: null,
    spawnProcess: () => spawnedPipe(children[next++]), isAlive: () => true, stopExitWaitMs: 1,
    killTree: async pid => { effects.push(['tree', pid]); } });
  const spec = { service: 'fixture', command: 'fixture', env: {}, fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"' };
  const handles = createHandleBook(), processes = new PluginProcesses(runner);
  const api = { reportControl: async (id, patch) => reports.push({ id, ...patch }) };
  const stop = () => runOneControl({ control: { id: 'C', terminalId: 'T', action: 'stop' }, api, processes, handles });
  const h1 = await runner.start(spec);
  handles.remember('T', h1.id);
  assert.equal((await stop()).outcome, 'failed', 'control: H1 survives its first attempt');
  assert.deepEqual(effects, [['console', 424241], ['tree', 424241]]);
  children[0].emit('close', null, 'SIGTERM');
  handles.forget('T');
  const h2 = await runner.start(spec);
  handles.remember('T', h2.id);
  reports.length = 0;
  const replay = await stop();
  assert.deepEqual(effects, [['console', 424241], ['tree', 424241]], 'replay must make no kill attempt against H2');
  assert.equal(replay.outcome, 'failed');
  assert.match(replay.detail, /lifetime changed/);
  assert.equal(handles.handleFor('T'), h2.id, 'replacement binding is retained');
  assert.equal(runner.list()[0]?.id, h2.id, 'replacement process remains tracked');
  assert.equal(reports.some(row => row.terminalStatus === 'stopped'), false);
  children[1].emit('close', null, 'SIGTERM');
});
