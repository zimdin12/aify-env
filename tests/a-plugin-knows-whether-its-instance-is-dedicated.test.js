// The shared boot payload decides whether a plugin defers; the entry still owns the default endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BootFixture } from './fixtures/daemon-boot.mjs';

const daemon = fs.readFileSync(new URL('../bin/aify-env.mjs', import.meta.url), 'utf8');

test('a dedicated instance asks and forwards the plugin stop signal', async () => {
  const asked = [], stop = new AbortController();
  const dedicated = new BootFixture(); dedicated.options.instanceContext = { root: '/fixture-instance' };
  dedicated.options.servedElsewhere = async options => { asked.push(options?.signal); return true; };
  await dedicated.boot();
  assert.equal(await dedicated.captured.shared.servedElsewhere({ signal: stop.signal }), true);
  assert.deepEqual({ count: asked.length, sameSignal: asked[0] === stop.signal }, { count: 1, sameSignal: true });
});

test('an ordinary daemon never asks whether somebody else serves', async () => {
  const ordinary = new BootFixture(); let asks = 0;
  ordinary.options.servedElsewhere = async () => { asks++; return true; };
  await ordinary.boot();
  assert.deepEqual({ answer: await ordinary.captured.shared.servedElsewhere(), asks }, { answer: false, asks: 0 });
});

test('the entry supplies the ordinary default endpoint to the dedicated probe', () => {
  // Unmoved entry wiring: the boot API receives this callback, rather than owning a second endpoint policy.
  assert.match(daemon, /servedElsewhere: \(\{ signal \} = \{\}\) => anotherServesAt\(`http:\/\/127\.0\.0\.1:\$\{DEFAULT_PORT\}`, \{ signal \}\)/);
});
