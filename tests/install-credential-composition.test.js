// Actual owner publication, then exact target/runtime readback. Ack-fault cases replace only the owner outcome port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { InstallCredentials } from '../lib/install-credentials.mjs';
import { InstallCredentialReadiness } from '../lib/install-credential-readiness.mjs';
import { InstallCredentialRegistration } from '../lib/install-credential-registration.mjs';
import { credentialForTarget } from '../lib/credential-resolve.mjs';
import { globalNpmRoot } from '../lib/install-chain-host.mjs';
import { CredentialInstallFixture, PEER_REQUIRED, KEY, ROOT } from './fixtures/install-credentials.mjs';

function application(f, { registration, ask = async () => KEY, readiness, say } = {}) {
  const env = f.environment(), owner = registration ?? new InstallCredentialRegistration({ env, home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot });
  const check = readiness ?? new InstallCredentialReadiness({ env, root: f.root, registration: owner });
  const lines = [];
  const app = new InstallCredentials({ registry: f.registry, readiness: check, registration: owner, plugins: new Set(['aify-comms']), ask,
    say: line => { lines.push(line); say?.(line); } });
  return { app, lines, owner, check };
}
const refs = f => fs.existsSync(f.root) ? fs.readdirSync(f.root).filter(name => !name.startsWith('.')) : [];
const noLeak = lines => assert.equal(lines.join(' ').includes(KEY), false, 'the credential escaped into installer diagnostics');

const requiredPorts = { registry: path.resolve('fixture-only-registry.json'), readiness: { inspect: async () => ({ ready: false }) },
  registration: { publish: async () => ({ status: 78 }) }, plugins: new Set(), ask: async () => '', say() {} };
for (const field of Object.keys(requiredPorts)) {
  test(`InstallCredentials refuses a missing ${field} port without ambient fallback`, () => {
    assert.doesNotThrow(() => new InstallCredentials(requiredPorts), 'positive control: explicit complete ports are admitted');
    const missing = { ...requiredPorts }; delete missing[field];
    assert.throws(() => new InstallCredentials(missing), TypeError);
  });
}
for (const field of ['env', 'home', 'envRoot', 'registry']) {
  test(`InstallCredentialRegistration refuses missing ${field} before any owner discovery`, () => {
    const ports = { env: {}, home: path.resolve('fixture-home'), envRoot: ROOT, registry: path.resolve('fixture-only-registry.json') };
    assert.doesNotThrow(() => new InstallCredentialRegistration(ports));
    delete ports[field];
    assert.throws(() => new InstallCredentialRegistration(ports), /explicit environment and absolute host paths/);
  });
}

test('interactive owner connect publishes one reference and a second actual no-prompt entry run is ready', { skip: PEER_REQUIRED, timeout: 30000 }, async t => {
  const f = await CredentialInstallFixture.create(t); f.registrationProbes = true;
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
  let asked = 0, announced = false;
  const { app, lines } = application(f, { say: line => { if (line.includes('full approved service reconnect')) announced = true; },
    ask: async () => { assert.equal(announced, true, 'full reconnect scope must precede secret entry'); asked++; return KEY; } });
  const result = await app.run({ interactive: true });
  assert.equal(result.exit, 0, lines.join(' '));
  const entry = JSON.parse(fs.readFileSync(f.registry, 'utf8')).services['aify-comms'];
  assert.ok(entry.credentialRef && entry.credentialRef !== f.defaultRef(), 'owner must stage its reference, not an env-guessed default');
  assert.deepEqual(refs(f), [entry.credentialRef], 'the helper must not create a second key before owner connect');
  assert.equal((await credentialForTarget(entry, { root: f.root, env: {} })).value, KEY);
  assert.equal(asked, 1); noLeak(lines);
  const beforeRequests = f.requests.length, second = await f.run();
  assert.deepEqual({ status: second.status, ready: /aify-comms: ready/.test(second.stdout), requests: f.requests.length },
    { status: 0, ready: true, requests: beforeRequests });
  assert.equal((second.stdout + second.stderr).includes(KEY), false);
});

