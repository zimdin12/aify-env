// Real wrapper regions, capture CLI, sender, HTTP route, role and journal. No full launcher or agent runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DefinitionStore } from '../lib/agent-definitions.mjs';
import { LifecycleJournal } from '../lib/agent-lifecycle.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { DaemonResidents } from '../lib/daemon-residents.mjs';
import { AgentTurnEvents } from '../lib/agent-turn-events.mjs';
import { readAgentStates } from '../lib/agent-state-read.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { createDaemonHttp } from '../lib/daemon-http.mjs';

const ENV = path.resolve(import.meta.dirname, '..');
function peer(variable, marker) {
  const value = process.env[variable];
  if (value === undefined) return null;
  assert.ok(value && fs.existsSync(path.join(value, marker)),
    `${variable} must name an explicit valid source checkout`);
  return path.resolve(value);
}
const WRAPPER = peer('AIFY_WRAPPER_REPO', 'bin/aify-lifetime.sh');
const COMMS = peer('AIFY_COMMS_REPO', 'mcp/stdio/agent-state-event.mjs');
const SKIP = !WRAPPER || !COMMS ? 'requires AIFY_WRAPPER_REPO and AIFY_COMMS_REPO; explicit invalid inputs refuse' : false;
const FX = fileURLToPath(new URL('./test-data/resident-start-effects.mjs', import.meta.url));
const PID = 4242;
const forward = value => value.replaceAll('\\', '/');
const q = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const PAYLOAD = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'native-fixture-session', source: 'startup' });

