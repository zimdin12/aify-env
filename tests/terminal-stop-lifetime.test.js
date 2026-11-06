import { spawnedPipe } from './fixtures/spawned-pipe.mjs';
// Stop uses real Runner -> PluginProcesses -> terminal-control composition, with no OS child or live service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { Runner } from '../lib/runner.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/handle-book.mjs';
import { runOneControl } from '../lib/plugins/aify-comms/terminal-controls.mjs';
import { readOwned } from '../lib/owned-processes.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { RunnerStop } from '../lib/runner-stop.mjs';
import { createShutdown } from '../lib/shutdown.mjs';

async function fixture(t, { after = true, close = false, treeThrows = false } = {}) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'terminal-stop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = new AgentStateHost({ aifyHome: home, instance: 'fixture', population: 'managed',
    probe: () => { throw Error('no resident probe'); }, nowUs: () => Date.now() * 1000 });
  host.boot();
  const effects = [], reports = [];
  let killed = false;
  const child = new EventEmitter();
  child.pid = 424242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {} };
  child.kill = () => { effects.push('console'); killed = true; if (close) child.emit('close', null, 'SIGTERM'); };
  const ownedFile = path.join(home, 'owned.json');
  const runner = new Runner({ openTerminal: null, spawnProcess: () => spawnedPipe(child), loadCheckpoint: null, ownedFile, stopExitWaitMs: 5,
    managedHost: () => ({ host, instance: 'fixture', url: 'http://127.0.0.1:12345' }),
    isAlive: () => { if (!killed) return true; if (after === 'throws') throw Error('probe unavailable'); return after; },
    killTree: async () => { effects.push('tree'); if (treeThrows) throw Error('tree kill uncertain'); } });
  const handle = await runner.start({ agentId: 'a', service: 'fixture', command: 'fixture', env: {},
    fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"' });
  child.stdout.emit('data', 'before stop');
  const handles = createHandleBook();
  handles.remember('term', handle.id);
  const processes = new PluginProcesses(runner);
  const api = { reportControl: async (id, patch) => { reports.push({ id, ...patch }); } };
  const control = (id = 'ctl') => runOneControl({ control: { id, terminalId: 'term', action: 'stop' }, api, handles, processes });
  return { home, runner, host, child, handle, ownedFile, effects, reports, handles, processes, api, control };
}

for (const [name, after] of [['surviving', true], ['unanswered', null], ['unreadable', 'throws']]) {
  test(`a ${name} stop retains custody and never reports terminal stopped`, async t => {
    const f = await fixture(t, { after });
    const before = f.host.rawIdentity('a');
    const answer = await f.control();
    assert.equal(answer.outcome, 'failed', 'a returned kill is not completion');
    assert.match(answer.detail, /execution-unknown/);
    assert.equal(f.reports.some(r => r.terminalStatus === 'stopped'), false);
    assert.equal(f.handles.handleFor('term'), f.handle.id, 'unverified terminal handle retained');
    assert.equal(f.runner.list()[0]?.id, f.handle.id, 'surviving process remains listed');
    assert.equal(readOwned(f.ownedFile)[0]?.id, f.handle.id, 'durable ownership remains');
    assert.equal(f.runner.canStream(f.handle.id), true, 'stream remains usable after uncertain stop');
    assert.deepEqual(f.host.rawIdentity('a'), before);
    childOutput(f);
    await f.control();
    assert.deepEqual(f.effects, ['console', 'tree'], 'replay does not blindly repeat the kill');
    f.child.emit('close', null, 'SIGTERM');
    assert.equal(f.host.rawIdentity('a').current, null, 'later matching exit retires the retained lifetime');
    assert.deepEqual(f.runner.list(), []);
    assert.deepEqual(readOwned(f.ownedFile), []);
  });
}
function childOutput(f) {
  const chunks = [];
  const unsubscribe = f.runner.subscribe(f.handle.id, text => chunks.push(text));
  f.child.stdout.emit('data', 'after stop');
  assert.deepEqual(chunks, ['before stop', 'after stop']);
  unsubscribe();
}

for (const [name, options] of [['matching observed exit despite live PID', { close: true, after: true }],
  ['strict-false death without an exit event', { after: false }]]) {
  test(`${name} permits terminal stopped and releases custody`, async t => {
    const f = await fixture(t, options);
    const answer = await f.control();
    assert.equal(answer.outcome, 'completed');
    assert.equal(f.reports.at(-1).terminalStatus, 'stopped');
    assert.equal(f.handles.handleFor('term'), '');
    assert.deepEqual(f.runner.list(), []);
    assert.deepEqual(readOwned(f.ownedFile), []);
    assert.equal(f.host.rawIdentity('a').current, null);
    assert.deepEqual(f.effects, ['console', 'tree']);
  });
}

test('a throwing kill retains custody and a replay does not issue it again', async t => {
  const f = await fixture(t, { treeThrows: true });
  assert.equal((await f.control()).outcome, 'failed');
  assert.equal((await f.control()).outcome, 'failed');
  assert.deepEqual(f.effects, ['console', 'tree']);
  assert.equal(f.runner.list()[0]?.id, f.handle.id);
  assert.equal(f.handles.handleFor('term'), f.handle.id);
});

test('a fresh explicit lifecycle Kill escalates after Stop but its replay does not', async t => {
  const f = await fixture(t);
  assert.equal((await f.control()).outcome, 'failed');
  await f.control();
  assert.deepEqual(f.effects, ['console', 'tree'], 'same terminal control did not retry');
  const definitions = new DefinitionStore({ dir: path.join(f.home, 'definitions') });
  await definitions.set('a', { name: 'A', role: 'worker', harness: 'hermes', mode: 'managed', workspace: f.home,
    model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['hermes']) });
  const listed = await definitions.list(), row = listed.definitions[0];
  const ports = createAgentLifecyclePorts({ aifyHome: f.home, machineId: 'm', stateHost: f.host, runner: f.runner,
    definitions, isAlive: () => true, settleMs: 0, installed: async () => new Set(['hermes']) });
  // Initialize the private journal as daemon boot does; no live daemon is started.
  fs.writeFileSync(path.join(f.home, 'agent-lifecycle.json'), JSON.stringify({ version: 1, records: {}, stops: {} }));
  const request = { id: 'new-explicit-kill', agentId: 'a', machineId: 'm', storeId: listed.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: f.host.rawIdentity('a').current.lifetime,
    action: 'kill', requestedBy: 'dashboard' };
  const answer = await ports.lifecycle.execute(request);
  assert.equal(answer.outcome, 'execution-unknown', 'survivor is still not claimed dead');
  assert.deepEqual(f.effects, ['console', 'tree', 'console', 'tree'], 'new explicit Kill must attempt again');
  assert.deepEqual(await ports.lifecycle.execute(request), answer);
  assert.deepEqual(f.effects, ['console', 'tree', 'console', 'tree'], 'lifecycle journal fences Kill replay');
});