for (const status of [75, 78]) {
  test(`owner exit ${status} is non-success even if separately converged files now look ready; no staged key is deleted`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t);
    f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
    const real = new InstallCredentialRegistration({ env: f.environment(), home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot });
    const ref = 'retained-published.key';
    const registration = { readSpec: target => real.readSpec(target), probeWithoutCredential: (target, probe) => real.probeWithoutCredential(target, probe),
      publish: async () => { await f.store(ref); f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint, credentialRef: ref } }); return { status }; } };
    const { app, lines } = application(f, { registration });
    const result = await app.run({ interactive: true });
    assert.deepEqual({ exit: result.exit, configuredNow: result.plan.steps[0].action, retained: refs(f) },
      { exit: 1, configuredNow: 'ok', retained: [ref] });
    assert.ok(lines.some(line => line.includes(status === 75 ? 'outcome is unknown' : 'was refused'))); noLeak(lines);
  });
}

for (const mode of ['ack-only', 'wrong-key', 'wrong-registry', 'changed-endpoint']) {
  test(`a ${mode} publication cannot pass exact target/readback confirmation`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t);
    f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
    const real = new InstallCredentialRegistration({ env: f.environment(), home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot });
    const registration = { readSpec: target => real.readSpec(target), probeWithoutCredential: (target, probe) => real.probeWithoutCredential(target, probe),
      publish: async () => {
        if (mode !== 'ack-only') {
          const ref = await f.store('published.key', mode === 'wrong-key' ? 'not-the-entered-key' : KEY);
          f.writeRegistry({ 'aify-comms': { endpoint: mode === 'changed-endpoint' ? f.endpoint + '/changed' : f.endpoint, credentialRef: ref } },
            mode === 'wrong-registry' ? f.defaultRegistry : f.registry);
        }
        return { status: 0 };
      } };
    const { app, lines } = application(f, { registration });
    const result = await app.run({ interactive: true });
    assert.equal(result.exit, 1, 'an owner acknowledgement is not the exact requested persisted state');
    assert.ok(lines.some(line => line.includes('readback is not ready'))); noLeak(lines);
  });
}

test('an intervening selected-entry edit is retained and no registration runs after prompting', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t);
  f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
  const real = new InstallCredentialRegistration({ env: f.environment(), home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot });
  let published = 0;
  const registration = { readSpec: target => real.readSpec(target), probeWithoutCredential: (target, probe) => real.probeWithoutCredential(target, probe), publish: async () => { published++; return { status: 0 }; } };
  const edited = { 'aify-comms': { endpoint: f.endpoint, advertise: false } };
  const { app, lines } = application(f, { registration, ask: async () => { f.writeRegistry(edited); return KEY; } });
  const result = await app.run({ interactive: true });
  assert.deepEqual({ exit: result.exit, published, selected: JSON.parse(fs.readFileSync(f.registry, 'utf8')).services },
    { exit: 1, published: 0, selected: edited }); noLeak(lines);
});

test('empty interactive input remains incomplete and never invokes registration', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t); f.writeRegistry({ 'aify-comms': { endpoint: f.endpoint } });
  const real = new InstallCredentialRegistration({ env: f.environment(), home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot });
  let attempted = 0;
  const registration = { readSpec: target => real.readSpec(target), probeWithoutCredential: (target, probe) => real.probeWithoutCredential(target, probe),
    publish: async (...args) => { attempted++; return real.publish(...args); } };
  const { app, lines } = application(f, { registration, ask: async () => '' });
  const before = fs.readFileSync(f.registry), result = await app.run({ interactive: true });
  assert.deepEqual({ exit: result.exit, bytes: fs.readFileSync(f.registry), refs: refs(f), attempted },
    { exit: 1, bytes: before, refs: [], attempted: 0 }); noLeak(lines);
});

