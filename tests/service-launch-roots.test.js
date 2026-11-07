// Core service boundaries are not covered by the existing comms-only roots/wait tests.
// All effects are fake; this file can be selected for isolated guard mutants, never native qualification.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { PluginProcesses } from '../lib/service-plugins.mjs';
import { Runner } from '../lib/runner.mjs';
import { handleRequest } from '../lib/protocol.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();
import { ServiceLaunchPolicy, LaunchRootRefusal } from '../lib/service-launch-policy.mjs';
const ALLOWED = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1.0"\n';
const spec = (cwd = 'C:/work/project') => ({ service: 'fixture', command: 'fixture-worker', fileText: ALLOWED, args: [], env: {}, cwd });
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const outcome = promise => promise.then(value => ({ value, error: null }), error => ({ value: null, error }));
function policy(options = {}) {
  assert.equal(typeof ServiceLaunchPolicy, 'function', 'core owns the service launch policy');
  return new ServiceLaunchPolicy({ roots: ['C:/work'], windows: true, cwd: () => 'C:/work/default', ...options });
}
function recordingRunner() {
  const starts = [];
  return { starts, start: async (value, options) => { starts.push({ value, options }); return { id: 'fixture-handle', pid: 424242 }; } };
}
function terminalRunner({ loadCheckpoint = null } = {}) {
  const spawns = [];
  const terminal = { pid: 424242, cols: 80, rows: 24, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const runner = new Runner({ platform: 'win32', loadCheckpoint,
    openTerminal: (command, args, options) => { spawns.push({ command, args, options }); return terminal; } });
  return { runner, spawns };
}
const typed = error => error instanceof LaunchRootRefusal && error.code === 'LAUNCH_ROOTS_REFUSED';

for (const [name, marker, endField] of [
  ['plugin assembly', 'startDaemonPlugins({', 'credential:'],
  ['core lifecycle', 'createAgentLifecyclePorts({', 'installed:'],
]) test(`the actual daemon ${name} payload supplies live host roots and host platform`, () => {
  // Importing the entry starts a daemon. Read its actual bounded payload prefix instead.
  const source = fs.readFileSync(new URL('../bin/aify-env.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf(marker), end = source.indexOf(endField, begin);
  assert.ok(begin > 0 && end > begin, 'the known payload and following field both exist');
  const payload = source.slice(begin, end);
  assert.match(payload, /cwdRoots:\s*\(\)\s*=>\s*LAUNCH_ROOTS\.current\(\)/, 'authority is the host live supplier, never a captured array or service request');
  assert.match(payload, /windows:\s*process\.platform\s*===\s*['"]win32['"]/, 'the host platform selects lexical semantics');
});

test('a generic plugin outside host roots refuses before its runner or post-start decoration', async () => {
  const runner = recordingRunner(); let decorated = 0;
  const processes = new PluginProcesses(runner, { cwdRoots: ['C:/work'], windows: true, onStarted: () => { decorated++; } });
  const answer = await outcome(processes.start(spec('D:/outside')));
  assert.deepEqual({ typed: typed(answer.error), starts: runner.starts.length, decorated }, { typed: true, starts: 0, decorated: 0 });
  assert.match(answer.error.message, /D:\/outside/);
});
test('the same plugin admits a granted start and carries its late admission port', async () => {
  const runner = recordingRunner(); let decorated = 0;
  const processes = new PluginProcesses(runner, { cwdRoots: ['C:/work'], windows: true, onStarted: () => { decorated++; } });
  const answer = await outcome(processes.start(spec()));
  assert.equal(answer.error === null, true); assert.equal(decorated, 1); assert.equal(runner.starts.length, 1);
  assert.equal(typeof runner.starts[0].options?.admitSpawn, 'function');
});
test('a missing host grant source fails closed rather than silently authorizing a plugin', async () => {
  const runner = recordingRunner();
  const answer = await outcome(new PluginProcesses(runner).start(spec()));
  assert.deepEqual({ typed: typed(answer.error), starts: runner.starts.length }, { typed: true, starts: 0 });
});
for (const roots of [null, 'C:/work', () => { throw Error('unreadable'); }]) test(`unanswerable roots ${typeof roots} grant no start`, async () => {
  const runner = recordingRunner();
  const answer = await outcome(policy({ roots }).start(runner, spec()));
  assert.deepEqual({ typed: typed(answer.error), starts: runner.starts.length }, { typed: true, starts: 0 });
});
test('policy uses the existing Windows slash/case contract without resolving dot segments', async () => {
  const p = policy(), runner = recordingRunner();
  const healthy = await outcome(p.start(runner, spec('c:/WORK/child')));
  assert.equal(healthy.error === null, true, 'the Windows case-folded healthy start is admitted');
  const denied = await outcome(p.start(runner, spec('C:/work/../elsewhere')));
  assert.deepEqual({ typed: typed(denied.error), starts: runner.starts.length }, { typed: true, starts: 1 });
});
test('policy never folds POSIX case into an allowed workspace', async () => {
  const p = policy({ roots: ['/work/Bob'], windows: false }), runner = recordingRunner();
  const healthy = await outcome(p.start(runner, spec('/work/Bob/child')));
  assert.equal(healthy.error === null, true, 'the POSIX exact-case healthy start is admitted');
  const denied = await outcome(p.start(runner, spec('/work/bob/child')));
  assert.deepEqual({ typed: typed(denied.error), starts: runner.starts.length }, { typed: true, starts: 1 });
});
test('a root removed during the actual Runner checkpoint wait starts nothing', async () => {
  let roots = ['C:/work']; const entered = defer(), held = defer();
  const f = terminalRunner({ loadCheckpoint: async () => { entered.resolve(); await held.promise; return null; } });
  const processes = new PluginProcesses(f.runner, { cwdRoots: () => roots, windows: true });
  const pending = outcome(processes.start(spec()));
  await entered.promise; roots = []; held.resolve();
  const answer = await pending;
  assert.deepEqual({ typed: typed(answer.error), spawns: f.spawns.length, records: f.runner.list().length }, { typed: true, spawns: 0, records: 0 });
});
test('an unchanged root starts through the same checkpoint wait with command identity intact', async () => {
  const entered = defer(), held = defer();
  const f = terminalRunner({ loadCheckpoint: async () => { entered.resolve(); await held.promise; return null; } });
  const pending = outcome(new PluginProcesses(f.runner, { cwdRoots: ['C:/work'], windows: true }).start(spec()));
  await entered.promise; held.resolve(); const answer = await pending;
  assert.equal(answer.error === null, true); assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0].command, 'fixture-worker'); assert.deepEqual(f.spawns[0].args, []); assert.equal(f.spawns[0].options.cwd, 'C:/work/project');
});
test('omitted cwd is read after final waits and the exact checked folder reaches spawn', async () => {
  let cwd = 'C:/work/early'; const entered = defer(), held = defer();
  const f = terminalRunner({ loadCheckpoint: async () => { entered.resolve(); await held.promise; return null; } });
  const missing = spec(); delete missing.cwd;
  const pending = outcome(new PluginProcesses(f.runner, { cwdRoots: ['C:/work'], windows: true, currentCwd: () => cwd }).start(missing));
  await entered.promise; cwd = 'C:/work/late'; held.resolve(); const answer = await pending;
  assert.equal(answer.error === null, true); assert.equal(f.spawns[0].options.cwd, 'C:/work/late');
  assert.equal(Object.hasOwn(missing, 'cwd'), false, 'admission never mutates the caller spec');
});
test('an omitted cwd moved outside roots during checkpoint waiting refuses without spawn', async () => {
  let cwd = 'C:/work/early'; const entered = defer(), held = defer();
  const f = terminalRunner({ loadCheckpoint: async () => { entered.resolve(); await held.promise; return null; } });
  const missing = spec(); delete missing.cwd;
  const pending = outcome(new PluginProcesses(f.runner, { cwdRoots: ['C:/work'], windows: true, currentCwd: () => cwd }).start(missing));
  await entered.promise; cwd = 'D:/outside'; held.resolve(); const answer = await pending;
  assert.deepEqual({ typed: typed(answer.error), spawns: f.spawns.length }, { typed: true, spawns: 0 });
});
test('omitted cwd is sampled after the final roots supplier await', async () => {
  let cwd = 'C:/work/early', asks = 0; const entered = defer(), held = defer();
  const f = terminalRunner(), missing = spec(); delete missing.cwd;
  const roots = async () => { if (++asks === 2) { entered.resolve(); await held.promise; } return ['C:/work']; };
  const pending = outcome(new PluginProcesses(f.runner, { cwdRoots: roots, windows: true, currentCwd: () => cwd }).start(missing));
  await entered.promise; cwd = 'D:/outside'; held.resolve(); const answer = await pending;
  assert.deepEqual({ typed: typed(answer.error), spawns: f.spawns.length }, { typed: true, spawns: 0 });
});

for (const [name, value] of [['object', { cwd: 'C:/work', command: 'replacement' }], ['empty', '']]) test(`late admission ${name} result cannot start or replace the judged command`, async () => {
  const f = terminalRunner();
  const answer = await outcome(f.runner.start(spec(), { admitSpawn: async () => value }));
  assert.deepEqual({ typeError: answer.error instanceof TypeError, spawns: f.spawns.length, records: f.runner.list().length }, { typeError: true, spawns: 0, records: 0 });
});
test('a failed fallback cwd read is a typed no-spawn refusal', async () => {
  const runner = recordingRunner(), missing = spec(); delete missing.cwd;
  const answer = await outcome(policy({ cwd: () => { throw Error('folder unavailable'); } }).start(runner, missing));
  assert.deepEqual({ typed: typed(answer.error), starts: runner.starts.length }, { typed: true, starts: 0 });
});
test('late admission receives only cwd and preserves the judged command and caller spec', async () => {
  const f = terminalRunner(), original = spec(); let seen;
  const answer = await outcome(f.runner.start(original, { admitSpawn: async value => { seen = value; return 'C:/work/checked'; } }));
  assert.equal(answer.error === null, true); assert.equal(seen, 'C:/work/project');
  assert.deepEqual({ command: f.spawns[0].command, cwd: f.spawns[0].options.cwd, callerCwd: original.cwd },
    { command: 'fixture-worker', cwd: 'C:/work/checked', callerCwd: 'C:/work/project' });
});

test('raw Runner without service admission stays unbounded', async () => {
  const f = terminalRunner(); const answer = await outcome(f.runner.start(spec('D:/outside')));
  assert.equal(answer.error === null, true); assert.equal(f.spawns.length, 1); assert.equal(f.spawns[0].options.cwd, 'D:/outside');
});
test('local POST outside roots remains operator-controlled and never consults service policy', async () => {
  const runner = recordingRunner(); let rootAsks = 0;
  const answer = await handleRequest({ method: 'POST', path: '/processes', body: { service: 'fixture', launcher: '/fixture/worker', cwd: '/outside' } },
    { runner, platform: 'linux', readFile: () => ALLOWED, cwdRoots: () => { rootAsks++; throw Error('operator route is exempt'); } });
  assert.equal(answer.status, 201); assert.equal(rootAsks, 0); assert.equal(runner.starts[0].value.cwd, '/outside');
});
