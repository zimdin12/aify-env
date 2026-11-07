// Component ownership is covered separately. These cases pin the real ordered boot API and its effect payloads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BootCancelled } from '../lib/daemon-boot-session.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { BootFixture, deferred, tick } from './fixtures/daemon-boot.mjs';
new ProcessEffectTripwire();
const failed = promise => promise.then(() => null, error => error);

for (const bound of [null, { address: '127.0.0.1', port: 0 }, { address: 'elsewhere', port: 18802 }]) {
  test(`unbound or mismatched endpoint ${JSON.stringify(bound)} cannot enter any boot effect`, async () => {
    const f = new BootFixture(); f.options.bound = bound;
    const error = await failed(f.boot());
    assert.deepEqual({ message: error?.message, events: f.events, identityCalls: f.identityCalls },
      { message: 'daemon boot needs its successfully bound endpoint', events: [], identityCalls: 0 });
  });
}

test('shared boot preserves state, recovery, publisher, socket, plugin, banner, view and advertiser order', async () => {
  const f = new BootFixture(), result = await f.boot();
  assert.deepEqual(f.events, ['support', 'identity', 'state', 'turns', 'selections', 'lifecycle', 'folders', 'reconcile',
    'recover', 'sender', 'attach', 'evaluate', 'interval', 'unref', 'socket', 'pane', 'plugins', 'banner', 'view', 'advertising']);
  assert.ok(result.state === f.state && result.inputSocket === f.socket && result.ownsScreen);
  assert.equal(f.captured.state.url, 'http://127.0.0.1:18802');
  assert.ok(f.captured.lifecycle.processes === f.state.processes);
  assert.ok(f.captured.socket.deps().runner === f.runner && f.captured.view.runner === f.runner);
  assert.ok(f.captured.turns.onApplied === f.options.evaluate && f.captured.lifecycle.onStopChange === f.options.evaluate);
  assert.equal(f.output.filter(line => line.startsWith('aify-env ')).length, 1, 'the startup banner remains one write');
});

test('dedicated boot publishes its ready artifact instead of shared ownership recovery and still starts plugins', async () => {
  const f = new BootFixture(); f.options.instanceContext = { scope: 'dedicated', root: '/dedicated' };
  await f.boot();
  assert.deepEqual(f.captured.ready, { context: f.options.instanceContext,
    ready: { pid: 424242, envInstance: 'runner-instance', port: 18802, build: 'fixture-build' } });
  assert.ok(!f.events.includes('recover') && f.events.includes('plugins') && f.events.includes('advertising'));
  assert.equal(await f.captured.shared.servedElsewhere(), true);
});

test('HELD recovery is not failure: publishers, plugin claimers and advertising remain reachable', async () => {
  const f = new BootFixture(); f.options.recover = async () => { f.events.push('held'); return { ready: false }; };
  await f.boot();
  assert.deepEqual({ held: f.events.includes('held'), publisher: f.events.includes('sender'), plugins: f.events.includes('plugins'),
    advertising: f.events.includes('advertising'), cancelled: f.session.cancelled },
  { held: true, publisher: true, plugins: true, advertising: true, cancelled: false });
});

for (const stage of ['state', 'ready', 'recover']) {
  test(`THROWN ${stage} failure starts no publishers, sockets, plugins or advertising`, async () => {
    const f = new BootFixture(), cause = Error(`fixture ${stage} failed`);
    if (stage === 'recover') f.options.recover = async () => { throw cause; };
    else f.factories[stage] = () => { throw cause; };
    if (stage === 'ready') f.options.instanceContext = { scope: 'dedicated' };
    const error = await failed(f.boot());
    assert.deepEqual({ failed: Boolean(error), code: error?.exitCode ?? 1,
      effects: f.events.filter(event => ['sender', 'socket', 'plugins', 'advertising'].includes(event)) },
    { failed: true, code: stage === 'recover' ? 1 : 2, effects: [] });
  });
}

test('a view-only boot API call cannot reap, publish, claim or advertise', async () => {
  const f = new BootFixture(); f.options.viewOnly = () => true;
  const result = await f.boot();
  assert.deepEqual({ events: f.events, hasState: result.state !== null, ownsScreen: result.ownsScreen },
    { events: [], hasState: false, ownsScreen: false });
});

