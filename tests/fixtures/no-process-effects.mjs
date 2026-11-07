// Test-process boundary: decision/guard mutants may never escape their injected process effects.
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { after, afterEach, mock } from 'node:test';

export class ProcessEffectTripwire {
  #calls = [];
  constructor() {
    const blocked = name => (...args) => {
      // Never retain argument values: a missed helper injection could otherwise print inherited credentials.
      this.#calls.push({ name, argumentCount: args.length });
      throw Error(`real process IO forbidden: ${name}`);
    };
    mock.method(process, 'kill', blocked('process.kill'));
    const childProcess = createRequire(import.meta.url)('node:child_process');
    for (const name of ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']) mock.method(childProcess, name, blocked(name));
    syncBuiltinESMExports();
    assert.ok(childProcess.spawn.mock, 'native effect instrumentation must actually be installed');
    afterEach(() => assert.deepEqual(this.#calls, [], 'no test or mutant may reach a native process effect'));
    after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  }
}
