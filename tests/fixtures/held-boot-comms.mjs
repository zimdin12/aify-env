import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BootFixture } from './daemon-boot.mjs';
import { spawnedPipe } from './spawned-pipe.mjs';
import { ProcessIdentityProbe } from '../../lib/process-identity.mjs';
import { OwnedProcessRecord } from '../../lib/owned-process-record.mjs';
import { SuccessorRecovery } from '../../lib/successor-recovery.mjs';
import { RecoveredProcessTermination } from '../../lib/recovered-process-termination.mjs';
import { Runner } from '../../lib/runner.mjs';
import { DefinitionStore } from '../../lib/agent-definitions.mjs';
import { bootDaemonAgentState } from '../../lib/daemon-agent-state.mjs';
import { createAgentLifecyclePorts } from '../../lib/daemon-agent-lifecycle.mjs';
import { ServicePlugins } from '../../lib/service-plugins.mjs';
import { startDaemonPlugins } from '../../lib/daemon-plugin-bootstrap.mjs';
import { pluginsForServices } from '../../lib/plugins/index.mjs';
import { CommsApi, mintBridgeIdentity } from '../../lib/plugins/aify-comms/api.mjs';

const OWNER = 424240, CHILD = 424241, SELF = 424242;
const AT = Date.parse('2026-11-07T08:00:00Z');
const token = pid => ({ version: 1, platform: 'win32', pid, createdAtUs: (AT - (pid === OWNER ? 1000 : 0)) * 1000 });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The real plugin poller and CommsApi see producer-shaped responses, never a directly invoked control handler.
export class HeldBootComms {
  f = new BootFixture();
  states = new Map();
  observations = [];
  spawns = [];
  timers = new Set();
  controls = [];
  requests = [];
  reports = [];
  launches = new Map();
  ended = [];
  async initialize(t) {
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), 'held-boot-comms-'));
    t.after(async () => {
      this.f.session.cancel();
      await this.plugins?.stopAll();
      for (const row of this.runner?.list() ?? []) await this.runner.stop(row.id);
      for (const child of this.spawns) if (child.exitCode === null) child.kill();
      await this.f.session.agentState?.residents?.release();
      for (const timer of this.timers) clearTimeout(timer);
      fs.rmSync(this.home, { recursive: true, force: true });
    });
    this.file = path.join(this.home, 'owned.json'); this.launcher = path.join(this.home, 'fixture-launcher');
    this.fileText = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1.0"\n';
    fs.writeFileSync(this.launcher, this.fileText);
    fs.writeFileSync(this.file, JSON.stringify([{ id: 'original', pid: CHILD, owner: OWNER, service: 'fixture', launcher: this.launcher, startedAt: AT }]));
    for (const pid of [OWNER, CHILD, SELF]) this.states.set(pid, { createdAtUs: token(pid).createdAtUs,
      commandLine: pid === CHILD ? this.launcher : 'node aify-env.mjs' });
    const identity = new ProcessIdentityProbe({ platform: 'win32', state: () => { throw Error('native liveness forbidden'); },
      runSync: () => { throw Error('native process query forbidden'); }, readFile: () => { throw Error('procfs forbidden'); },
      run: (_command, args, _options, done) => {
        const pids = [...args.at(-1).matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1]));
        this.observations.push({ pids: [...pids], absent: pids.filter(pid => !this.states.has(pid)) });
        done(null, JSON.stringify(pids.filter(pid => this.states.has(pid)).map(pid => ({ pid,
          created: new Date(this.states.get(pid).createdAtUs / 1000).toISOString(), cmd: this.states.get(pid).commandLine }))), '');
      } });
    const held = async (pid, options) => {
      const state = this.states.get(pid), createdAt100ns = state ? String((BigInt(state.createdAtUs) + 11644473600000000n) * 10n) : null;
      if (!options.stillOurs({ createdAt100ns })) throw Error('fixture birth mismatch');
      if (pid === OWNER) throw Error('fixture original owner survives');
      this.ended.push(pid); this.states.delete(pid);
    };
    this.record = new OwnedProcessRecord(this.file, { ownerPid: SELF, ownerIdentity: token(SELF), report() {} });
    this.recovery = new SuccessorRecovery({ record: this.record, identity, platform: 'win32', selfPid: SELF, parentPid: 424239,
      termination: new RecoveredProcessTermination({ platform: 'win32', identity, held, selfPid: SELF, parentPid: 424239 }), report() {} });
    await this.recovery.supersede({ pid: OWNER, processes: [], version: '0.9.12-dev' });
    this.runner = new Runner({ platform: 'win32', ownedRecord: this.record, openTerminal: null, loadCheckpoint: null,
      startGate: () => this.recovery.admitStart(), assertOpen: this.f.session.assertOpen,
      managedHost: () => this.f.session.agentState ? { ...this.f.session.agentState, url: 'http://127.0.0.1:18802' } : null,
      processIdentity: { captureChild: () => null }, isAlive: pid => this.states.has(pid), killTree: async pid => this.states.delete(pid),
      spawnProcess: () => {
        const child = Object.assign(new EventEmitter(), { pid: 424250 + this.spawns.length, stdout: new EventEmitter(), stderr: new EventEmitter(),
          stdin: { write() {} }, exitCode: null, kill: () => { this.states.delete(child.pid); child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); } });
        this.states.set(child.pid, { createdAtUs: Date.now() * 1000 - 1000, commandLine: this.launcher });
        this.spawns.push(child); return spawnedPipe(child);
      } });
    this.definitions = new DefinitionStore({ dir: path.join(this.home, 'definitions') });
    await this.definitions.set('fixture', { name: 'Fixture', role: 'worker', harness: 'claude', mode: 'managed', workspace: this.home,
      model: '', effort: '', instructions: '', env: {}, herdrSpace: false }, { installed: new Set(['claude']) });
    const listing = await this.definitions.list(), row = listing.definitions[0];
    this.binding = { storeId: listing.storeId, incarnation: row.incarnation, revision: row.revision };
    this.api = new CommsApi({ endpoint: 'http://comms.invalid', credential: async () => 'fixture-key',
      identity: mintBridgeIdentity({ version: 'fixture-version' }), fetchImpl: (url, options) => this.fetch(url, options) });
    this.plugins = new ServicePlugins({ canStart: () => !this.f.session.cancelled });
    const schedule = (fn, ms) => {
      const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, Math.min(ms, 5));
      this.timers.add(timer); return timer;
    };
    Object.assign(this.f.options, { home: this.home, runner: this.runner, definitions: this.definitions, plugins: this.plugins,
      roots: () => [this.home], windows: true, installed: () => new Set(['claude']), advertising: false, evaluate() {}, pid: SELF,
      recover: () => this.recovery.recover(), identity: () => ({ hostname: 'fixture', kind: 'windows', machineId: 'win32:fixture' }),
      advertisement: () => ({ hostname: 'fixture', kind: 'windows', machineId: 'win32:fixture' }),
      readServices: () => [{ name: 'aify-comms', endpoint: 'http://comms.invalid' }],
      buildPlugins: (services, shared) => pluginsForServices(services, { ...shared, api: this.api,
        hostProofFor: () => '', readPluginConfig: () => ({ config: null }), readFile: () => this.fileText, platform: 'win32',
        setTimeoutImpl: schedule, clearTimeoutImpl: timer => { this.timers.delete(timer); clearTimeout(timer); } }) });
    Object.assign(this.f.factories, {
      state: options => bootDaemonAgentState({ ...options, pid: SELF, probe: pids => new Map(pids.map(pid => {
        const row = this.states.get(pid);
        return [pid, { alive: Boolean(row), createdAtUs: row?.createdAtUs ?? null, commandLine: row?.commandLine ?? null }];
      })) }),
      lifecycle: createAgentLifecyclePorts,
      plugins: startDaemonPlugins,
    });
    return this;
  }
  enqueue(id) {
    const terminalId = `terminal-${id}`, stamp = '2026-11-07T08:01:00Z';
    this.controls.push({ id, terminalId, environmentId: 'windows:fixture:default', bridgeId: this.api.identity.bridgeId,
      action: 'start', body: '', cols: 0, rows: 0, status: 'claimed', requestedBy: 'operator', requestedAt: stamp,
      claimedAt: stamp, handledAt: '', error: '', pid: '', agentId: 'fixture', runtime: 'claude-code', sessionMode: 'managed' });
    this.launches.set(terminalId, { terminalId, agentId: 'fixture', runtime: 'claude-code', command: '',
      argv: [this.launcher, '--aify-agent', 'fixture'], cwd: this.home, cols: 0, rows: 0, sessionHandle: '',
      env: { AIFY_AGENT_ID: 'fixture' }, unsetEnv: [], herdrSpace: false, definition: { ...this.binding } });
  }
  async fetch(url, options) {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    this.requests.push({ route, method: options.method, body });
    if (route === '/api/v1/environments/heartbeat') return response({ ok: true, claimer: { accepted: true, bridgeId: this.api.identity.bridgeId } });
    if (route === '/api/v1/spawn-requests/claim') return response({ ok: true });
    if (route === '/api/v1/terminals/controls/claim') return response({ ok: true, controls: this.controls.splice(0) });
    const launch = /^\/api\/v1\/terminals\/([^/]+)\/launch$/.exec(route);
    if (launch) return response({ ok: true, launch: this.launches.get(decodeURIComponent(launch[1])) });
    const report = /^\/api\/v1\/terminals\/controls\/([^/]+)$/.exec(route);
    if (report) { this.reports.push({ id: decodeURIComponent(report[1]), ...body }); return response({ ok: true }); }
    if (/^\/api\/v1\/terminals\/[^/]+\/output$/.test(route)) return response({ ok: true, terminal: { status: 'attached' } });
    return response({ detail: 'fixture does not offer this independent endpoint' }, 503);
  }
  originalOwnerGone() { this.states.delete(OWNER); }
}
