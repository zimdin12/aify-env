// A hermes gateway is live only when its socket opens: an index that serves while /api/ws refuses is not live
// (2026-06-04). Driven against a fake: index and socket are stand-ins, nothing listens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeGateway } from '../lib/hermes-gateway-probe.mjs';
import { freePort } from './_free-port.mjs';

const PORT = await freePort();
const TOKEN = 'tok-123';
const page = `<script>window.__HERMES_SESSION_TOKEN__ = "${TOKEN}";</script>`;

function fake({ serves = true, socket = true } = {}) {
  const fetchImpl = async () => {
    if (!serves) throw new Error('ECONNREFUSED');
    return { ok: true, text: async () => page };
  };
  class WebSocketImpl {
    #listeners = {};
    constructor(url) { this.url = url; setImmediate(() => this.#listeners[socket ? 'open' : 'error']?.()); }
    addEventListener(name, listener) { this.#listeners[name] = listener; }
    close() {}
  }
  return { fetchImpl, WebSocketImpl };
}

test('A LIVE GATEWAY is found by its socket, with the url the delivery loop attaches to', async () => {
  assert.deepEqual(await probeGateway({ port: PORT, ...fake() }),
    { port: PORT, token: TOKEN, wsUrl: `ws://127.0.0.1:${PORT}/api/ws?token=${TOKEN}` });
});

test('NOT LIVE: nothing serving, an index whose socket refuses, or an index with no token', async () => {
  assert.equal(await probeGateway({ port: PORT, ...fake({ serves: false }) }), null);
  assert.equal(await probeGateway({ port: PORT, ...fake({ socket: false }) }), null, 'the 2026-06-04 shape');
  const blank = { fetchImpl: async () => ({ ok: true, text: async () => '<html></html>' }), WebSocketImpl: fake().WebSocketImpl };
  assert.equal(await probeGateway({ port: PORT, ...blank }), null);
});

test('A GATEWAY THAT ACCEPTS AND NEVER ANSWERS is not live, and the probe says so within its bound', async (t) => {
  // It ran inside the agent's book queue unbounded: a relaunch queued behind it and timed out (review of a76e7da, F3).
  const net = await import('node:net');
  const held = [];
  const server = net.createServer((socket) => { held.push(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of held) socket.destroy(); server.close(); });
  const started = Date.now();
  assert.equal(await probeGateway({ port: server.address().port, timeoutMs: 300 }), null);
  const took = Date.now() - started;
  assert.ok(held.length > 0, 'CONTROL: the probe really reached the silent listener');
  assert.ok(took < 3000, `the probe waited ${took} ms on a gateway that never answers`);
});
