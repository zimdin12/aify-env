// Existing install-plan tests prove the pure boolean planner, not the source of that boolean.
// These exercise the actual entrypoint with private files and a controlled, spec-declared auth probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { CredentialInstallFixture, PEER_REQUIRED, KEY } from './fixtures/install-credentials.mjs';

const noLeak = result => assert.equal((result.stdout + result.stderr).includes(KEY), false, 'a credential value reached installer output');

test('a published non-default reference is ready without being requested again', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t), ref = await f.store();
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint, credentialRef: ref } }, f.defaultRegistry);
  const result = await f.run(['--no-prompt'], { AIFY_SERVICE_REGISTRY: f.defaultRegistry });
  assert.deepEqual({ status: result.status, ready: /aify-comms: ready/.test(result.stdout), asks: /NEEDS A CREDENTIAL|will ask/.test(result.stdout) },
    { status: 0, ready: true, asks: false });
  noLeak(result);
});

test('AIFY_SERVICE_REGISTRY chooses the exact custom entry, not the default registry', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t), ref = await f.store(f.defaultRef());
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint, credentialRef: ref } });
  f.writeRegistry({ 'unselected-service': { endpoint: f.endpoint } }, f.defaultRegistry);
  const result = await f.run();
  assert.deepEqual({ status: result.status, ready: /aify-comms: ready/.test(result.stdout), wrongTarget: result.stdout.includes('unselected-service') },
    { status: 0, ready: true, wrongTarget: false });
  noLeak(result);
});

test('Windows default registry selection uses the runtime USERPROFILE home, not a different shell HOME', { skip: PEER_REQUIRED || (process.platform !== 'win32' && 'Windows USERPROFILE home semantics') }, async t => {
  const f = await CredentialInstallFixture.create(t), ref = await f.store(f.defaultRef());
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint, credentialRef: ref } }, f.defaultRegistry);
  const result = await f.run(['--no-prompt'], { HOME: f.home + '/different-shell-home', AIFY_SERVICE_REGISTRY: undefined });
  assert.deepEqual({ status: result.status, ready: /aify-comms: ready/.test(result.stdout) }, { status: 0, ready: true }); noLeak(result);
});

test('entry wiring preserves an invalid raw reference as a fault instead of keyless absence', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { status: 200 }), ref = await f.store(f.defaultRef());
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint, credentialRef: [ref] } });
  const result = await f.run();
  assert.deepEqual({ status: result.status, invalid: result.stdout.includes('CREDENTIAL_INVALID'), requests: f.requests.length },
    { status: 1, invalid: true, requests: 0 }); noLeak(result);
});

test('an orphan default-reference file cannot make a keyed service ready without publication', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t); await f.store(f.defaultRef());
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } }, f.defaultRegistry);
  const result = await f.run(['--no-prompt'], { AIFY_SERVICE_REGISTRY: f.defaultRegistry });
  assert.deepEqual({ status: result.status, missing: /NEEDS A CREDENTIAL/.test(result.stdout), probeCalled: f.requests.some(r => r.path === '/declared-api') },
    { status: 1, missing: true, probeCalled: true });
  assert.equal(f.requests.some(r => r.headers['x-api-key'] || r.headers.authorization || r.headers.cookie), false, 'absence probe sent credential material');
  noLeak(result);
});

test('a keyless deployment is ready from the declared API probe even when the spec still says required', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t, { status: 200, required: true });
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } }, f.defaultRegistry);
  const result = await f.run(['--no-prompt'], { AIFY_SERVICE_REGISTRY: f.defaultRegistry });
  assert.deepEqual({ status: result.status, ready: /aify-comms: ready/.test(result.stdout), probeCalled: f.requests.some(r => r.path === '/declared-api'), healthCalled: f.requests.some(r => r.path === '/health') },
    { status: 0, ready: true, probeCalled: true, healthCalled: false });
  assert.equal(f.requests.some(r => r.headers['x-api-key'] || r.headers.authorization || r.headers.cookie), false);
  noLeak(result);
});

test('actual interactive entry reaches owner publication with controlled TTY flags and does not echo the key', { skip: PEER_REQUIRED, timeout: 45000 }, async t => {
  const f = await CredentialInstallFixture.create(t); f.registrationProbes = true;
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
  const result = await f.runInteractive(KEY);
  assert.deepEqual({ status: result.status, verified: result.stdout.includes('published credential verified') }, { status: 0, verified: true });
  noLeak(result);
  assert.equal(result.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').includes(KEY), false, 'terminal control output reconstructed the secret');
});

test('interactive EOF cannot exit successfully with an unanswered credential question', { skip: PEER_REQUIRED, timeout: 45000 }, async t => {
  const f = await CredentialInstallFixture.create(t); f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
  const before = fs.readFileSync(f.registry), result = await f.runInteractive('', { newline: false });
  assert.deepEqual({ status: result.status, explained: result.stdout.includes('nothing entered; no registration requested'),
    registry: fs.readFileSync(f.registry), files: fs.existsSync(f.root) ? fs.readdirSync(f.root) : [] },
    { status: 1, explained: true, registry: before, files: [] }); noLeak(result);
});

test('buffered input after the first secret line stays muted until the question interface is closed', { skip: PEER_REQUIRED, timeout: 45000 }, async t => {
  const f = await CredentialInstallFixture.create(t); f.registrationProbes = true;
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
  const extra = 'fixture-extra-line-must-not-echo', result = await f.runInteractive(KEY + '\n' + extra);
  const plain = result.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  assert.deepEqual({ status: result.status, verified: result.stdout.includes('published credential verified'), extraVisible: plain.includes(extra) },
    { status: 0, verified: true, extraVisible: false }); noLeak(result);
});

for (const [name, input] of [['leading whitespace', ' ' + KEY], ['trailing whitespace', KEY + ' ']]) {
  test(`actual interactive ${name} is refused literally instead of trimmed into a stored key`, { skip: PEER_REQUIRED, timeout: 45000 }, async t => {
    const f = await CredentialInstallFixture.create(t); f.registrationProbes = true;
    f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
    const before = fs.readFileSync(f.registry);
    const result = await f.runInteractive(input);
    assert.deepEqual({ status: result.status, verified: result.stdout.includes('published credential verified'),
      registry: fs.readFileSync(f.registry), files: fs.existsSync(f.root) ? fs.readdirSync(f.root) : [] },
      { status: 1, verified: false, registry: before, files: [] });
    noLeak(result);
  });
}
