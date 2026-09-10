import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { socketPath } from '../lib/herdr.mjs';
const cli = fileURLToPath(new URL('../bin/aify-env.mjs', import.meta.url));
async function run(args, env) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const timer = setTimeout(() => child.kill(), 10000);
  try { const [code] = await once(child, 'close'); return { code, out, err }; }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-identity-'));
  const binary = path.join(root, 'Programs/Herdr/bin/herdr.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'passive detection only');
  const state = { lists: 0, calls: [], initial: [{ id: 'old-p1', label: 'lead', terminal: true }], current: [{ id: 'other-p2', label: 'old-p1', terminal: true }] };
  const server = http.createServer((q, s) => { assert.equal(q.url, '/processes'); s.end(JSON.stringify({ processes: ++state.lists === 1 ? state.initial : state.current })); });
  const socket = process.platform === 'win32' ? 'identity-' + randomUUID() : path.join(root, 'rpc.sock');
  const rpc = net.createServer(s => { let text = ''; s.on('data', b => {
    text += b; if (!text.includes('\n')) return;
    const q = JSON.parse(text); state.calls.push(q);
    const answers = { ping: { type: 'pong', version: '0.9.0', protocol: 22 }, 'workspace.create': { type: 'created', workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'p1' } }, 'pane.process_info': { type: 'info', process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'powershell.exe' }] } }, 'pane.send_text': { type: 'sent' }, 'pane.get': { type: 'pane', pane: { pane_id: 'p1' } } };
    s.end(JSON.stringify({ id: q.id, result: answers[q.method] }) + '\n');
  }); });
  server.listen(0, '127.0.0.1'); rpc.listen(socketPath(socket));
  await Promise.all([once(server, 'listening'), once(rpc, 'listening')]);
  t.after(async () => { await Promise.all([new Promise(r => server.close(r)), new Promise(r => rpc.close(r))]); fs.rmSync(root, { recursive: true, force: true }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(k)));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, AIFY_ENV_ENDPOINT: 'http://127.0.0.1:' + server.address().port, HERDR_SOCKET_PATH: socket, AIFY_ADVERTISE: '0', AIFY_SERVICE_REGISTRY: path.join(root, 'absent.json') });
  return { state, env };
}
for (const wanted of ['old-p1', 'lead']) test('shipped dispatcher refuses vanished initial choice: ' + wanted, { skip: process.platform !== 'win32' }, async t => {
  const { state, env } = await fixture(t);
  const result = await run(['herdr', wanted], env);
  assert.equal(state.lists, 2);
  assert.equal(result.code, 69, JSON.stringify(result));
  assert.deepEqual(state.calls, [], 'no workspace or command for a replacement label');
});
test('final shipped attach --id refuses label collision, ordinary label still resolves', async t => {
  const { state, env } = await fixture(t); state.initial = state.current;
  const exact = await run(['attach', '--id', 'old-p1'], env);
  assert.equal(exact.code, 64);
  assert.match(exact.err, /No process with exact id/);
  assert.doesNotMatch(exact.err, /needs a terminal/);
  const human = await run(['attach', 'old-p1'], env);
  assert.match(human.err, /needs a terminal/, 'human label convenience reaches terminal validation');
});
test('fixture ownership is creation-bound, never acquired from logs', () => {
  const source = fs.readFileSync(new URL('./manual/herdr-owned-processes.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /GetProcessById|StartTime|TotalMilliseconds|\$Log/);
  assert.match(source, /CREATE_SUSPENDED/);
  assert.match(source, /AssignProcessToJobObject/);
  assert.match(source, /TerminateJobObject/);
  assert.ok(source.indexOf('Require(AssignProcessToJobObject(job, pi.process))') < source.indexOf('if (ResumeThread(pi.thread)'));
});
test('real job supervisor contains a detached child and rejects unowned membership', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-job-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `import {spawn} from 'node:child_process'; import fs from 'node:fs';\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); fs.writeFileSync(${JSON.stringify(path.join(root, 'created'))},'created');`);
  const ps = path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const controller = fileURLToPath(new URL('./manual/herdr-owned-processes.ps1', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(k)));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root });
  const result = spawnSync(ps, ['-NoProfile', '-File', controller, '-Node', process.execPath, '-Fixture', fixture, '-Binary', 'unused', '-Root', root], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'created'), 'utf8'), 'created');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'job-receipt.json'), 'utf8')), { assignedBeforeResume: true, exitCode: 0, activeProcessesAfterTerminate: 0 });
  const denied = spawnSync(ps, ['-NoProfile', '-File', controller, '-CheckJob', 'Local\\\\missing-' + randomUUID()], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(denied.status, 0);
});
