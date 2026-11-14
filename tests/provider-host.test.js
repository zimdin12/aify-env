import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderWorker } from '../lib/plugins/aify-dashboard/provider-worker.mjs';
import { runChild, childEnv } from '../lib/plugins/aify-dashboard/provider-child.mjs';
import { ProviderRunner, RUN_EVERY_MS } from '../lib/plugins/aify-dashboard/provider-runner.mjs';
import { DashboardApi } from '../lib/plugins/aify-dashboard/dashboard-api.mjs';
import { providerApi, scriptedRun } from './fixtures/provider-host.mjs';

test('the actual APG entry resolves present/absent anchors and refuses a granted subfolder', { skip: !process.env.AIFY_APG_REPO && 'set AIFY_APG_REPO to the pinned peer checkout' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'apg-host-')); mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'present.js'), 'export const present = 1;');
  for (const args of [['init','-q'],['add','.'],['-c','user.name=t','-c','user.email=t@example.invalid','commit','-qm','fixture']]) execFileSync('git', args, { cwd: root });
  const worker = new ProviderWorker({ nodePath: process.execPath, script: join(process.env.AIFY_APG_REPO, 'bin/apg.js'), cwd: root, env: childEnv(process.env, {}) });
  t.after(() => worker.close());
  const request = { id: 'present-absent', call: 'resolve', args: { anchors: ['present.js','absent.js'].map(path => ({ kind: 'file', path })) }, repoRoot: root };
  const answer = await worker.ask(request);
  assert.equal(answer.ok, true); assert.deepEqual(answer.value.results.map(r => r.status), ['found','gone']);
  const refused = await worker.ask({ ...request, id: 'subfolder', repoRoot: join(root, 'sub') });
  assert.equal(refused.ok, false); assert.equal(refused.value.reasonCode, 'repository_root_required');
});

// Real pipes, including a split UTF-8 character and an unknown id, not a direct invocation of a line handler.
test('one native worker correlates serial multi-root frames, survives in-band refusal and drains EOF', async t => {
  let starts = 0;
  const worker = new ProviderWorker({ nodePath: process.execPath,
    script: fileURLToPath(new URL('./test-data/provider-worker.mjs', import.meta.url)), cwd: process.cwd(),
    env: childEnv({ ...process.env, APG_DASHBOARD_KEY: 'must-not-cross' }, {}),
    run: options => { starts++; return runChild(options); } });
  t.after(() => worker.close());
  const first = worker.ask({ id: 'a', call: 'refuse', args: {}, repoRoot: '/first' });
  await assert.rejects(worker.ask({ id: 'overlap' }), /not ready/);
  assert.equal((await first).value.reasonCode, 'no_index');
  const answer = await worker.ask({ id: 'b', call: 'read', args: {}, repoRoot: '/second' });
  assert.deepEqual(answer.value, { repoRoot: '/second', reasonCode: 'no_index', text: 'λ', key: null });
  assert.equal(answer.ok, true); assert.equal(starts, 1); assert.equal(worker.dropped, 2);
  const ended = await worker.close(); assert.equal(ended.code, 0); assert.equal(ended.unconfirmed, '');
});

