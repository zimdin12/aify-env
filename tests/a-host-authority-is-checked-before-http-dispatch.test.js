// #16: the real HTTP boundary must reject rebinding before a body, dependency or console subscription is used.
// Existing browser tests own Origin/Sec-Fetch classification; this file owns authority and its transport wiring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listWorkers } from '../lib/herdr.mjs';
import { authorityServer, authorityRequest } from './fixtures/http-authority.mjs';

for (const method of ['GET', 'POST']) {
  for (const metadata of [false, true]) {
    test(`attacker Host ${method}, ${metadata ? 'same-origin' : 'no browser metadata'}, is refused before effects`, async t => {
      const { port, seen } = await authorityServer(t);
      const result = await authorityRequest(port, { method, host: 'rebind.attacker.example:8802',
        path: method === 'POST' ? '/agents/a/start' : '/processes/p/output', body: method === 'POST' ? '{}' : '',
        headers: metadata ? { 'Sec-Fetch-Site': 'same-origin' } : {},
      });
      assert.deepEqual({ status: result.status, bodies: seen.bodies, deps: seen.deps, streams: seen.streams },
        { status: 403, bodies: 0, deps: 0, streams: 0 }, 'authority refusal and absence of downstream effects');
      assert.match(result.text, /http\.trustedAuthorities/, 'refusal must name the operator setting');
    });
  }
}

const badHosts = [
  null, 'localhost.evil.example', 'user@localhost', 'localhost/path', 'localhost?x', 'localhost#x',
  'localhost:bad', 'localhost:', 'localhost:65536', 'localhost:-1', 'localhost:80:90',
  '127.1', '2130706433', '0x7f000001', '127.000.0.1', '[::1', '::1', '[::2]', '[fe80::1%eth0]', 'localhost,evil.example',
];
for (const host of badHosts) {
  test(`missing or invalid authority ${JSON.stringify(host)} is refused`, async t => {
    const { port, seen } = await authorityServer(t);
    const result = await authorityRequest(port, { host });
    if (host === null) assert.ok([400, 403].includes(result.status), 'missing Host was not refused by HTTP parsing or the guard');
    else assert.equal(result.status, 403, 'invalid authority was admitted');
    assert.equal(seen.deps, 0, 'invalid authority resolved dependencies');
  });
}

test('two raw Host fields cannot hide behind Node’s first collapsed header', async t => {
  const { port, seen } = await authorityServer(t);
  const result = await authorityRequest(port, { rawHeaders: ['Host', 'localhost', 'hOsT', 'evil.example'] });
  assert.equal(result.status, 403);
  assert.equal(seen.deps, 0);
});

for (const host of ['localhost', 'LOCALHOST:4567', '127.0.0.1', '127.42.0.9:1234', '[::1]', '[0:0:0:0:0:0:0:1]:1234']) {
  test(`local authority ${host} remains accepted without bound-port matching`, async t => {
    const { port, seen } = await authorityServer(t);
    const result = await authorityRequest(port, { host });
    assert.equal(result.status, 200, result.text);
    assert.equal(seen.deps, 1);
  });
}

test('a configured forwarded Host is refused without opt-in and accepted with the explicit setting', async t => {
  const ordinary = await authorityServer(t);
  const refused = await authorityRequest(ordinary.port, { host: '192.0.2.17:9443' });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /http\.trustedAuthorities/);
  assert.equal(ordinary.seen.deps, 0);
  const trusted = await authorityServer(t, { http: { trustedAuthorities: ['192.0.2.17:9443'] } });
  assert.equal((await authorityRequest(trusted.port, { host: '192.0.2.17:9443' })).status, 200);
  assert.equal((await authorityRequest(trusted.port, { host: '192.0.2.17:9444' })).status, 403, 'port-scoped trust widened');
});

test('a host-only grant allows its ports but neither a suffix nor another hostname', async t => {
  const { port } = await authorityServer(t, { http: { trustedAuthorities: ['Proxy.Example'] } });
  assert.equal((await authorityRequest(port, { host: 'proxy.example:9443' })).status, 200);
  assert.equal((await authorityRequest(port, { host: 'proxy.example' })).status, 200);
  assert.equal((await authorityRequest(port, { host: 'proxy.example.evil:9443' })).status, 403);
});

test('a malformed extra list fails closed as a whole, while loopback stays usable', async t => {
  const { port } = await authorityServer(t, { http: { trustedAuthorities: ['proxy.example', '*'] } });
  assert.equal((await authorityRequest(port, { host: 'proxy.example' })).status, 403, 'partially applied a malformed grant');
  assert.equal((await authorityRequest(port)).status, 200);
});

