// A private native counterexample: listener exclusivity versus an unfinished lifecycle operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { bootDaemonAgentState } from '../../../lib/daemon-agent-state.mjs';
import { createAgentLifecyclePorts } from '../../../lib/daemon-agent-lifecycle.mjs';
import { DefinitionStore } from '../../../lib/agent-definitions.mjs';
import { createShutdown } from '../../../lib/shutdown.mjs';

async function drainingOwner() {
  const home = process.env.OWNER_PROBE_HOME;
  const definitions = new DefinitionStore({ dir: path.join(home, 'definitions') });
  await definitions.set('a', { name: 'Fixture', role: 'worker', harness: 'hermes', mode: 'managed',
    workspace: home, model: '', effort: '', instructions: '', env: {}, herdrSpace: false },
  { installed: new Set(['hermes']) });
  const server = http.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const booted = bootDaemonAgentState({ aifyHome: home, url, exclusiveLifecycleScope: true });
  const listing = await definitions.list(), row = listing.definitions[0];
  const ports = createAgentLifecyclePorts({ aifyHome: home, owner: booted.lifecycleOwner, machineId: 'fixture',
    definitions, stateHost: { rawIdentity: () => ({ current: null, conflict: false, unknown: false }) }, runner: {},
    buildSpec: async () => { process.send({ event: 'held', url, owner: booted.lifecycleOwner }); await new Promise(() => {}); },
  });
  void ports.lifecycle.execute({ id: 'still-running', agentId: 'a', machineId: 'fixture', storeId: listing.storeId,
    expectedIncarnation: row.incarnation, expectedRevision: row.revision, expectedLifetime: null,
    action: 'start', requestedBy: 'fixture' });
  const shutdown = createShutdown({ runner: { list: () => [{ id: 'draining' }], stop: () => new Promise(() => {}) },
    closeServer: () => { server.close(); process.send({ event: 'listener-closed' }); },
    clearOwned: () => {}, exit: code => process.exit(code), stopDeadlineMs: 30000 });
  process.on('message', message => { if (message === 'shutdown') void shutdown('fixture'); });
}

if (process.argv.includes('--draining-owner')) {
  await drainingOwner();
} else {
  test('a bound replacement must not settle a still-live same-port owner during shutdown drain', async t => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'same-port-drain-'));
    const child = fork(process.argv[1], ['--draining-owner'], {
      execArgv: [], env: { ...process.env, OWNER_PROBE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit'), events = [];
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes; });
    child.on('message', message => events.push(message));
    const receive = async event => {
      for (const end = Date.now() + 15000; Date.now() < end;) {
        const found = events.find(message => message.event === event);
        if (found) return found;
        if (child.exitCode !== null) throw Error(`child exited before ${event}: ${errors}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw Error(`child did not reach ${event}: ${errors}`);
    };
    let replacement = null;
    t.after(async () => {
      child.kill(); await exited;
      if (replacement?.listening) await new Promise(resolve => replacement.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    });
    const held = await receive('held');
    const journal = path.join(home, 'agent-lifecycle.json');
    assert.equal(JSON.parse(fs.readFileSync(journal)).records['still-running'].phase, 'pending');
    child.send('shutdown'); await receive('listener-closed');
    const url = new URL(held.url);
    replacement = http.createServer();
    replacement.listen(Number(url.port), url.hostname); await once(replacement, 'listening');
    assert.equal(replacement.listening, true);
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'the old daemon really remains alive after port release');
    console.log('CONTROL replacement owns endpoint; old owner pid is alive and its lifecycle builder is unresolved');
    bootDaemonAgentState({ aifyHome: home, url: held.url, exclusiveLifecycleScope: true });
    assert.equal(JSON.parse(fs.readFileSync(journal)).records['still-running'].phase, 'pending',
      'a released listener is not proof the old lifecycle operation cannot still execute');
  });
}
