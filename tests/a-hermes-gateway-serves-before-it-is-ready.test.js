// A hermes gateway is ready only when its socket opens, and a start that cannot serve says why at once (0.9.10: the
// start moved here from the comms bridge). Driven against a fake hermes: spawn, index and socket are stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { bootFailure, ownerEnv, probeGateway, startGateway } from '../lib/hermes-gateway-start.mjs';
import { freePort } from './_free-port.mjs';

const TOKEN = 'tok-123';
// Nothing listens: the gateway, its index and its socket are fakes; the port is only what the start is told.
const PORT = await freePort();
const page = (token) => `<script>window.__HERMES_SESSION_TOKEN__ = "${token}";</script>`;

/** A fake hermes. `serves` is when the index starts answering (false: never); `socket` whether /api/ws opens. */
function fakeHermes(t, { serves = 0, socket = true, writes = '', exitWith = null } = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-gateway-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const calls = [];
  let started = null;
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (writes) fs.writeSync(options.stdio[2], writes);
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    started = Date.now();
    if (exitWith !== null) setImmediate(() => child.emit('exit', exitWith, null));
    return child;
  };
  const fetchImpl = async () => {
    if (serves === false || started === null || Date.now() - started < serves) throw new Error('ECONNREFUSED');
    return { ok: true, text: async () => page(TOKEN) };
  };
  class WebSocketImpl {
    #listeners = {};
    constructor(url) { this.url = url; setImmediate(() => this.#listeners[socket ? 'open' : 'error']?.()); }
    addEventListener(name, listener) { this.#listeners[name] = listener; }
    close() {}
  }
  return { logDir, calls, spawn, fetchImpl, WebSocketImpl };
}

test('READY WHEN THE SOCKET OPENS: the start answers the socket url, tied to the agent and not to this process', async (t) => {
  const h = fakeHermes(t, { serves: 30 });
  const ready = await startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, env: { PATH: 'x', HERMES_PARENT_NONCE: 'inherited' },
    spawn: h.spawn, fetchImpl: h.fetchImpl, WebSocketImpl: h.WebSocketImpl, intervalMs: 5 });
  assert.deepEqual(ready, { port: PORT, token: TOKEN, wsUrl: `ws://127.0.0.1:${PORT}/api/ws?token=${TOKEN}`, pid: 4242 });
  const [{ cmd, args, options }] = h.calls;
  assert.equal(cmd, 'hermes');
  assert.deepEqual(args, ['dashboard', '--port', String(PORT), '--host', '127.0.0.1', '--no-open', '--skip-build']);
  assert.equal(options.detached, true, 'an aify-env restart must not end it');
  assert.equal(options.env.HERMES_PARENT_PID, '777', "hermes' watchdog ends it with its agent");
  assert.equal(options.env.HERMES_PARENT_NONCE, '', 'an inherited nonce describes some other parent');
  assert.equal(options.env.HERMES_YOLO_MODE, '1');
});

test('AN INDEX WITHOUT A SOCKET IS NOT READY: the start waits to its deadline and says so', async (t) => {
  const h = fakeHermes(t, { socket: false });
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, readyTimeoutMs: 60, intervalMs: 5 }), /did not serve within 60 ms: .*refused \/api\/ws/);
});

test('AN EXIT BEFORE SERVING refuses at once with its last line, and its token never leaves', async (t) => {
  const h = fakeHermes(t, { serves: false, exitWith: 1, writes: 'starting on token=s3cret\nOSError: [Errno 98] address in use token=s3cret\n' });
  const started = Date.now();
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, intervalMs: 5 }), (error) => {
    assert.match(error.message, /exited before it served: exit 1; it last wrote: OSError: \[Errno 98\] address in use token=<redacted>/);
    assert.doesNotMatch(error.message, /s3cret/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'the ten-minute deadline was not waited out');
});

test('THE KNOWN BOOT FAILURE refuses at once, before the deadline', async (t) => {
  const h = fakeHermes(t, { serves: false, writes: 'Installing TUI dependencies...\nnpm error Missing script: "build"\n' });
  await assert.rejects(startGateway({ port: PORT, ownerPid: 777, logDir: h.logDir, spawn: h.spawn, fetchImpl: h.fetchImpl,
    WebSocketImpl: h.WebSocketImpl, intervalMs: 5 }), /TUI dependency build failed/);
  assert.equal(bootFailure('dashboard listening on 127.0.0.1:9341'), '', 'CONTROL: an ordinary boot line is no failure');
});

test('A LIVE GATEWAY IS FOUND by its socket; a dead one, or one refusing its socket, is not', async (t) => {
  const live = fakeHermes(t, { serves: 0 });
  live.spawn('hermes', [], { stdio: [0, 0, 'ignore'] });
  assert.deepEqual(await probeGateway({ port: PORT, fetchImpl: live.fetchImpl, WebSocketImpl: live.WebSocketImpl }),
    { port: PORT, token: TOKEN, wsUrl: `ws://127.0.0.1:${PORT}/api/ws?token=${TOKEN}` });
  const dead = fakeHermes(t, { serves: false });
  assert.equal(await probeGateway({ port: PORT, fetchImpl: dead.fetchImpl, WebSocketImpl: dead.WebSocketImpl }), null);
  const closed = fakeHermes(t, { socket: false });
  closed.spawn('hermes', [], { stdio: [0, 0, 'ignore'] });
  assert.equal(await probeGateway({ port: PORT, fetchImpl: closed.fetchImpl, WebSocketImpl: closed.WebSocketImpl }), null);
});

test('NO LAUNCHER PID, NO OWNER: nothing is set rather than a wrong parent', () => {
  for (const pid of [undefined, 0, -1, 'x', 1.5]) assert.deepEqual(ownerEnv(pid), {}, String(pid));
  assert.deepEqual(ownerEnv(12), { HERMES_PARENT_PID: '12', HERMES_PARENT_START_MARKER: '', HERMES_PARENT_NONCE: '' });
});
