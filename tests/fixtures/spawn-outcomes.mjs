import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createDaemonHttp } from '../../lib/daemon-http.mjs';
import { Runner } from '../../lib/runner.mjs';
import { SpawnFailure } from '../../lib/piped-spawn.mjs';
import { ProcessRegistry } from '../../lib/process-registry.mjs';
import { handleRequest } from '../../lib/protocol.mjs';

export const ALLOWED = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1.0"\n';
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const child = (pid = 4242) => Object.assign(new EventEmitter(), { pid,
  stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} }, kill() {} });
export const failed = async promise => { try { return { value: await promise, error: null }; } catch (error) { return { value: null, error }; } };
export const diagnostic = outcome => ({ name: outcome.error instanceof SpawnFailure ? outcome.error.name : null, code: outcome.error?.code ?? null, message: outcome.error?.message ?? null });

export async function httpPost(t, f, body, deps) {
  const server = createServer(createDaemonHttp({ runner: f.runner, traffic: { requests: 0, bytesOut: 0 },
    protocolDeps: async () => ({ runner: f.runner, ...deps }) }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/processes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

export function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-outcomes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ownedFile = path.join(home, 'owned.json'), observations = [], writes = [], births = [], ends = [];
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function(file, bytes, ...args) {
    if (String(file) === ownedFile) writes.push(JSON.parse(String(bytes)));
    return original.call(this, file, bytes, ...args);
  });
  const registry = new ProcessRegistry({ onChange: () => observations.push(registry.list()) });
  const host = { startManaged: record => births.push(structuredClone(record)), endManaged: lifetime => { ends.push(lifetime); return {}; } };
  const runner = new Runner({ openTerminal: null, registry, ownedFile, loadCheckpoint: null,
    managedHost: () => ({ host, instance: 'fixture', url: 'http://127.0.0.1:18802' }), ...options });
  const spec = { service: 'fixture', command: path.join(home, 'missing-command'), fileText: ALLOWED, args: [], agentId: 'fixture' };
  const effects = () => ({ observations, writes, births, current: registry.list(), fileExists: fs.existsSync(ownedFile) });
  const untouched = { observations: [], writes: [], births: [], current: [], fileExists: false };
  const post = (body, deps = {}) => handleRequest({ method: 'POST', path: '/processes', body }, { runner, readFile: () => ALLOWED, ...deps });
  return { home, ownedFile, runner, registry, spec, observations, writes, births, ends, effects, untouched, post };
}
