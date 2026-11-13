// Loading an optional native module is not opening a terminal. Both paths stay inside injected process effects.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, mock, test } from 'node:test';
import { Runner, terminalSupport, useConptyDll } from '../lib/runner.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { spawnedPipe } from './fixtures/spawned-pipe.mjs';

new ProcessEffectTripwire();
const moduleApi = process.getBuiltinModule('module');
const originalRequire = moduleApi.createRequire;
let current;
// Fence even the old, uninjected default path: no test can load or spawn the host's real node-pty.
mock.method(moduleApi, 'createRequire', url => {
  const real = originalRequire(url);
  const load = name => {
    if (name !== 'node-pty') return real(name);
    assert.ok(current, 'a default terminal load must have an owned fixture');
    current.defaultLoads++;
    return current.module();
  };
  load.resolve = name => {
    if (name !== 'node-pty') return real.resolve(name);
    if (current.mode === 'missing') throw current.error;
    return '/fixture/node-pty/index.js';
  };
  return load;
});
afterEach(() => { current = null; });

function fixture(mode) {
  const pipe = Object.assign(new EventEmitter(), { pid: 424242, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let exitTerminal;
  const terminal = { pid: 424242, write() {}, resize() {},
    onData: () => ({ dispose() {} }),
    onExit: callback => { exitTerminal = callback; return { dispose() {} }; },
    kill: () => assert.fail('no fake terminal kill is requested'),
  };
  const f = { mode, pipe, terminal, suppliedLoads: 0, defaultLoads: 0, pipes: 0, terminals: 0, options: null,
    error: Object.assign(new Error(mode === 'missing' ? 'fixture package absent' : 'fixture native binding failed'),
      { code: mode === 'missing' ? 'MODULE_NOT_FOUND' : 'ERR_DLOPEN_FAILED' }),
    module() {
      if (mode !== 'healthy') throw f.error;
      return { spawn: (command, args, options) => { f.terminals++; f.options = options; return terminal; } };
    },
    close(isTerminal) {
      if (isTerminal) exitTerminal({ exitCode: 0 });
      else { pipe.stdout.end(); pipe.stderr.end(); pipe.emit('exit', 0, null); pipe.emit('close', 0, null); }
    },
  };
  f.load = name => { assert.equal(name, 'node-pty'); f.suppliedLoads++; return f.module(); };
  // A package can resolve while its binding cannot load. This catches a regression to resolve-only admission.
  f.load.resolve = () => { if (mode === 'missing') throw f.error; return '/fixture/node-pty/index.js'; };
  current = f;
  return f;
}

for (const mode of ['missing', 'native-error', 'healthy']) {
  test(`terminal support distinguishes ${mode} through the injected loader`, () => {
    const f = fixture(mode);
    let support;
    assert.doesNotThrow(() => { support = terminalSupport(f.load); }, 'optional module loading must be contained by the support check');
    assert.equal(support.available, mode === 'healthy');
    if (mode === 'healthy') {
      assert.equal(support.reason, '');
      assert.deepEqual(Object.keys(support).sort(), ['available', 'conptyDll', 'reason']);
    } else {
      assert.equal(support.reason, `node-pty did not load: ${f.error.code}`);
    }
    assert.ok(f.suppliedLoads + f.defaultLoads <= 1, 'a support check must not load a binding twice');
  });
}

const spec = { service: 'fixture', command: '/fixture/launcher', args: [], cwd: '/fixture', env: { FIXTURE: 'yes' },
  fileText: '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1"\n', cols: 87, rows: 21 };
function ports(f) {
  return { terminalLoader: f.load, platform: 'win32', ownedFile: null, loadCheckpoint: null,
    processIdentity: { captureChild: () => null },
    spawnProcess: () => { f.pipes++; return spawnedPipe(f.pipe); },
    isAlive: () => false, killTree: async () => assert.fail('no tree ending is requested'),
  };
}

for (const mode of ['missing', 'native-error', 'healthy']) {
  test(`default Runner construction and start preserve ${mode === 'healthy' ? 'PTY' : 'piped fallback'} for ${mode}`, async () => {
    const f = fixture(mode);
    let runner;
    assert.doesNotThrow(() => { runner = new Runner(ports(f)); }, 'an optional binding failure must not abort construction');
    let handle, error;
    try { handle = await runner.start(spec); } catch (caught) { error = caught; }
    assert.equal(error?.name ?? null, null, 'the guarded loader must still produce a usable execution path');
    assert.equal(handle.terminal, mode === 'healthy');
    assert.equal(f.terminals, mode === 'healthy' ? 1 : 0);
    assert.equal(f.pipes, mode === 'healthy' ? 0 : 1);
    assert.ok(f.suppliedLoads + f.defaultLoads <= 1, 'the factory must reuse its successful module load');
    if (mode === 'healthy') assert.deepEqual(f.options, { name: 'xterm-color', cols: 87, rows: 21,
      cwd: '/fixture', env: { FIXTURE: 'yes' }, useConptyDll: useConptyDll() });
    f.close(handle.terminal);
    await handle.exited;
    assert.equal(runner.list().length, 0);
  });
}

for (const isTerminal of [false, true]) {
  test(`explicit openTerminal ${isTerminal ? 'factory' : 'null'} bypasses optional module loading`, async () => {
    const f = fixture('native-error');
    const runner = new Runner({ ...ports(f), openTerminal: isTerminal ? () => f.terminal : null });
    const handle = await runner.start(spec);
    assert.equal(handle.terminal, isTerminal);
    assert.equal(f.suppliedLoads + f.defaultLoads, 0, 'an explicit override must not touch the optional binding');
    f.close(isTerminal);
    await handle.exited;
  });
}