for (const source of ['malformed', 'unsupported-version', 'ambiguous-name', 'missing-endpoint']) {
  test(`a ${source} registry is unknown, not an empty successful plan`, { skip: PEER_REQUIRED }, async t => {
    const f = await CredentialInstallFixture.create(t);
    f.writeRegistry(source === 'ambiguous-name' ? { 'aify-comms': { endpoint: f.endpoint }, ' aify-comms ': { endpoint: f.endpoint } }
      : { 'aify-comms': source === 'missing-endpoint' ? {} : { endpoint: f.endpoint } });
    if (source === 'malformed') fs.writeFileSync(f.registry, '{broken');
    if (source === 'unsupported-version') fs.writeFileSync(f.registry, JSON.stringify({ version: 999, services: {} }));
    let asks = 0;
    const { app, lines } = application(f, { ask: async () => { asks++; return KEY; } });
    const result = await app.run({ interactive: true });
    assert.deepEqual({ exit: result.exit, asks, requests: f.requests.length }, { exit: 1, asks: 0, requests: 0 }); noLeak(lines);
  });
}

test('the owner invocation uses exact host paths and stdin only, with no automatic approval', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t), env = { HOME: f.home, USERPROFILE: f.home, PATH: 'fixture-only' };
  let captured, input;
  const owner = new InstallCredentialRegistration({ env, home: f.home, envRoot: ROOT, registry: f.registry, wrapperRoot: f.wrapperRoot,
    spawnProcess: (command, args, options) => {
      captured = { command, args: structuredClone(args), env: options.env, stdio: [...options.stdio] };
      const report = args[args.indexOf('--report-file') + 1];
      assert.equal(fs.existsSync(path.dirname(report)), true, 'positive control: owned report directory exists');
      assert.equal(fs.existsSync(report), false, 'the report path must be fresh, not a stale acknowledgement');
      const child = new EventEmitter(); child.stdin = { on() {}, end(value) { input = value; queueMicrotask(() => child.emit('close', 0, null)); } };
      return child;
    } });
  assert.equal((await owner.publish(f.target(), KEY)).status, 0, 'this is an owner ack only, not readiness');
  assert.equal(input, KEY);
  assert.equal(captured.command, process.execPath);
  assert.equal(captured.args.includes(KEY), false);
  assert.ok(captured.args.includes('--key-stdin') && captured.args.includes('--no-prompt'));
  assert.equal(captured.args.includes('--approve'), false);
  assert.equal(captured.args[captured.args.indexOf('--registry') + 1], f.registry);
  assert.equal(captured.args[captured.args.indexOf('--aify-env') + 1], path.join(ROOT, 'bin/aify-env.mjs'));
  assert.equal(captured.env, env);
  assert.deepEqual(captured.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(fs.existsSync(path.dirname(captured.args[captured.args.indexOf('--report-file') + 1])), false);
});

test('an exact whitespace-named entry is not silently replaced by a second canonical registry name', { skip: PEER_REQUIRED, timeout: 30000 }, async t => {
  const f = await CredentialInstallFixture.create(t); f.registrationProbes = true;
  f.writeRegistry({ ' aify-comms ': { endpoint: f.endpoint } });
  const before = fs.readFileSync(f.registry), { app, lines } = application(f);
  const result = await app.run({ interactive: true });
  assert.deepEqual({ exit: result.exit, bytes: fs.readFileSync(f.registry), refs: refs(f) }, { exit: 1, bytes: before, refs: [] }); noLeak(lines);
});

test('an unreadable registry path cannot be treated as no registered services', { skip: PEER_REQUIRED }, async t => {
  const f = await CredentialInstallFixture.create(t); fs.mkdirSync(f.registry, { recursive: true });
  const { app, lines } = application(f), result = await app.run({ interactive: false });
  assert.deepEqual({ exit: result.exit, plan: result.plan, requests: f.requests.length }, { exit: 1, plan: null, requests: 0 }); noLeak(lines);
});

test('globalNpmRoot preserves installed-root query semantics and does not guess after failure', () => {
  const calls = [], env = { PATH: 'fixture-only' };
  assert.equal(globalNpmRoot({ env, platform: 'win32', run: (...args) => { calls.push(args); return { status: 0, stdout: ' C:/fixture/npm \n' }; } }), 'C:/fixture/npm');
  assert.deepEqual(calls, [['npm', ['root', '-g'], { encoding: 'utf8', shell: true, timeout: 60_000, env }]]);
  assert.equal(globalNpmRoot({ env, run: () => ({ status: 1, stdout: 'do-not-trust-this-root' }) }), '');
});
