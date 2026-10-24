// New activity boundaries. Existing key-confinement tests still own x-api-key and secrets calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DashboardApi } from '../lib/plugins/aify-dashboard/dashboard-api.mjs';
import { fixture, prerequisite, ack, until, delay } from './_activity-fixture.mjs';

for (const [name, declaration] of Object.entries({ absent: undefined, null: null, path: { path: '/other' }, extra: { path: '/api/v1/file-activity', enabled: true }, string: '/api/v1/file-activity' })) {
  test(`capability ${name} authorizes no trial ingress or spool read`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.raw();
    f.capability(declaration); await f.pass();
    assert.equal(f.requests.filter(r => r.path === '/.well-known/aify-service').length, 1, 'existing service endpoint queried');
    assert.deepEqual(f.bodies, [], 'absent or malformed capability blocks all activity POSTs');
    assert.deepEqual(f.raw(), before, 'capability refusal performs no producer mutation');
    assert.equal(fs.existsSync(f.checkpoint), false, 'capability refusal creates no consumer state');
  });
}
for (const [name, change] of Object.entries({
  'relative lease root': a => { a.leaseDirectory = 'relative'; },
  'missing lease root': a => { delete a.leaseDirectory; },
  'relative execution grant': a => { a.wrapperCheckout = 'relative'; },
  'missing execution grant': a => { delete a.wrapperCheckout; },
  'invalid policy': a => { a.maxSessions = 17; },
  'invalid byte policy': a => { a.sessionBytes = 8388609; },
})) {
  test(`${name} refuses activity without advancing persisted data`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.open().read().token;
    change(f.config.activity); f.save(); const p = await f.pass();
    assert.deepEqual(f.bodies, [], 'invalid grant or policy sends nothing');
    assert.deepEqual(f.open().read().token, before, 'invalid configuration preserves cursor');
    assert.ok(p.state().problems.some(p => p.startsWith('file activity:')), 'bounded activity diagnostic is visible');
  });
}

test('absent activity directories are not created to probe coverage', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 0 }); fs.mkdirSync(path.join(f.leases, 'agent-1'), { recursive: true });
  await f.pass(); assert.equal(fs.existsSync(f.directory), false, 'no spool created by discovery');
  assert.deepEqual(f.bodies, [], 'empty discovery is not a complete-history report');
});

test('empty existing activity directory is not initialized by discovery', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 0 }); fs.mkdirSync(f.directory, { recursive: true });
  await f.pass(); assert.deepEqual(fs.readdirSync(f.directory), [], 'consumer does not initialize empty producer directory');
  assert.deepEqual(f.bodies, []);
});

for (const level of ['lease', 'agent', 'activity']) {
  test(`${level} junction refuses discovery without touching its target`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const before = f.raw();
    const original = level === 'lease' ? f.leases : level === 'agent' ? path.dirname(f.directory) : f.directory;
    const target = original + '-target'; fs.renameSync(original, target); fs.symlinkSync(target, original, 'junction');
    await f.pass();
    assert.deepEqual(f.bodies, [], 'junction cannot authorize spool reads');
    assert.deepEqual(f.raw(), before, 'junction target remains untouched');
  });
}

test('unexpected activity file type is refused by the storage owner', { skip: prerequisite }, async t => {
  const f = await fixture(t); fs.mkdirSync(path.join(f.directory, 'slot-15.jsonl'));
  await f.pass(); assert.deepEqual(f.bodies, [], 'unsafe spool has no outbound data');
});

test('one tick sends at most one bounded batch and no immediate drain loop', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 129 });
  await f.pass(); assert.equal(f.bodies.length, 1, 'exactly one batch in a pass');
  assert.equal(f.bodies[0].events.length, 128, 'event bound');
  assert.ok(Buffer.byteLength(JSON.stringify(f.bodies[0])) <= 256 * 1024, 'encoded JSON byte bound');
  assert.ok(f.bodies[0].coverage.gaps.length <= 32, 'gap bound');
  assert.equal(f.open().read().records.length, 1, 'remainder retained for a later tick');
  await f.pass(); assert.equal(f.open().read().token, null, 'next tick sends remainder');
});

