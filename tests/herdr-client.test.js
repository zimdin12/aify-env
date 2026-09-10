import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { sealedDaemonEnv } from './_sealed-daemon-env.mjs';
import { attachCommand, endpoint, socketPath, selectWorker, detectHerdr, openWorker, HerdrClient, listWorkers } from '../lib/herdr.mjs';

test('endpoint and socket validation fail closed before network activity', () => {
  for (const value of ['', 'http://example.com:8802', 'http://127.0.0.1:1/path', 'http://u:p@127.0.0.1:1', 'http://127.1:8802', 'http://127.0.0.1:70000']) assert.throws(() => endpoint(value));
  assert.equal(endpoint('http://127.0.0.1:12345'), 'http://127.0.0.1:12345');
  assert.throws(() => socketPath(''));
  assert.throws(() => socketPath('bad\npipe'));
});

test('selection rejects non-PTY, ambiguous and malformed targets', () => {
  const workers = [{ id: 'uuid-p1', label: 'lead', terminal: true }, { id: 'uuid-p2', label: 'lead', terminal: true }];
  assert.equal(selectWorker(workers, 'uuid-p1').id, 'uuid-p1');
  assert.throws(() => selectWorker(workers, 'lead'));
  assert.throws(() => selectWorker([{ id: 'x;calc', terminal: true }], 'x;calc'));
  assert.throws(() => selectWorker([{ id: 'x', terminal: false }], 'x'));
});

test('encoded PowerShell arguments retain metacharacters as single-quoted data', () => {
  const text = attachCommand({ node: "C:/a'b/$()&/node.exe", script: 'C:/two words/$env:X.mjs', base: 'http://127.0.0.1:12345', id: 'uuid-p1' });
  const decoded = Buffer.from(text.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(decoded, "$env:AIFY_ENV_ENDPOINT='http://127.0.0.1:12345'; & 'C:/a''b/$()&/node.exe' 'C:/two words/$env:X.mjs' attach --id 'uuid-p1'");
  assert.throws(() => attachCommand({ node: 'bad\rpath', script: 'ok', base: 'http://127.0.0.1:12345', id: 'uuid-p1' }));
});

test('known Windows install detection is passive and needs no PATH entry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'Programs/Herdr/bin/herdr.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'not executable');
  assert.equal(detectHerdr({ PATH: '', LOCALAPPDATA: root }), binary);
});

test('unsupported shell receives no command or destructive rollback', async () => {
  const calls = [];
  const client = { call: async (method) => {
    calls.push(method);
    if (method === 'ping') return { type: 'pong', version: '0.9.0', protocol: 22 };
    if (method === 'workspace.create') return { root_pane: { pane_id: 'w1:p1' } };
    return { process_info: { shell_pid: 42, foreground_processes: [{ pid: 42, name: 'cmd.exe' }] } };
  } };
  await assert.rejects(openWorker({ client, worker: { id: 'uuid-p1' }, base: 'http://127.0.0.1:12345', node: 'node', script: 'cli', cwd: '.' }), /PowerShell/);
  assert.deepEqual(calls, ['ping', 'workspace.create', 'pane.process_info']);
});

test('dispatcher rejects install and unknown arguments without starting anything', () => {
  const result = spawnSync(process.execPath, [new URL('../bin/aify-env.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), 'herdr', '--install'], { env: sealedDaemonEnv(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 69);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout, /listening on/);
});

test('HerdrClient correlates real socket replies and refuses mismatched ids', async t => {
  const socket = process.platform === 'win32' ? 'herdr-test-' + randomUUID() : path.join(os.tmpdir(), randomUUID() + '.sock');
  const requests = [];
  const server = net.createServer(stream => {
    let text = '';
    stream.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      const request = JSON.parse(text.trim());
      requests.push(request);
      stream.end(JSON.stringify({ id: request.method === 'ping' ? request.id : 'wrong-id', result: { type: 'pong' } }) + '\n');
    });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(socketPath(socket));
  await once(server, 'listening');
  const client = new HerdrClient(socket);
  assert.deepEqual(await client.call('ping', { proof: 'request-data' }), { type: 'pong' });
  assert.deepEqual(requests[0].params, { proof: 'request-data' });
  assert.equal(requests[0].method, 'ping');
  await assert.rejects(client.call('invalid-reply'), /wrong-id/);
});

test('listWorkers uses the process route and refuses redirects and malformed lists', async t => {
  const workers = [{ id: 'uuid-p1', terminal: true }];
  let mode = 'list';
  const routes = [];
  const server = http.createServer((request, response) => {
    routes.push(request.url);
    if (mode === 'redirect') response.writeHead(302, { location: '/elsewhere' });
    response.end(JSON.stringify(mode === 'list' ? { processes: workers } : {}));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.deepEqual(await listWorkers(base), workers);
  mode = 'malformed';
  await assert.rejects(listWorkers(base), /process list/);
  mode = 'redirect';
  await assert.rejects(listWorkers(base));
  assert.deepEqual(routes, ['/processes', '/processes', '/processes']);
});
