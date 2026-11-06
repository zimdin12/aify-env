// Entry tests own published-file/200/401 wiring. These pin the remaining status, fault and confirmation branches.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { InstallCredentialReadiness } from '../lib/install-credential-readiness.mjs';
import { InstallCredentialRegistration } from '../lib/install-credential-registration.mjs';
import { CREDENTIAL_ABSENT, CREDENTIAL_CONFLICT, CREDENTIAL_FAULTS, CREDENTIAL_INVALID, CREDENTIAL_OK } from '../lib/credential-store.mjs';
import { CredentialInstallFixture, PEER_REQUIRED, KEY, ROOT } from './fixtures/install-credentials.mjs';

function reader(f, { env = f.environment(), probeTimeoutMs = 2000, ...over } = {}) {
  const registration = new InstallCredentialRegistration({ env, home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot, timeoutMs: probeTimeoutMs });
  return new InstallCredentialReadiness({ env, root: f.root, registration, ...over });
}
const safe = result => assert.equal(JSON.stringify(result).includes(KEY), false, 'readiness metadata exposes a credential value');

for (const [name, status, kind, ready] of [['no-content success', 204, 'keyless', true], ['forbidden', 403, 'required', false],
  ['unavailable API', 503, 'unknown', false], ['unexpected not-found', 404, 'unknown', false]]) {
  test(`declared API ${name} (${status}) has its own readiness verdict`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t, { status });
    const answer = await reader(f).inspect(f.target());
    assert.deepEqual({ ready: answer.ready, kind: answer.kind, probe: f.requests.some(r => r.path === '/declared-api'), health: f.requests.some(r => r.path === '/health') },
      { ready, kind, probe: true, health: false });
    assert.equal(f.requests.some(r => r.headers['x-api-key'] || r.headers.authorization || r.headers.cookie), false); safe(answer);
  });
}

test('an explicitly optional spec secret needs no request to the protected API', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { required: false, status: 503 });
  const answer = await reader(f).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, paths: f.requests.map(r => r.path) },
    { ready: true, kind: 'keyless', paths: ['/.well-known/aify-service'] }); safe(answer);
});

test('a required secret with no declared probe remains unknown, not keyless or missing-by-guess', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { probe: false });
  const answer = await reader(f).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, calls: f.requests.length }, { ready: false, kind: 'unknown', calls: 1 });
});

test('a probe redirect is not followed and cannot turn an unauthenticated request into readiness', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { status: 302 }); f.location = f.endpoint + '/redirect-trap';
  const answer = await reader(f).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, redirected: f.requests.some(r => r.path === '/redirect-trap') },
    { ready: false, kind: 'unknown', redirected: false });
});

test('an invalid spec cannot supply an authentication path or enter readiness diagnostics', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { status: 200 }); f.spec.name = KEY;
  const answer = await reader(f).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, api: f.requests.some(r => r.path === '/declared-api') },
    { ready: false, kind: 'unknown', api: false }); safe(answer);
});

test('an optional secret in a spec with an invalid cross-origin probe still cannot grant readiness', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { required: false });
  f.spec.verify.probes.api.path = 'http://forbidden.invalid/probe';
  const answer = await reader(f).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, paths: f.requests.map(r => r.path) },
    { ready: false, kind: 'unknown', paths: ['/.well-known/aify-service'] });
});

test('an unreachable service stays unknown without changing credential configuration', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t);
  await new Promise(resolve => { f.server.close(resolve); f.server.closeAllConnections(); });
  const answer = await reader(f).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind }, { ready: false, kind: 'unknown' });
});

test('a bounded probe timeout is unknown, with a healthy required-probe control on the same source', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t); f.holdProbe = true;
  const absent = await reader(f, { probeTimeoutMs: 30 }).inspect(f.target());
  f.holdProbe = false;
  const required = await reader(f).inspect(f.target());
  assert.deepEqual({ timedOut: [absent.ready, absent.kind], answered: [required.ready, required.kind] },
    { timedOut: [false, 'unknown'], answered: [false, 'required'] });
});

for (const state of CREDENTIAL_FAULTS.filter(state => state !== CREDENTIAL_CONFLICT)) {
  test(`${state} cannot be masked by a keyless deployment`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t, { status: 200 });
    const check = reader(f, { resolve: async () => ({ state, value: '', detail: 'fixture fault' }) });
    const answer = await check.inspect(f.target());
    assert.deepEqual({ ready: answer.ready, kind: answer.kind, state: answer.state, requests: f.requests.length },
      { ready: false, kind: 'fault', state, requests: 0 });
  });
}