// THE BOUNDS END A HANG, NOT A SLOW HOST (2026-10-28). Each bash child was killed at 20 s and each test at 60 s. Alone,
// a test here takes 11-22 s; in a full run on this shared host the prepare child of "a real stop change ..." took over 20 s,
// was killed, and failed with status null (21.6 s), the same four titles having failed once before with no text kept.
// A child now has 90 s and a test 240 s: still minutes, not hours, for a real hang.
const CHILD_MS = 90_000;
function execute(bash, script, env, args = [], input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, ['--noprofile', '--norc', script, ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'], timeout: CHILD_MS,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

class StartupComposition {
  constructor(root, harness, alteration) {
    this.root = root; this.harness = harness; this.alteration = alteration;
    this.home = path.join(root, '.aify'); this.responses = []; this.record = null; this.known = true;
  }
  async initialize() {
    fs.mkdirSync(this.home);
    this.token = randomUUID(); fs.writeFileSync(path.join(this.root, 'owner'), this.token);
    this.file = path.join(this.home, 'agent-lifecycle.json');
    this.journal = new LifecycleJournal({ file: this.file }); this.journal.initialize({ priorBoot: false });
    this.definitions = new DefinitionStore({ dir: path.join(this.home, 'agent-definitions') });
    this.agent = { name: 'Fixture', role: 'worker', harness: this.harness, mode: 'resident', workspace: this.root,
      model: '', effort: '', instructions: '', env: {}, herdrSpace: false };
    await this.definitions.set('fixture', this.agent, { installed: new Set([this.harness]) });
    const listing = await this.definitions.list(), row = listing.definitions[0];
    this.stopRequest = { id: 'prior-stop', action: 'stop', agentId: 'fixture', machineId: 'fixture-machine',
      storeId: listing.storeId, expectedIncarnation: row.incarnation, expectedRevision: row.revision,
      expectedLifetime: null, requestedBy: 'fixture' };
    this.key = `${listing.storeId}:${row.incarnation}:fixture`;
    const probe = pids => new Map(pids.map(pid => [pid, this.record && pid === PID
      ? { alive: this.known ? true : null, createdAtUs: this.known ? this.record.writtenAtUs - 1 : null,
        commandLine: this.known ? `bash "${this.record.launcher}"` : null }
      : { alive: false, createdAtUs: null, commandLine: null }]));
    const nowUs = () => this.record ? this.record.writtenAtUs + 1000 : Date.now() * 1000;
    this.managed = new AgentStateHost({ aifyHome: this.home, instance: 'managed', population: 'managed', probe, nowUs });
    this.managed.boot();
    const runner = { start() { throw Error('agent runtime forbidden'); }, stop() { throw Error('agent stop forbidden'); } };
    const http = createDaemonHttp({ runner, traffic: { requests: 0, bytesOut: 0 },
      protocolDeps: async () => ({ lifecycle: this.ports, turnEvents: this.turns }) });
    this.server = createServer(async (request, response) => {
      const method = request.method, url = request.url;
      const end = response.end.bind(response);
      response.end = (data, ...rest) => {
        this.responses.push({ method, url, status: response.statusCode, body: data ? JSON.parse(String(data)) : null });
        return end(data, ...rest);
      };
      if (method !== 'POST') throw Error('fixture permits only POST');
      if (url === '/fixture/after-capture') {
        request.resume();
        if (this.alteration === 'stop') {
          assert.equal((await this.ports.lifecycle.execute({ ...this.stopRequest, id: 'later-stop' })).status, 'done');
        } else if (this.alteration === 'definition') {
          await this.definitions.set('fixture', { ...this.agent, model: 'changed' }, { installed: new Set([this.harness]) });
        } else throw Error('unexpected capture control');
        response.writeHead(200); response.end(JSON.stringify({ applied: true })); return;
      }
      if (url === '/api/v1/agents/fixture/turn-end') {
        request.resume(); response.writeHead(503); response.end(JSON.stringify({ fixtureService: true })); return;
      }
      assert.ok(['/agents/fixture/resident-started', '/agents/fixture/turn-event'].includes(url), `unowned route ${url}`);
      await http(request, response);
    });
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    this.residents = new DaemonResidents({ aifyHome: this.home, url: this.url, pid: process.pid, probe, nowUs });
    assert.equal(await this.residents.acquire(), true);
    this.ports = createAgentLifecyclePorts({ aifyHome: this.home, machineId: 'fixture-machine', definitions: this.definitions,
      stateHost: this.managed, residents: this.residents, runner, installed: async () => new Set([this.harness]),
      probe: async pids => probe(pids), killTree: async () => { throw Error('process kill forbidden'); } });
    this.turns = new AgentTurnEvents({ host: this.managed, instance: 'managed', residents: this.residents });
    assert.equal((await this.ports.lifecycle.execute(this.stopRequest)).status, 'done');
    assert.equal(this.stopped(), true);
    const essentials = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
    this.env = { ...essentials, HOME: this.root, USERPROFILE: this.root, HERMES_HOME: path.join(this.root, '.hermes'),
      APPDATA: path.join(this.root, 'AppData/Roaming'), LOCALAPPDATA: path.join(this.root, 'AppData/Local'),
      TEMP: this.root, TMP: this.root, TMPDIR: this.root, AIFY_WRAPPER_REPO: WRAPPER,
      AIFY_AGENT_DEFINITIONS_DIR: path.join(this.home, 'agent-definitions'),
      AIFY_SERVER_URL: this.url, AIFY_API_KEY: 'fixture-only', START_PROOF_HOME: this.root,
      START_PROOF_TOKEN: this.token, START_PROOF_PID: String(PID),
      START_PROOF_CONTROL: `${this.url}/fixture/after-capture`, START_PROOF_ALTER: this.alteration || '' };
    const name = process.platform === 'win32' ? 'bash.exe' : 'bash';
    this.bash = process.env.TASK8_BASH || (process.env.PATH || '').split(path.delimiter)
      .map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
    assert.ok(this.bash && fs.existsSync(this.bash), 'an admitted Bash is required');
  }
  stopped() { return new LifecycleJournal({ file: this.file }).stopFacts().get(this.key); }
  async run(name, body, args = [], input = '', inherited = {}) {
    const file = path.join(this.root, `${name}.sh`); fs.writeFileSync(file, body);
    return execute(this.bash, forward(file), { ...this.env, ...inherited }, args, input);
  }
  async prepare(restore = false) {
    this.source = fs.readFileSync(path.join(WRAPPER, 'wrappers/claude-aify.sh.in'), 'utf8');
    const begin = this.source.indexOf('AIFY_HOOK_SETTINGS="$(mktemp');
    const end = this.source.indexOf('\n# THE TURN-START RUNNER', begin);
    assert.ok(begin > 0 && end > begin);
    const claim = this.source.match(/^\s+aify_lease_claim .*claude-code.*$/m)?.[0];
    const lifetime = this.source.match(/^aify_lifetime_start .*SessionStart.*$/m)?.[0];
    assert.ok(claim && lifetime, 'maintained caller sites required');
    let argv = ['--resident', '--aify-agent', 'fixture'];
    if (restore) {
      const { restoreArgv } = await import(pathToFileURL(path.join(WRAPPER, 'lib/herdr-replay.mjs')).href);
      argv = restoreArgv(['claude-aify', ...argv]).slice(1);
    }
    const node = q(forward(process.execPath)), fx = q(forward(FX));
    const body = `set -euo pipefail\n. ${q(forward(path.join(WRAPPER, 'bin/aify-lease.sh')))}
node() { case "$1" in */aify-agent-lease.mjs) command ${node} ${fx} claim "$@";; *) command ${node} "$@";; esac; }
aify_lease_pid() { printf '${PID}'; }
aify-env() {
  command ${node} ${fx} before-capture "$@"
  local status=0
  command ${node} ${q(forward(path.join(ENV, 'bin/aify-env.mjs')))} "$@" || status=$?
  if [ "$status" = 0 ] && [ -n "$START_PROOF_ALTER" ]; then command ${node} ${fx} after-capture; fi
  return "$status"
}
export AIFY_AGENT_ID=fixture
CLAUDE_AIFY_AGENT_ID=fixture; AIFY_SESSION_MODE=resident
aify_lease_take_intent "$@"
${this.harness === 'claude' ? claim : `aify_lease_claim fixture ${this.harness} resident`}
${this.harness === 'claude' ? lifetime : `aify_lifetime_start fixture ${this.harness} resident`}
AIFY_BRIDGE_DIR_FWD=${q(forward(path.join(COMMS, 'mcp/stdio')))}
AIFY_WRAPPER_DIR_FWD=${q(forward(WRAPPER))}
AIFY_HERDR_WORKING=''; AIFY_HERDR_EVENTS=''
${this.source.slice(begin, end)}
command ${node} ${fx} snapshot "$AIFY_HOOK_SETTINGS"\n`;
    const result = await this.run('prepare', body, argv);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
    this.snapshot = JSON.parse(result.stdout);
    assert.equal(this.snapshot.records.length, 1);
    this.record = this.snapshot.records[0];
    this.residents.refresh();
    assert.equal(this.record.harness, this.harness); assert.equal(this.record.pid, PID);
    const current = this.ports.rawIdentity('fixture');
    assert.equal(current.unknown, false); assert.equal(current.conflict, false);
    assert.equal(current.current.lifetime, this.record.lifetime);
    this.nativeCommand = this.snapshot.settings.hooks.SessionStart.flatMap(group => group.hooks)
      .find(hook => hook.command.includes('resident-started'))?.command;
    assert.ok(this.nativeCommand, 'the maintained native producer must be wired');
  }
  async send(startup = true) {
    const command = startup ? this.nativeCommand : `node ${q(forward(path.join(COMMS, 'mcp/stdio/agent-state-event.mjs')))} turn-end`;
    const result = await this.run(startup ? 'native-hook' : 'turn-end',
      `set -eu\nnode() { command ${q(forward(process.execPath))} "$@"; }\n${command}\n`, [], PAYLOAD, this.snapshot.env);
    assert.deepEqual([result.status, result.signal, result.stdout, result.stderr], [0, null, '', '']);
  }
  starts() { return this.responses.filter(row => row.url === '/agents/fixture/resident-started'); }
  async view() {
    const answer = await readAgentStates({ stateHost: this.residents.host, definitions: this.definitions,
      lifecycle: this.ports, observedHarnesses: async () => new Set([this.harness]) });
    assert.equal(answer.status, 200); assert.equal(answer.body.complete, true);
    return answer.body.agents.find(row => row.agentId === 'fixture');
  }
  async close() {
    await this.residents?.release({ waitMs: 0 });
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
async function fixture(t, harness = 'claude', alteration = '') {
  const f = new StartupComposition(fs.mkdtempSync(path.join(os.tmpdir(), 'native-start-')), harness, alteration);
  t.after(() => f.close()); await f.initialize(); return f;
}
const options = { skip: SKIP, timeout: 240_000 };

test('composed native SessionStart clears once, while applied turn-end remains non-clearing', options, async t => {
  const f = await fixture(t); await f.prepare();
  assert.ok(f.record.operatorStart);
  await f.send(false);
  assert.ok(f.responses.some(row => row.body?.applied === true));
  assert.equal(f.stopped(), true); assert.equal((await f.view()).state, 'stopped');
  await f.send();
  assert.equal(f.stopped(), false, JSON.stringify(f.responses));
  assert.equal(f.starts().length, 1); assert.equal(f.starts()[0].body.consumed, true);
  assert.equal((await f.view()).state, 'idle');
  const before = fs.readFileSync(f.file, 'utf8'); await f.send();
  assert.equal(f.starts().at(-1).body.reason, 'stop-moved'); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('the real Herdr restore argv cannot mint startup permission or clear through the native callback', options, async t => {
  const f = await fixture(t); await f.prepare(true);
  assert.equal(f.record.operatorStart, undefined);
  const before = fs.readFileSync(f.file, 'utf8'); await f.send();
  assert.equal(f.starts()[0].body.reason, 'startup-binding-unavailable');
  assert.equal(f.stopped(), true); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
for (const alteration of ['stop', 'definition']) test(`a real ${alteration} change between capture and record publication wins`, options, async t => {
  const f = await fixture(t, 'claude', alteration); await f.prepare();
  assert.equal(f.responses.filter(row => row.url === '/fixture/after-capture').length, 1);
  assert.ok(f.record.operatorStart);
  const before = fs.readFileSync(f.file, 'utf8'); await f.send();
  assert.equal(f.starts()[0].body.reason, alteration === 'stop' ? 'stop-moved' : 'definition-moved');
  assert.equal(f.stopped(), true); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('a failed fixture invocation runs the maintained exit notifier but cannot acknowledge startup', options, async t => {
  const f = await fixture(t); await f.prepare();
  const before = fs.readFileSync(f.file, 'utf8');
  const begin = f.source.indexOf('_aify_runtime_exited() {'), end = f.source.indexOf('\ntrap ', begin);
  assert.ok(begin > 0 && end > begin);
  const notify = f.source.slice(begin, end).replaceAll('@@WRAPPER_DIR@@', forward(WRAPPER))
    .replaceAll('@@BRIDGE_DIR@@', forward(path.join(COMMS, 'mcp/stdio')));
  const result = await f.run('failed-invocation', `set -eu\n${notify}\ntrap _aify_runtime_exited EXIT\nAIFY_RUNTIME_RUNNING=1\ncommand ${q(forward(process.execPath))} ${q(forward(FX))} failed-invocation\n`, [], '', f.snapshot.env);
  assert.equal(result.status, 127, result.stderr); assert.equal(result.signal, null);
  assert.ok(f.responses.some(row => row.body?.applied === true));
  assert.deepEqual(f.starts(), []); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal((await f.view()).state, 'stopped');
});

for (const harness of ['hermes', 'codex']) test(`${harness} remains non-clearing in the composed sender/host boundary`, options, async t => {
  const f = await fixture(t, harness); await f.prepare();
  assert.equal(f.record.operatorStart, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(WRAPPER, `wrappers/${harness}-aify.sh.in`), 'utf8'), /resident-started/);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = await f.run('unsupported', `command ${q(forward(process.execPath))} ${q(forward(path.join(COMMS, 'mcp/stdio/agent-state-event.mjs')))} resident-started ${harness}\n`, [], PAYLOAD, f.snapshot.env);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.starts(), []);
  assert.equal(f.stopped(), true); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