test('the default90s deadline closes stdin before owned cleanup and keeps a timeout signal transient', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const events = [], end = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...args) => { events.push('stdin'); return end(...args); };
  const worker = new ProviderWorker({ run: options => runChild({ ...options, platform: 'win32',
    start: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    kill: async (_, parts) => { assert.equal(parts.own, child); events.push('kill'); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL'); } }) });
  let ended = false;
  const result = worker.ask({ id: 'slow' }).catch(error => { ended = true; return error.result; });
  await Promise.resolve(); t.mock.timers.tick(89_999); await Promise.resolve(); assert.equal(ended, false);
  t.mock.timers.tick(1); assert.deepEqual(events, ['stdin', 'kill']);
  assert.equal((await result).timedOut, true);
});

test('malformed, wrongly typed and oversized answer frames fail closed', async t => {
  for (const frame of ['{\n', JSON.stringify({ id: 'bad', ok: 'yes' }) + '\n', JSON.stringify({ id: 'bad', ok: true, value: 'x'.repeat(2 * 1024 * 1024) }) + '\n']) {
    const worker = new ProviderWorker({ run: scriptedRun(async () => ({ code: 0, frame })) });
    t.after(() => worker.close());
    await assert.rejects(worker.ask({ id: 'bad' }), error => { assert.equal(error.result?.protocolError, true); return true; });
  }
});

function scene(exits = []) {
  const s = { now: 0, roots: ['c:/w'], projects: [{ projectId: 'p1', queued: 1 }], starts: 0, feeds: [], posts: [] };
  const api = providerApi(() => s.projects), post = api.postProviderResult;
  api.postProviderResult = async (...args) => { s.posts.push(args); return post(...args); };
  s.api = api;
  s.runner = new ProviderRunner({ api, endpoint: 'http://fixture.invalid', hostKey: 'h', credential: async () => 'key',
    config: () => ({ config: { providerCheckout: process.cwd() } }), watchRoots: async () => ({ roots: s.roots }), now: () => s.now,
    folders: () => ['p1','p2'].map(projectId => ({ projectId, path: 'C:/w', real: 'C:/w', platform: 'win32' })), exists: () => true, realpath: p => p,
    worker: options => { s.starts++; return (s.worker = new ProviderWorker(options)); },
    run: scriptedRun(async options => { s.feeds.push(options.request); return { code: 0, ...exits.shift() }; }) });
  return s;
}
test('claims are serial through result posting and one worker serves both projects', async t => {
  const s = scene(); t.after(() => s.runner.close()); s.projects.push({ projectId: 'p2', queued: 1 });
  const claim = s.api.claimProvider; let outstanding = false;
  s.api.claimProvider = async (...args) => { assert.equal(outstanding, false); outstanding = true; return claim(...args); };
  s.api.postProviderResult = async () => { assert.equal(outstanding, true); await new Promise(setImmediate); outstanding = false; return { stored: true }; };
  await s.runner.pass(); assert.equal(s.starts, 1); assert.equal(s.feeds.length, 2); assert.equal(outstanding, false);
});
test('grant loss during claim fails the request without feeding, and idle reconciliation closes its worker', async t => {
  const s = scene(); t.after(() => s.runner.close()); await s.runner.pass();
  const claim = s.api.claimProvider;
  s.api.claimProvider = async (...args) => { const body = await claim(...args); s.roots = []; return body; };
  await s.runner.pass(); assert.equal(s.feeds.length, 1); assert.equal(s.posts.at(-1)[2].ok, false);
  await s.runner.reconcile(); await s.runner.pass(); assert.equal(s.starts, 1);
});
test('revocation during the prior worker close is rechecked before the next feed', async t => {
  const s = scene(); t.after(() => s.runner.close()); await s.runner.pass();
  const claim = s.api.claimProvider, close = s.runner.close.bind(s.runner);
  s.api.claimProvider = async (...args) => { const body = await claim(...args); s.roots = ['c:/']; return body; };
  s.runner.close = async () => { await close(); s.roots = []; };
  await s.runner.pass(); assert.equal(s.feeds.length, 1, 'the closed-over pre-revocation grant cannot authorize a feed');
  assert.equal(s.posts.at(-1)[2].ok, false, 'the claimed request is explicitly refused');
});

test('an empty slot waits for the prior worker close before its replacement starts', async t => {
  const s = scene(); t.after(() => s.runner.close()); await s.runner.pass();
  let release; const held = new Promise(resolve => { release = resolve; });
  const close = s.worker.close.bind(s.worker); s.worker.close = () => held.then(close);
  const ending = s.runner.close(), pass = s.runner.pass();
  await new Promise(setImmediate);
  try { assert.equal(s.starts, 1, 'no replacement during the prior owned close'); }
  finally { release(); await Promise.all([ending, pass]); }
  assert.equal(s.starts, 2, 'the replacement starts after the close settles');
});

test('exit2 latches the endpoint across projects; exit3 waits60s before recreation', async t => {
  const latched = scene([{ code: 2, error: '' }]); t.after(() => latched.runner.close()); await latched.runner.pass();
  latched.projects = [{ projectId: 'p2', queued: 1 }]; await latched.runner.pass(); assert.equal(latched.starts, 1);
  const s = scene([{ code: 3 }]); t.after(() => s.runner.close()); await s.runner.pass();
  s.now = RUN_EVERY_MS - 1; await s.runner.pass(); assert.equal(s.starts, 1);
  s.now++; await s.runner.pass(); assert.equal(s.starts, 2);
});
test('empty immediate polls fall back60s but a held poll resumes immediately', async () => {
  const s = scene(); s.projects = []; await s.runner.pass(); assert.equal(s.runner.delayMs, RUN_EVERY_MS);
  s.api.providerPending = async hostKey => { s.now += 25_000; return { hostKey, projects: [] }; };
  await s.runner.pass(); assert.equal(s.runner.delayMs, 0);
});
test('provider HTTP uses rotated host credentials, claim1,35s poll deadline and preserves failed values', async () => {
  const calls = [], deadlines = [], original = AbortSignal.timeout; let key = 'first';
  AbortSignal.timeout = ms => { deadlines.push(ms); return original(ms); };
  try {
    const api = new DashboardApi({ endpoint: 'http://fixture.invalid', credential: async () => key,
      fetch: async (url, options) => { calls.push({ url, ...options }); return Response.json({ stored: true }); } });
    await api.providerPending('h', { waitSeconds: 25 }); key = 'second'; await api.claimProvider('h', 'p');
    await api.postProviderResult('h', 'id', { ok: false, problem: 'no index', value: { reasonCode: 'no_index' } });
    assert.ok(calls[0].url.endsWith('?waitSeconds=25')); assert.equal(deadlines[0], 35_000);
    assert.deepEqual(JSON.parse(calls[1].body), { projectId: 'p', limit: 1 });
    assert.equal(calls[1].headers['x-api-key'], 'second'); assert.equal(calls[0].redirect, 'manual');
    assert.equal(JSON.parse(calls[2].body).value?.reasonCode, 'no_index');
  } finally { AbortSignal.timeout = original; }
});