test('an environment-only runtime credential is configured, not falsely described as stored', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t);
  const answer = await reader(f, { env: f.environment({ FIXTURE_SERVICE_KEY: KEY }) }).inspect(f.target());
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, state: answer.state, source: answer.source, requests: f.requests.length },
    { ready: true, kind: 'credential', state: CREDENTIAL_OK, source: 'env', requests: 0 });
  assert.doesNotMatch(answer.reason, /stored/); safe(answer);
});

test('the actual resolver keeps an environment/file conflict above keyless readiness', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { status: 200 }), ref = await f.store();
  const answer = await reader(f, { env: f.environment({ FIXTURE_SERVICE_KEY: 'different-private-key' }) }).inspect(f.target({ credentialRef: ref }));
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, state: answer.state, requests: f.requests.length },
    { ready: false, kind: 'fault', state: CREDENTIAL_CONFLICT, requests: 0 }); safe(answer);
});

test('post-publication confirmation compares literal resolved bytes, without reporting them', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t), ref = await f.store(), check = reader(f), target = f.target({ credentialRef: ref });
  const wrong = await check.inspect(target, { expectedValue: 'not-the-requested-key', requirePublishedRef: true });
  const right = await check.inspect(target, { expectedValue: KEY, requirePublishedRef: true });
  assert.deepEqual({ wrong: [wrong.ready, wrong.kind], right: [right.ready, right.kind] },
    { wrong: [false, 'unknown'], right: [true, 'credential'] }); safe(wrong); safe(right);
});

test('confirmation cannot replace a missing resolved value with keyless readiness', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { required: false });
  const check = reader(f, { resolve: async () => ({ state: CREDENTIAL_ABSENT, value: '' }) });
  const answer = await check.inspect(f.target({ credentialRef: 'published.key' }), { expectedValue: KEY, requirePublishedRef: true });
  assert.deepEqual({ ready: answer.ready, kind: answer.kind, requests: f.requests.length }, { ready: false, kind: 'unknown', requests: 0 }); safe(answer);
});

test('a matching environment key cannot substitute for the missing published reference after acknowledgement', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t), check = reader(f, { env: f.environment({ FIXTURE_SERVICE_KEY: KEY }) });
  assert.equal((await check.inspect(f.target())).ready, true, 'positive control: initial environment-only readiness is valid');
  const after = await check.inspect(f.target(), { expectedValue: KEY, requirePublishedRef: true });
  assert.deepEqual({ ready: after.ready, kind: after.kind }, { ready: false, kind: 'unknown' }); safe(after);
});

for (const [name, env, root] of [['missing environment', undefined, path.resolve(os.tmpdir(), 'fixture-root')],
  ['null environment', null, path.resolve(os.tmpdir(), 'fixture-root')], ['array environment', [], path.resolve(os.tmpdir(), 'fixture-root')],
  ['missing root', {}, undefined], ['relative root', {}, 'fixture-relative-root']]) {
  test(`InstallCredentialReadiness refuses ${name} instead of ambient profile fallback`, () => {
    assert.throws(() => new InstallCredentialReadiness({ env, root }), /explicit environment and absolute credential root/);
  });
}

for (const status of ['200', 200.5]) {
  test(`a malformed probe status ${JSON.stringify(status)} is unknown, not coerced into 2xx`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t);
    const real = new InstallCredentialRegistration({ env: f.environment(), home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot });
    const registration = { readSpec: target => real.readSpec(target), probeWithoutCredential: async () => status };
    const check = new InstallCredentialReadiness({ env: {}, root: f.root, registration });
    const answer = await check.inspect(f.target());
    assert.deepEqual({ ready: answer.ready, kind: answer.kind }, { ready: false, kind: 'unknown' });
  });
}

for (const value of [undefined, '']) {
  test(`a malformed OK answer with ${value === '' ? 'empty' : 'missing'} value is not readiness`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t);
    const answer = await reader(f, { resolve: async () => ({ state: CREDENTIAL_OK, value, source: 'file' }) }).inspect(f.target());
    assert.deepEqual({ ready: answer.ready, kind: answer.kind }, { ready: false, kind: 'unknown' });
  });
}

for (const [name, raw] of [['zero', 0], ['false', false], ['array', ['non-default.key']]]) {
  test(`a ${name} reference is not coerced into absence or another file`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t, { status: 200 }); await f.store();
    const answer = await reader(f).inspect(f.target({ credentialRef: raw }));
    assert.deepEqual({ ready: answer.ready, kind: answer.kind, state: answer.state, requests: f.requests.length },
      { ready: false, kind: 'fault', state: CREDENTIAL_INVALID, requests: 0 });
  });
}
