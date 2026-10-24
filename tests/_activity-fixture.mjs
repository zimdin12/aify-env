// Private real spool and HTTP fixture. No daemon, provider child or external endpoint.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createDashboardPlugin } from '../lib/plugins/aify-dashboard/index.mjs';
import { readPluginConfig } from '../lib/plugin-config.mjs';
import { ActivityConsumer } from '../lib/plugins/aify-dashboard/activity-consumer.mjs';
import { stateDirectory } from '../lib/plugins/aify-dashboard/activity-state.mjs';
import { LIMITS } from '../lib/plugins/aify-dashboard/activity-raw.mjs';

const expectedWorker = process.env.EXPECTED_ACTIVITY_NODE ?? process.env.npm_node_execpath;
assert.ok(expectedWorker, 'activity fixtures must enter through npm test');
assert.equal(path.resolve(process.execPath).toLowerCase(), path.resolve(expectedWorker).toLowerCase(), 'native fixture worker binding');
if (process.env.ACTIVITY_SEALED_ROOT) {
  const root = path.resolve(process.env.ACTIVITY_SEALED_ROOT).toLowerCase() + path.sep;
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'HERMES_HOME',
    'ProgramFiles', 'ProgramW6432', 'ProgramData', ...(process.platform === 'win32' ? ['ProgramFiles(x86)'] : [])]) {
    assert.ok(typeof process.env[key] === 'string' && path.resolve(process.env[key]).toLowerCase().startsWith(root), `worker ${key} is fixture-sealed`);
  }
}
console.log(JSON.stringify({ activityFixtureWorker: { version: process.version, execPath: process.execPath,
  file: process.argv[1], sealed: Boolean(process.env.ACTIVITY_SEALED_ROOT) } }));

export const prerequisite = !process.env.AIFY_WRAPPER_REPO && 'requires explicit AIFY_WRAPPER_REPO checkout';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function captureFixture(root, destination) {
  if (!destination) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const from = path.join(root, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) captureFixture(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
export async function until(predicate, message, timeout = 1500) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(5);
  assert.ok(predicate(), message);
}
export async function fixture(t, { records = 2, policy = {}, filePath = i => `file-${i}.txt` } = {}) {
  const wrapper = process.env.AIFY_WRAPPER_REPO;
  assert.ok(wrapper && path.isAbsolute(wrapper), 'explicit wrapper fixture checkout');
  const { ActivitySpool } = await import(pathToFileURL(path.join(wrapper, 'lib/activity-spool.mjs')));
  const { activityEvent, validActivityRecord } = await import(pathToFileURL(path.join(wrapper, 'lib/file-activity.mjs')));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-consumer-'));
  const leases = path.join(root, 'leases');
  const directory = path.join(leases, 'agent-1', 'activity-v2');
  const config = { activity: { enabled: true, leaseDirectory: leases, wrapperCheckout: wrapper, ...policy } };
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.aify'), { recursive: true });
  const save = () => fs.writeFileSync(path.join(home, '.aify', 'config.json'), JSON.stringify({ plugins: { 'aify-dashboard': config } }));
  save();
  const producer = (options = {}) => new ActivitySpool({ directory, ...policy, ...options });
  const events = Array.from({ length: records }, (_, i) => activityEvent({
    input: { session_id: 'fixture-session', cwd: 'C:/fixture/project', tool_name: 'Read', tool_input: { file_path: filePath(i) } },
    identity: { machineId: 'win32:fixture', instanceId: 'fixture-instance', agentId: 'agent-1', incarnation: null },
    outcome: 'success', observedAt: Date.now(),
  }));
  for (const record of events) assert.equal(producer().append(record).ok, true, 'real producer append');
  const requests = [], bodies = [];
  let respond = body => ({ status: 200, body: ack(body) });
  let capability = { path: '/api/v1/file-activity' };
  const key = randomUUID(), secretsKey = randomUUID();
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    requests.push({ path: request.url, headers: request.headers, body });
    let result;
    if (request.url === '/.well-known/aify-service') result = { status: 200, body: { fixed: { fileActivity: capability } } };
    else if (request.url === '/api/v1/file-activity') { bodies.push(body); result = await respond(body, request); }
    else if (request.url.includes('/watch-list')) result = { status: 200, body: { hostKey: 'fixture', projects: [] } };
    else result = { status: 404, body: { error: 'fixture unexpected route' } };
    if (result?.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); result.stream(response); return; }
    if (result?.destroy) { request.socket.destroy(); return; }
    if (result?.raw !== undefined) { response.writeHead(result.status ?? 200, result.headers); response.end(result.raw); return; }
    response.writeHead(result?.status ?? 200, { 'content-type': 'application/json', ...result?.headers });
    response.end(JSON.stringify(result?.body ?? null));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const open = (options = {}) => new ActivityConsumer({ directory, agentId: 'agent-1', endpoint,
    validRecord: validActivityRecord, policy: { ...LIMITS, ...policy }, ...options });
  const raw = () => Object.fromEntries(fs.readdirSync(directory).map(n => [n, fs.readFileSync(path.join(directory, n)).toString('base64')]));
  const checkpoint = path.join(stateDirectory(directory, endpoint), 'state.json');
  const custody = process.env.ACTIVITY_EVIDENCE_DIR ? path.join(process.env.ACTIVITY_EVIDENCE_DIR, randomUUID()) : null;
  if (custody) {
    captureFixture(root, path.join(custody, 'before'));
    fs.writeFileSync(path.join(custody, 'input.json'), JSON.stringify({ name: t.name, policy, endpoint, directory, wrapper }));
  }
  const plugins = [];
  const plugin = (options = {}) => {
    const p = createDashboardPlugin({ endpoint, service: { name: 'aify-dashboard', endpoint }, machineId: 'win32:fixture',
      watchRoots: async () => ({ roots: [], problems: [] }),
      config: () => readPluginConfig({ name: 'aify-dashboard', home }), ...options.shared },
    { tickMs: 100000, runEveryMs: 100000, ...options.overrides });
    plugins.push(p); return p;
  };
  const host = { credential: async (_service, ref) => ref ? secretsKey : key };
  async function pass(options) {
    const p = plugin(options); await p.start(host);
    try { await until(() => (p.state().activity?.passes ?? 0) >= 1, 'enabled plugin executes one bounded activity pass'); }
    finally { await p.stop(); }
    return p;
  }
  t.after(async () => {
    await Promise.all(plugins.map(p => p.stop())); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (custody) { captureFixture(root, path.join(custody, 'after')); fs.writeFileSync(path.join(custody, 'batches.json'), JSON.stringify(bodies)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, leases, directory, config, save, home, events, open, producer, raw, checkpoint, requests, bodies, key, secretsKey, endpoint, plugin, host, pass,
    respond: fn => { respond = fn; }, capability: value => { capability = value; } };
}
export function ack(body) {
  return { version: 1, batchId: body.batchId,
    results: body.events.map(e => ({ eventId: e.eventId, disposition: 'stored', code: null })),
    coverage: { generation: body.coverage.generation, acknowledgedGapIds: body.coverage.gaps.map(g => g.id) } };
}
export function conflict(body, eventIds, gapIds = [], code = eventIds.length ? 'event_conflict' : 'gap_conflict') {
  return { status: 409, body: { version: 1, batchId: body.batchId, error: { code, eventIds, gapIds } } };
}