test('host identity is computed once and shared by lifecycle, every population sender and plugin payload', async () => {
  const f = new BootFixture(); await f.boot();
  const managedMachineId = f.captured.sender.identity.machineId;
  const residentSender = f.captured.sendFor({ instance: 'residents', generation: 2, stateHost: {} });
  assert.ok(residentSender === f.sender);
  assert.deepEqual({ calls: f.identityCalls, lifecycle: f.captured.lifecycle.machineId,
    managed: managedMachineId, resident: f.captured.sender.identity.machineId, shared: f.captured.shared.machineId },
  { calls: 1, lifecycle: 'fixture-machine', managed: 'fixture-machine', resident: 'fixture-machine', shared: 'fixture-machine' });
});

test('registry, credentials, roots, harnesses and disk advertisement facts remain live after boot', async () => {
  const f = new BootFixture(); await f.boot(); const shared = f.captured.shared;
  assert.equal(f.captured.sender.readRegistry(), 'registry-one');
  assert.equal(await f.captured.plugins.credential('fixture'), 'fixture-one');
  f.facts = { roots: ['/changed'], installed: new Set(['changed']), registry: 'registry-two', credential: 'fixture-two', disk: 2 };
  assert.deepEqual({ registry: f.captured.sender.readRegistry(), credential: await f.captured.plugins.credential('fixture'),
    roots: await shared.cwdRoots(), harnesses: [...await shared.installedHarnesses()], advertisement: await shared.advertisement(),
    watch: await shared.watchRoots() },
  { registry: 'registry-two', credential: 'fixture-two', roots: ['/changed'], harnesses: ['changed'], advertisement: { disk: 2 }, watch: ['/changed'] });
  assert.equal(f.identityCalls, 1);
});

test('a plugin-bootstrap exception remains isolated while the successfully booted host keeps serving', async () => {
  const f = new BootFixture(); f.factories.plugins = () => { throw Error('fixture plugin failure'); };
  const error = await failed(f.boot());
  assert.deepEqual({ failed: Boolean(error), serving: f.events.includes('banner'), view: f.events.includes('view'),
    advertising: f.events.includes('advertising'), reported: f.output.some(line => line.includes('service plugins not started: fixture plugin failure')) },
  { failed: false, serving: true, view: true, advertising: true, reported: true });
});

test('disabled local input socket remains an ordinary null acquisition', async () => {
  const f = new BootFixture(); f.options.localSocket = false;
  f.factories.socket = options => { f.captured.socket = options; return null; };
  const result = await f.boot();
  assert.deepEqual({ enabled: f.captured.socket.enabled, socket: result.inputSocket, plugins: f.events.includes('plugins') },
    { enabled: false, socket: null, plugins: true });
});

for (const stage of ['recover', 'socket', 'plugins', 'view']) {
  test(`cancellation during ${stage} joins late acquisition through existing shutdown ownership`, async () => {
    const f = new BootFixture(), gate = deferred(); let value, entered = false;
    if (stage === 'recover') f.options.recover = () => { entered = true; value = { ready: true }; return gate.promise; };
    else {
      const original = f.factories[stage];
      f.factories[stage] = options => { entered = true; value = original(options); return gate.promise; };
    }
    const starting = failed(f.boot()); await tick();
    assert.equal(entered, true, 'positive control: this acquisition actually reached its await');
    const ending = f.shutdown(); await tick();
    if (stage !== 'recover') assert.deepEqual({ exited: f.events.includes('exit:0'), pluginsStopped: f.events.includes('stop:plugins') },
      { exited: false, pluginsStopped: false }, 'shutdown must still be joining this actual pending acquisition');
    gate.resolve(value);
    const error = await starting; await ending;
    const stopped = name => f.events.filter(event => event === `stop:${name}`).length;
    assert.deepEqual({ cancelled: error instanceof BootCancelled, advertising: f.events.includes('advertising'),
      socketStops: stopped('socket'), viewStops: stopped('view'), exits: f.events.filter(event => event === 'exit:0').length },
    { cancelled: true, advertising: false, socketStops: stage === 'recover' ? 0 : 1, viewStops: stage === 'view' ? 1 : 0, exits: 1 });
    assert.ok(f.events.indexOf('stop:plugins') < f.events.indexOf('exit:0'));
  });
}
