import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Runner } from '../lib/runner.mjs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { AgentLifecycle, LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { LifecycleLaunch } from '../lib/plugins/aify-comms/lifecycle-launch.mjs';
import { LifecycleSync } from '../lib/plugins/aify-comms/lifecycle-sync.mjs';
import { createHandleBook } from '../lib/plugins/aify-comms/terminal-controls.mjs';
import { workspaceWithinRoots } from '../lib/workspace-roots.mjs';
import { launcherExitLabel, startExitFailure } from '../lib/launcher-exit.mjs';

const wrapper = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1"\n';
const envId = 'fixture-environment';

async function run(t, when, exitCode = 78) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-exit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  const launcher = path.join(home, 'claude-aify');
  const installed = new Set(['claude']);
  await definitions.set('lead', { name: 'Lead', role: 'coder', harness: 'claude', mode: 'managed',
    workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed });
  const { storeId, definitions: [reading] } = await definitions.list();
  const binding = { storeId, incarnation: reading.incarnation, revision: reading.revision };
  const request = { id: 'request-a', agentId: 'lead', machineId: 'fixture-machine', storeId, expectedIncarnation: reading.incarnation,
    expectedRevision: reading.revision, expectedLifetime: null, action: 'start', requestedBy: 'operator' };
  const host = new AgentStateHost({ aifyHome: home, instance: 'fixture', probe: () => new Map(), nowUs: () => 1_700_000_000_000_000 });
  host.boot();
  const journal = new LifecycleJournal({ file: path.join(home, 'journal.json') });
  journal.initialize({ priorBoot: false });
  const attaches = [], reports = [], frames = [], logs = [];
  let end, acknowledged = false, exited = false;
  const exit = code => {
    if (exited) return;
    exited = true;
    end({ exitCode: code });
  };
  const runner = new Runner({ platform: 'win32', loadCheckpoint: async () => null,
    managedHost: () => ({ host, instance: 'fixture', url: 'http://127.0.0.1:1' }),
    reportManaged: line => logs.push(line),
    openTerminal: () => ({ pid: 71, cols: 80, rows: 24, onData(fn) { fn('fixture launcher output'); },
      onExit(fn) { end = fn; if (when === 'before attach') exit(exitCode); }, write() {}, resize() {} }),
    spawnProcess: () => assert.fail('fixture must never launch a native process'),
  });
  t.after(() => { if (end) exit(0); });
  const identity = id => {
    const reading = host.rawIdentity(id);
    // Observe the actual Runner exit immediately after identity is sampled, before its awaited
    // result can close the journal. A previously read lifetime is not proof the birth survived.
    if (when === 'at result' && acknowledged && reading.current) exit(exitCode);
    return reading;
  };
  const lifecycle = new AgentLifecycle({ definitions, journal, identity, installed: () => installed, machineId: request.machineId,
    buildSpec: () => assert.fail('remote launch did not take the remote adapter'), start: () => assert.fail('unexpected local start') });
  const api = {
    async claimLifecycleRequests() { return { requests: [request] }; },
    async prepareLifecycleLaunch() { return { ok: true, launch: { terminalId: 'terminal', agentId: 'lead', runtime: 'claude-code',
      definition: binding, argv: [launcher], cwd: home, env: {}, herdrSpace: false } }; },
    async reportLifecycleAttachment(_env, _id, _machine, body) {
      attaches.push(body); acknowledged = true; return { ok: true, attachment: body };
    },
    async reportLifecycleRequest(_env, _id, _machine, body) { reports.push(body); },
    async terminalOutput(id, body) { frames.push({ id, ...body }); },
  };
  const handles = createHandleBook();
  const adapter = new LifecycleLaunch({ api, handles, machineId: request.machineId, definitions, identity,
    cwdRoots: () => [home], withinRoots: workspaceWithinRoots, windows: process.platform === 'win32',
    buildSpec: ({ cwd, label, env }) => ({ spec: { service: 'aify-comms', fileText: wrapper, cwd, label, env, command: launcher, args: [] } }),
    resolveCandidates: () => [launcher], processes: new PluginProcesses(runner, { cwdRoots: () => [home] }),
    sender: { send() {}, drained: async () => true, forget() {} },
  });
  const sync = new LifecycleSync({ api, lifecycle, machineId: request.machineId, plugin: adapter });
  assert.equal((await sync.pass(envId)).outcome, 'synced');
  await handles.exitMarkersSettled();
  assert.equal(reports.length, 1, 'one lifecycle report reached the service');
  return { report: reports[0], attaches, frames, logs, runner };
}

for (const when of ['before attach', 'at result']) test(`a Runner exit 78 ${when} fails the start with its code`, async t => {
  const f = await run(t, when);
  assert.deepEqual([f.report.status, f.report.outcome, f.report.resultLifetime],
    ['failed', 'launcher exited during start (code 78)', null], 'the lifecycle result lost the known exit 78');
  assert.equal(f.attaches.length, Number(when === 'at result'));
  assert.deepEqual(f.frames.map(frame => frame.exitCode), [78], 'the terminal exit marker still carries the code');
  assert.equal(f.logs.length, 1, 'one unexpected managed exit notice');
  assert.match(f.logs[0], /code 78/);
  assert.doesNotMatch(f.logs[0], /fixture launcher output/);
});

test('an unrequested exit 0 before attachment is not a successful start', async t => {
  const f = await run(t, 'before attach', 0);
  assert.deepEqual([f.report.status, f.report.outcome], ['failed', 'launcher exited during start (code 0)']);
  assert.deepEqual(f.attaches, []);
  assert.deepEqual(f.frames.map(frame => frame.exitCode), [0]);
  assert.deepEqual(f.logs, [], 'a clean exit does not get an unexpected-exit notice');
});

test('requested stops do not become startup failures and invalid signal text is not reported', () => {
  assert.equal(startExitFailure({ exitFact: () => ({ stopRequested: true, code: 78 }) }), '');
  assert.equal(launcherExitLabel({ code: null, signal: 'SIGTERM' }), 'signal SIGTERM');
  assert.equal(launcherExitLabel({ code: null, signal: 'SIGTERM\nfixture text' }), 'status unavailable');
});

test('a worker which has not exited still reports done and the exact attached lifetime', async t => {
  const f = await run(t, 'living');
  assert.equal(f.report.status, 'done');
  assert.equal(f.report.outcome, 'start');
  assert.equal(f.report.resultLifetime, f.attaches[0].lifetime);
  assert.equal(f.runner.list().length, 1);
  assert.deepEqual(f.frames, []);
  assert.deepEqual(f.logs, []);
});
