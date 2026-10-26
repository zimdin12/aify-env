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