test('an error from a live child is not an exit or permission to forget it', async t => {
  const f = await fixture(t);
  const kill = f.child.kill;
  f.child.kill = () => { kill(); f.child.emit('error', new Error('refused operation, not death')); };
  const answer = await f.control();
  assert.equal(answer.outcome, 'failed');
  assert.equal(f.runner.list()[0]?.id, f.handle.id);
  assert.equal(f.runner.canStream(f.handle.id), true);
  assert.equal(f.handles.handleFor('term'), f.handle.id);
  assert.equal(f.reports.some(r => r.terminalStatus === 'stopped'), false);
  await f.control();
  assert.deepEqual(f.effects, ['console', 'tree']);
  f.child.emit('close', 1, '');
  assert.equal(f.host.rawIdentity('a').current, null);
});

test('RunnerStop coalesces the same control while its tree kill is pending', async () => {
  let release, effects = 0;
  const tree = new Promise(resolve => { release = resolve; });
  const stop = new RunnerStop({ child: { pid: 424242, kill: () => { effects++; } },
    exit: new Promise(() => {}), ended: () => false,
    io: { isAlive: () => true, killTree: () => tree, exitWaitMs: 0 } });
  const first = stop.run({ requestId: 'one' });
  assert.equal(effects, 1, 'stop must enter synchronously so shutdown names the currently blocking child');
  assert.equal(stop.run({ requestId: 'one' }), first, 'in-flight replay must be the exact same attempt');
  assert.equal(effects, 1, 'in-flight replay makes no second kill');
  release();
  assert.equal((await first).stopped, false);
});

for (const treeThrows of [false, true]) test(`shutdown retains ownership after ${treeThrows ? 'throwing' : 'surviving'} stop`, async t => {
  const f = await fixture(t, { treeThrows });
  let cleared = 0, exited = 0;
  const lines = [];
  await createShutdown({ runner: f.runner, closeServer: () => {}, write: text => lines.push(text),
    clearOwned: () => { cleared++; fs.writeFileSync(f.ownedFile, '[]'); }, exit: () => { exited++; } })('fixture');
  assert.equal(exited, 1, 'an unverified stop does not wedge teardown');
  assert.equal(cleared, 0, 'an attempted kill is not permission to erase surviving ownership');
  assert.equal(readOwned(f.ownedFile)[0]?.id, f.handle.id);
  assert.ok(lines.some(line => line.includes('KEEPING the owned record')));
});

test('an absent stop verdict is not terminal completion', async t => {
  const f = await fixture(t);
  f.processes.stop = async () => undefined;
  const answer = await f.control();
  assert.equal(answer.outcome, 'failed');
  assert.match(answer.detail, /execution-unknown/);
  assert.equal(f.handles.handleFor('term'), f.handle.id);
  assert.equal(f.reports.some(r => r.terminalStatus === 'stopped'), false);
});

test('a terminal handle replaced during stop is neither forgotten nor reported stopped', async t => {
  const f = await fixture(t, { close: true });
  const kill = f.child.kill;
  f.child.kill = () => { f.handles.remember('term', 'replacement-handle'); kill(); };
  const answer = await f.control();
  assert.equal(answer.outcome, 'failed');
  assert.match(answer.detail, /lifetime changed/);
  assert.equal(f.handles.handleFor('term'), 'replacement-handle');
  assert.equal(f.reports.some(r => r.terminalStatus === 'stopped'), false);
});
