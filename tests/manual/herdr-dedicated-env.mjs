// Real daemon tests run only after assignment-before-resume in the audited Windows Job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { instanceFixture } from '../helpers/instance-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const supervisor = path.join(import.meta.dirname, 'herdr-owned-processes.ps1');
const powershell = path.join(process.env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const supervised = process.argv[3] === '--owned-job';
// SCRATCH GOES TO TEMP, NOT INTO THE REPO. This defaulted to `<repo>/.local/...` and left one
// untracked UUID directory per run in the working tree. That is the shape aify-comms' CLAUDE.md
// records as the `.monitor/` trap: the gates walk the FILESYSTEM, so a directory `git status` habits
// skip is still counted by every census and line-count walk, and it read four files high once.
// A fixture's scratch is not evidence and has no business in the tree.
const root = supervised ? process.argv[5] : path.join(os.tmpdir(), 'aify-herdr-dedicated-env', randomUUID());
const mode = process.argv[2] || 'daemon';
assert.equal(process.platform, 'win32', 'Windows owned Job is required; no unsupervised fallback');
fs.mkdirSync(root, { recursive: true });
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN)$/i.test(k)));
Object.assign(clean, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
  AIFY_ADVERTISE: '0', AIFY_NO_DASHBOARD: '1', AIFY_SERVICE_REGISTRY: path.join(root, 'default-services.json'),
  AIFY_ENV_PROCESS_RECORD: path.join(root, 'default-owned.json') });
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error(`timeout: ${label}`);
}
function supervise(binary, directory) {
  return spawn(powershell, ['-NoProfile', '-File', supervisor, '-Node', process.execPath,
    '-Fixture', process.argv[1], '-Binary', binary, '-Root', directory], { cwd: repo, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
}
function capture(child, file) {
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { fs.writeFileSync(file, output); resolve(code); });
  });
}
if (!supervised) {
  // The sentinel has its OWN Job, outside the daemon Job. No uncontained child fixture.
  const sentinelRoot = path.join(root, 'external-sentinel'); fs.mkdirSync(sentinelRoot);
  const sentinel = supervise('sentinel', sentinelRoot);
  const sentinelExit = capture(sentinel, path.join(root, 'sentinel-supervisor.txt'));
  let failure;
  try {
    await until(() => fs.existsSync(path.join(sentinelRoot, 'alive.json')), 'external sentinel');
    const first = JSON.parse(fs.readFileSync(path.join(sentinelRoot, 'alive.json')));
    const main = supervise(mode, root);
    const status = await capture(main, path.join(root, 'supervisor-output.txt'));
    const job = JSON.parse(fs.readFileSync(path.join(root, 'job-receipt.json')));
    assert.equal(job.assignedBeforeResume, true); assert.equal(job.activeProcessesAfterTerminate, 0);
    assert.equal(status, 0, fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'));
    const atCleanup = JSON.parse(fs.readFileSync(path.join(sentinelRoot, 'alive.json')));
    const after = await until(() => {
      try { const r = JSON.parse(fs.readFileSync(path.join(sentinelRoot, 'alive.json'))); return r.tick > atCleanup.tick && r; } catch { return null; }
    }, 'sentinel survives dedicated Job termination');
    assert.equal(after.pid, first.pid); assert.equal(sentinel.exitCode, null);
    fs.writeFileSync(path.join(root, 'cleanup-receipt.json'), JSON.stringify({ job, externalSentinel: after, survived: true }, null, 2));
  } catch (error) { failure = error; }
  finally { fs.writeFileSync(path.join(sentinelRoot, 'stop'), 'stop'); await sentinelExit; }
  console.log(JSON.stringify({ root, ok: !failure }));
  if (failure) throw failure;
  process.exit(0);
}
const membership = spawnSync(powershell, ['-NoProfile', '-File', supervisor, '-CheckJob', process.argv[4]], { encoding: 'utf8', timeout: 10000 });
assert.equal(membership.status, 0, membership.stderr);
if (mode === 'sentinel') {
  let tick = 0;
  while (!fs.existsSync(path.join(root, 'stop'))) {
    fs.writeFileSync(path.join(root, 'alive.json'), JSON.stringify({ pid: process.pid, tick: tick++ })); await pause(100);
  }
  process.exit(0);
}
const events = [], children = [], owners = [];
function daemon(args, extra = {}) {
  const child = spawn(process.execPath, [path.join(repo, 'bin/aify-env.mjs'), ...args], { cwd: root, env: { ...clean, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const item = { child, output: '', args }; children.push(item);
  child.stdout.on('data', b => item.output += b); child.stderr.on('data', b => item.output += b);
  return item;
}
async function refused(f, args = [], reason = 'instance_context', extra = {}) {
  const before = fs.readdirSync(f.context.root).sort();
  const item = daemon(['--instance-context', f.file, ...args], extra);
  await until(() => item.child.exitCode !== null, 'refusal');
  assert.notEqual(item.child.exitCode, 0, item.output); assert.match(item.output, new RegExp(reason));
  assert.deepEqual(fs.readdirSync(f.context.root).sort(), before, item.output);
  events.push({ refused: reason, args, output: item.output });
}
async function owner(f, accept = true, beforeReply = () => {}) {
  const server = net.createServer(socket => {
    let text = '';
    socket.on('data', b => {
      text += b; if (!text.includes('\n')) return;
      const request = JSON.parse(text.split('\n')[0]); text = '';
      events.push({ ownerRequest: request });
      beforeReply();
      socket.write(JSON.stringify(accept ? { ...request, accepted: true } : { status: 'healthy', pid: process.pid, processes: [], terminals: {} }) + '\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(f.context.ownerEndpoint, resolve)); owners.push(server); return server;
}
async function ready(f) {
  const item = daemon(['--instance-context', f.file]);
  const receipt = await until(() => {
    if (item.child.exitCode !== null) throw new Error(item.output);
    try { return JSON.parse(fs.readFileSync(f.context.readinessEndpoint)); } catch { return null; }
  }, 'private readiness');
  assert.equal(receipt.pid, item.child.pid); assert.equal(receipt.invocation, f.context.invocation);
  assert.equal(receipt.scope, f.context.scope); assert.equal(receipt.state, 'transport-ready');
  assert.equal(receipt.serviceConnected, false); assert.match(receipt.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![8800, 8801, 8802].includes(Number(new URL(receipt.endpoint).port)));
  events.push({ ready: receipt }); return { item, receipt };
}
async function request(base, route, method = 'GET', body) {
  const r = await fetch(base + route, { method, signal: AbortSignal.timeout(5000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = r.status === 204 ? null : await r.json();
  events.push({ route, method, status: r.status, value }); assert.ok(r.ok, JSON.stringify(value)); return value;
}
let failure;
try {
  fs.writeFileSync(clean.AIFY_ENV_PROCESS_RECORD, 'external-record-sentinel');
  fs.writeFileSync(clean.AIFY_SERVICE_REGISTRY, '{"version":1,"services":{"forbidden":{"endpoint":"http://invalid.test"}}}');
  const f = instanceFixture(root);
  await owner(f);
  // Happy boot is first so baseline RED is the actual CLI's missing routing, not a test import.
  const a = await ready(f);
  const health = await request(a.receipt.endpoint, '/health');
  assert.equal(health.instance, a.receipt.envInstance); assert.deepEqual(health.processes, []);
  assert.deepEqual(health.plugins, []); assert.equal(health.advertisingEnabled, false);
  await refused(f, [], 'instance_context'); // Claimed contexts are never rebound, even idle.
  const second = instanceFixture(root); await owner(second); const b = await ready(second);
  assert.notEqual(a.receipt.endpoint, b.receipt.endpoint); assert.notEqual(a.receipt.envInstance, b.receipt.envInstance);
  assert.notEqual(f.context.processRecord, second.context.processRecord); assert.notEqual(a.receipt.scope, b.receipt.scope);
  for (const patch of [{ version: 2 }, { invocation: '' }, { ownerEndpoint: 'http://127.0.0.1:8802' },
    { processRecord: clean.AIFY_ENV_PROCESS_RECORD }, { recovery: 'restore' }]) {
    const bad = instanceFixture(root); Object.assign(bad.context, patch); bad.save(); await refused(bad);
  }
  await refused(instanceFixture(root), ['--force']);
  // A REGISTERED SERVICE IS ADMITTED. This asserted the opposite -- any service refused the whole
  // instance -- which is what left a dedicated env unable to locate aify-comms and therefore unable
  // to start anything. An instance context binds a lifetime; it does not make this a lesser
  // environment. A registry it cannot READ is still refused, one line below.
  const registry = instanceFixture(root);
  fs.writeFileSync(registry.context.serviceRegistry, '{"version":1,"services":{"aify-comms":{"endpoint":"http://127.0.0.1:8800"}}}');
  await owner(registry); await ready(registry);
  const unreadable = instanceFixture(root);
  fs.writeFileSync(unreadable.context.serviceRegistry, '{ not json');
  await refused(unreadable, [], 'readable service registry required');
  // B1: only registry contents change during authorization; the context stays identical.
  const race = instanceFixture(root);
  const originalContext = fs.readFileSync(race.file, 'utf8');
  let changedDuringAuthorization = false;
  await owner(race, true, () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(race.context.serviceRegistry)).services, {});
    fs.writeFileSync(race.context.serviceRegistry, '{ mangled during authorization');
    changedDuringAuthorization = true;
  });
  const raced = daemon(['--instance-context', race.file]);
  await until(() => raced.child.exitCode !== null || fs.existsSync(race.context.readinessEndpoint), 'B1 admission outcome');
  assert.equal(changedDuringAuthorization, true);
  assert.equal(fs.readFileSync(race.file, 'utf8'), originalContext);
  assert.equal(fs.readFileSync(race.context.serviceRegistry, 'utf8'), '{ mangled during authorization');
  events.push({ registryChangedDuringAuthorization: true, exitCode: raced.child.exitCode, output: raced.output,
    readyPublished: fs.existsSync(race.context.readinessEndpoint) });
  assert.equal(raced.child.exitCode, 2, 'B1: a registry damaged during authorization must refuse, not publish readiness');
  assert.match(raced.output, /readable service registry required/);
  assert.deepEqual(fs.readdirSync(race.context.root).sort(), ['instance.json', 'services.json']);
  const unknown = instanceFixture(root); await refused(unknown, [], 'instance_context');
  const stranger = instanceFixture(root); await owner(stranger, false); await refused(stranger);
  const occupied = http.createServer((_q, r) => { events.push({ forbiddenIncumbentProbe: true }); r.end(JSON.stringify({ status: 'healthy', pid: process.pid, processes: [], terminals: {} })); });
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const collision = instanceFixture(root); await owner(collision);
  const incumbentPort = occupied.address().port;
  // Dedicated defaults to port zero; an explicit fixture port exercises EADDRINUSE refusal.
  await refused(collision, ['--port', String(incumbentPort)], 'dedicated_port_in_use');
  assert.equal(occupied.listening, true); assert.ok(!events.some(e => e.forbiddenIncumbentProbe)); occupied.close();
  // Layout/descriptor files are inert data. Startup must not enumerate or restore them.
  const old = instanceFixture(root);
  fs.writeFileSync(path.join(old.context.root, 'layout.json'), '{"launch_argv":["forbidden-agent"]}');
  fs.writeFileSync(path.join(old.context.root, 'agent-descriptor.json'), '{"restore":"forbidden-agent"}');
  await owner(old); const restored = await ready(old);
  assert.equal((await request(restored.receipt.endpoint, '/health')).history.startedTotal, 0);
  const launcher = path.join(root, 'owned-aify');
  const workerReceipt = path.join(root, 'worker-ready.json');
  const workerScript = path.join(root, 'worker.mjs');
  fs.writeFileSync(workerScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(workerReceipt)}, JSON.stringify({pid: process.pid})); setInterval(()=>{},1000);`);
  fs.writeFileSync(launcher, '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\nexec "' + process.execPath.replaceAll('\\', '/') + '" "' + workerScript.replaceAll('\\', '/') + '"\n');
  const worker = await request(a.receipt.endpoint, '/processes', 'POST', { service: 'owned-fixture', launcher, args: [], cwd: root, env: clean });
  assert.ok(worker.id); assert.ok(worker.pid);
  const liveWorker = await until(() => {
    try { return JSON.parse(fs.readFileSync(workerReceipt)); } catch { return null; }
  }, 'actual worker executes');
  process.kill(liveWorker.pid, 0);
  assert.ok((await request(a.receipt.endpoint, '/processes')).processes.some(p => p.id === worker.id));
  await request(a.receipt.endpoint, `/processes/${encodeURIComponent(worker.id)}`, 'DELETE');
  await until(async () => !(await request(a.receipt.endpoint, '/processes')).processes.some(p => p.id === worker.id && p.status === 'running'), 'exact worker stop');
  await until(() => {
    try { process.kill(liveWorker.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'actual worker exits after exact-ID stop');
  events.push({ workerExecutedAndStopped: liveWorker.pid, processId: worker.id });
  assert.equal(fs.readFileSync(clean.AIFY_ENV_PROCESS_RECORD, 'utf8'), 'external-record-sentinel');
  assert.ok(fs.existsSync(f.context.processRecord));
  // Edits after validation cannot turn the permanently disabled plugin/advertiser paths on.
  fs.writeFileSync(f.context.serviceRegistry, '{"version":1,"services":{"bad":{"endpoint":"http://invalid.test"}}}');
  const after = await request(a.receipt.endpoint, '/health');
  assert.deepEqual(after.plugins, []); assert.equal(after.advertisingEnabled, false);
} catch (error) { failure = error.stack; }
finally {
  for (const [index, child] of children.entries()) fs.writeFileSync(path.join(root, `daemon-${index}.log`), child.output);
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({ failure, events, children: children.map(c => ({ pid: c.child.pid, args: c.args, exitCode: c.child.exitCode })) }, null, 2));
}
// The retained supervisor Job handle performs final cleanup, not a PID scan or unsupervised kill.
process.exit(failure ? 1 : 0);
