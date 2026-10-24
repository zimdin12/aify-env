// New coverage for API error cuts and execution-grant effects, not merely return decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DashboardApi } from '../lib/plugins/aify-dashboard/dashboard-api.mjs';
import { fixture, prerequisite, ack, until, delay } from './_activity-fixture.mjs';

for (const phase of ['fetch', 'body']) {
  test(`activity API ${phase} errors cannot expose credentials or remote path bytes`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.open().read().token;
    const hostile = `${f.key}:C:/private/activity:${'remote-error-'.repeat(500)}`;
    const transport = async (url, options) => {
      if (!String(url).endsWith('/api/v1/file-activity')) return fetch(url, options);
      if (phase === 'fetch') throw new Error(hostile);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(hostile)); } }));
    };
    await f.pass({ overrides: { fetch: transport } });
    assert.deepEqual(f.open().read().token, before, 'transport/body error never advances real cursor');
    const api = new DashboardApi({ endpoint: f.endpoint, credential: async () => f.key, fetch: transport });
    await assert.rejects(api.fileActivity({}), error => {
      assert.equal(error.message.includes(f.key), false, `${phase} credential cut`);
      assert.equal(error.message.includes('C:/private'), false, `${phase} remote path excluded`);
      assert.equal(error.message.includes('remote-error'), false, `${phase} remote bytes excluded`);
      assert.ok(error.message.length < 256, `${phase} diagnostics bounded`); return true;
    });
  });
}

test('oversized activity response is not an ACK and is bounded by the API owner', { skip: prerequisite }, async t => {
  const f = await fixture(t); const before = f.open().read().token;
  f.respond(b => ({ raw: JSON.stringify(ack(b)) + ' '.repeat(256 * 1024) }));
  await f.pass(); assert.deepEqual(f.open().read().token, before, 'oversized reply cannot authorize cursor advancement');
  const api = new DashboardApi({ endpoint: f.endpoint, credential: async () => f.key });
  await assert.rejects(api.fileActivity(f.bodies[0]), /response could not be read/, 'API itself enforces bounded response');
});

test('activity resolves the existing credential afresh for each request and honors a pending stop', { skip: prerequisite }, async t => {
  const f = await fixture(t); await f.pass(); const body = f.bodies[0];
  let key = f.key;
  const api = new DashboardApi({ endpoint: f.endpoint, credential: async () => key });
  await api.fileActivity(body); key = randomUUID(); await api.fileActivity(body);
  const calls = f.requests.filter(r => r.path === '/api/v1/file-activity');
  assert.equal(calls.at(-2).headers['x-aify-activity-key'], f.key);
  assert.equal(calls.at(-1).headers['x-aify-activity-key'], key, 'rotated existing API_KEY reaches next request');
  let release, entered = false; const cancel = new AbortController();
  const held = new DashboardApi({ endpoint: f.endpoint, credential: async () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  const pending = held.fileActivity(body, { signal: cancel.signal });
  await until(() => entered, 'credential request pending'); cancel.abort(); const count = f.requests.length; release(key);
  await assert.rejects(pending, /stopped before it was sent/, 'pending credential stop is identified before transport'); await delay(20);
  assert.equal(f.requests.length, count, 'no activity request after stop while credential pending');
});

test('duplicate event receipts and reordered exact gap ACKs commit the persisted prefix', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 3 }); const first = f.open().read();
  f.open().resolve(first.token, { eventIds: first.token.eventIds.slice(0, 2), reason: 'refused' });
  f.respond(b => { const a = ack(b); a.results.forEach(r => { r.disposition = 'duplicate'; }); a.coverage.acknowledgedGapIds.reverse(); return { body: a }; });
  await f.pass(); assert.equal(f.open().read().token, null, 'duplicate facts and exact unique gaps authorize retirement');
});

function executionProbe(f) {
  const checkout = path.join(f.root, 'granted-wrapper'); fs.mkdirSync(path.join(checkout, 'lib'), { recursive: true });
  const marker = path.join(f.root, 'module-imported');
  const adapter = pathToFileURL(path.join(process.env.AIFY_WRAPPER_REPO, 'lib/file-activity.mjs')).href;
  const spool = pathToFileURL(path.join(process.env.AIFY_WRAPPER_REPO, 'lib/activity-spool.mjs')).href;
  fs.writeFileSync(path.join(checkout, 'lib/file-activity.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'imported'); export * from ${JSON.stringify(adapter)};`);
  fs.writeFileSync(path.join(checkout, 'lib/activity-spool.mjs'), `export * from ${JSON.stringify(spool)};`);
  f.config.activity.wrapperCheckout = checkout; return marker;
}

test('off execution grant imports nothing while live opt-in executes the granted wrapper', { skip: prerequisite }, async t => {
  const f = await fixture(t); const marker = executionProbe(f);
  f.config.activity.enabled = false; f.save();
  const p = f.plugin({ overrides: { tickMs: 20 } }); await p.start(f.host); await delay(60);
  assert.equal(fs.existsSync(marker), false, 'default-off never imports granted code');
  assert.deepEqual(f.bodies, [], 'off has no activity traffic');
  f.config.activity.enabled = true; f.save(); await until(() => fs.existsSync(marker), 'positive control executes granted code');
  await until(() => f.bodies.length === 1, 'live configuration enables production delivery');
  await until(() => f.open().read().token === null, 'live configuration pass commits its receipt');
  await p.stop(); assert.equal(f.open().read().token, null);
});

for (const declaration of ['absent', 'malformed']) {
  test(`${declaration} service declaration cannot execute the wrapper grant`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const marker = executionProbe(f); f.save();
    f.capability(declaration === 'absent' ? undefined : { path: '/different' }); await f.pass();
    assert.equal(fs.existsSync(marker), false, 'capability refusal precedes execution grant import');
    f.capability({ path: '/api/v1/file-activity' }); await f.pass();
    assert.equal(fs.existsSync(marker), true, 'same grant imports with admitted capability');
    assert.equal(f.bodies.length, 1, 'only enabled declared capability delivers');
  });
}