test('forwarded-host metadata never grants trust or overrides the request authority', async t => {
  const { port } = await authorityServer(t);
  assert.equal((await authorityRequest(port, { host: 'evil.example', headers: { 'X-Forwarded-Host': 'localhost' } })).status, 403);
  assert.equal((await authorityRequest(port, { headers: { 'X-Forwarded-Host': 'evil.example' } })).status, 200);
});

test('a trusted authority does not bypass Origin or Sec-Fetch guards', async t => {
  const { port, seen } = await authorityServer(t, { http: { trustedAuthorities: ['proxy.example'] } });
  for (const headers of [{ Origin: 'null' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await authorityRequest(port, { host: 'proxy.example', headers })).status, 403);
  }
  assert.equal((await authorityRequest(port, { method: 'POST', path: '/agents/a/start', host: 'proxy.example', headers: { 'Sec-Fetch-Site': 'same-origin' }, body: '{}' })).status, 403);
  assert.equal(seen.deps, 0, 'trusted Host bypassed browser protection');
});

// These route/method/authority shapes come from the source census, not a request to an installed service.
for (const [client, method, route] of [
  ['doctor and install-state', 'GET', '/health'], ['Herdr worker listing', 'GET', '/processes'],
  ['turn hook', 'POST', '/agents/a/turn-event'], ['resident-start hook', 'POST', '/agents/a/resident-started'],
  ['Hermes gateway', 'POST', '/agents/a/gateway'],
]) {
  test(`${client} sends its literal-loopback request without browser metadata`, async t => {
    const { port, seen, endpoint } = await authorityServer(t);
    if (client === 'Herdr worker listing') {
      let workers;
      await assert.doesNotReject(async () => { workers = await listWorkers(endpoint); }, 'real Herdr loopback request must remain admitted');
      assert.deepEqual(workers, []);
    } else if (client === 'turn hook' || client === 'resident-start hook' || client === 'Hermes gateway') {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-hook-'));
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      fs.mkdirSync(path.join(home, '.aify', 'env'), { recursive: true });
      fs.writeFileSync(path.join(home, '.aify', 'env', 'residents.json'), JSON.stringify({
        instance: 'residents', pid: 123, startedAt: new Date().toISOString(), url: endpoint,
      }));
      const env = { HOME: home, USERPROFILE: home, AIFY_ENV_INSTANCE: 'residents',
        AIFY_LIFETIME: '11111111-1111-4111-8111-111111111111', AIFY_AGENT_ID: 'fixture', AIFY_AGENT_LEASE: '123' };
      if (client === 'Hermes gateway') {
        assert.ok(process.env.AIFY_WRAPPER_REPO, 'required wrapper checkout is not configured');
        const { ensureGateway } = await import(pathToFileURL(path.join(process.env.AIFY_WRAPPER_REPO, 'lib', 'hermes-gateway-ensure.mjs')).href);
        let gateway;
        await assert.doesNotReject(async () => { gateway = await ensureGateway({ agentId: 'fixture', env, logDir: home,
          start: async () => assert.fail('fixture must not launch a gateway'), stop: async () => assert.fail('fixture must not stop a process') }); },
        'real descriptor-bound gateway request must remain admitted');
        assert.equal(gateway.port, 4444);
        assert.equal(gateway.token, 'fixture');
      } else {
        assert.ok(process.env.AIFY_COMMS_REPO, 'required comms checkout is not configured');
        const hooks = await import(pathToFileURL(path.join(process.env.AIFY_COMMS_REPO, 'mcp', 'stdio', 'agent-state-event.mjs')).href);
        const posted = client === 'turn hook'
          ? await hooks.postEnvAgentState('turn-start', { env, firedAtUs: 1700000000000000 })
          : await hooks.postEnvResidentStarted('claude', { hook_event_name: 'SessionStart', session_id: 'fixture-native-session' }, { env });
        assert.equal(posted, true, 'real descriptor-bound hook request was refused');
      }
    } else {
      const result = await authorityRequest(port, { method, path: route, headers: { 'Sec-Fetch-Mode': 'cors' } });
      assert.equal(result.status, 200, result.text);
    }
    assert.deepEqual(seen.hosts, [`127.0.0.1:${port}`]);
    assert.ok(seen.requests.every(request => request.status === 200));
  });
}

test('local browser health navigation and local console streaming retain their old behavior', async t => {
  const { port, seen } = await authorityServer(t);
  assert.equal((await authorityRequest(port, { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
  const stream = await authorityRequest(port, { path: '/processes/p/output', headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /text\/event-stream/);
  assert.match(stream.text, /event: exit/);
  assert.equal(seen.streams, 1);
});