test('activity ingress uses only its privilege header while legacy and secrets remain independent', { skip: prerequisite }, async t => {
  const f = await fixture(t);
  const api = new DashboardApi({ endpoint: f.endpoint, credential: async () => f.key, secretsCredential: async () => f.secretsKey });
  await f.pass(); await api.secretValue('p', 'n').catch(() => {});
  const activity = f.requests.find(r => r.path === '/api/v1/file-activity').headers;
  assert.equal(activity['x-aify-activity-key'], f.key, 'activity uses the existing API_KEY');
  assert.equal(activity['x-api-key'], undefined, 'activity cannot present legacy header');
  assert.equal(activity['x-aify-secrets-key'], undefined, 'activity cannot present secrets header');
  const legacy = f.requests.find(r => r.path.includes('/watch-list')).headers;
  assert.equal(legacy['x-api-key'], f.key); assert.equal(legacy['x-aify-activity-key'], undefined);
  const secret = f.requests.at(-1).headers;
  assert.equal(secret['x-aify-secrets-key'], f.secretsKey); assert.equal(secret['x-api-key'], undefined); assert.equal(secret['x-aify-activity-key'], undefined);
});

test('activity redirect never transfers its key and diagnostics never echo remote bytes', { skip: prerequisite }, async t => {
  const f = await fixture(t); const elsewhere = [];
  const server = http.createServer((req, res) => { elsewhere.push(req.headers); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const target = `http://127.0.0.1:${server.address().port}`;
  await fetch(target); assert.equal(elsewhere.length, 1, 'redirect instrument receives healthy control'); elsewhere.length = 0;
  const hostile = `${f.key}:C:/private/source:${'remote-response-'.repeat(1000)}`;
  f.respond(() => ({ status: 307, headers: { location: target }, body: { error: hostile } }));
  const before = f.open().read().token; const p = await f.pass();
  assert.deepEqual(elsewhere, [], 'activity redirects are never followed');
  assert.deepEqual(f.open().read().token, before, 'redirect has no ACK');
  const problems = p.state().problems.join('\n');
  assert.equal(problems.includes(f.key), false, 'credential never reaches doctor');
  assert.equal(problems.includes('C:/private'), false, 'remote path never reaches doctor');
  assert.equal(problems.includes('remote-response'), false, 'remote text never reaches doctor');
  assert.ok(problems.length < 256, 'activity diagnostics bounded independently of remote bytes');
  const api = new DashboardApi({ endpoint: f.endpoint, credential: async () => f.key });
  await assert.rejects(api.fileActivity(f.bodies[0]), error => {
    assert.equal(error.message.includes(f.key), false, 'API refusal cuts credential');
    assert.equal(error.message.includes('C:/private'), false, 'API refusal never echoes remote path');
    assert.equal(error.message.includes('remote-response'), false, 'API refusal never echoes remote bytes');
    assert.ok(error.message.length < 256, 'API refusal bounded'); return true;
  });
});

test('detach aborts and awaits in-flight activity with no late ACK or rescheduled pass', { skip: prerequisite }, async t => {
  const f = await fixture(t); const before = f.open().read().token;
  let entered = false, release;
  const fetchImpl = async (url, options) => {
    if (!String(url).endsWith('/api/v1/file-activity')) return fetch(url, options);
    entered = true;
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(ack(JSON.parse(options.body)))); // deliberately late successful answer
  };
  const p = f.plugin({ overrides: { fetch: fetchImpl, tickMs: 5 } }); await p.start(f.host);
  await until(() => entered, 'activity request started');
  let detached = false; const stopping = p.detach().then(r => { detached = true; return r; });
  await delay(30); assert.equal(detached, false, 'stop awaits transport unwind');
  release(); assert.deepEqual(await stopping, { detached: true, held: 0 });
  assert.deepEqual(f.open().read().token, before, 'late ACK after stop cannot retire source');
  const count = f.requests.length; await delay(40); assert.equal(f.requests.length, count, 'detach schedules no further tick');
});

test('declining to another environment suppresses activity and resume uses the same lifecycle', { skip: prerequisite }, async t => {
  const f = await fixture(t); let other = true;
  const p = f.plugin({ shared: { servedElsewhere: async () => other }, overrides: { tickMs: 15 } });
  await p.start(f.host); await delay(40); assert.deepEqual(f.requests, [], 'declined plugin has no discovery or delivery');
  other = false; await until(() => f.bodies.length > 0, 'activity resumes on maintained tick');
  await until(() => (p.state().activity?.passes ?? 0) >= 1, 'resumed activity pass settles before stop');
  await p.stop(); assert.equal(f.open().read().token, null);
});
