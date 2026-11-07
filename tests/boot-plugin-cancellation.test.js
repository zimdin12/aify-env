// Existing registry tests cover ordinary start/stop isolation. These pin both late-start entry points.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServicePlugins } from '../lib/service-plugins.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();

for (const entry of ['startAll', 'add']) {
  test(`${entry}: closed boot never starts or exposes a plugin`, async () => {
    let starts = 0, stops = 0;
    const registry = new ServicePlugins({ canStart: () => false });
    const plugin = { name: 'fixture', capabilities: { fixture: {} }, start: async () => starts++, stop: async () => stops++ };
    if (entry === 'startAll') registry.register(plugin);
    const outcome = await (entry === 'startAll' ? registry.startAll({}) : registry.add(plugin, {}));
    assert.deepEqual({ starts, stops, report: registry.report(), capability: registry.capability('fixture'),
      refused: entry === 'startAll' ? outcome.length === 1 : Boolean(outcome.problem) },
    { starts: 0, stops: 0, report: [], capability: null, refused: true });
  });

  test(`${entry}: cancellation during plugin start disposes late acquisition once, without exposing its capability`, async () => {
    let open = true, resolve, starts = 0, stops = 0;
    const pending = new Promise(yes => { resolve = yes; });
    const registry = new ServicePlugins({ canStart: () => open });
    const plugin = { name: 'fixture', capabilities: { fixture: {} },
      start: async () => { starts++; await pending; }, stop: async () => stops++ };
    if (entry === 'startAll') registry.register(plugin);
    const starting = entry === 'startAll' ? registry.startAll({}) : registry.add(plugin, {});
    assert.equal(starts, 1, 'positive control: the plugin actually entered startup');
    open = false; await registry.stopAll(); resolve(); const outcome = await starting;
    await registry.stopAll();
    assert.deepEqual({ starts, stops, report: registry.report(), capability: registry.capability('fixture'),
      refused: entry === 'startAll' ? outcome.length === 1 : Boolean(outcome.error) },
    { starts: 1, stops: 1, report: [], capability: null, refused: true });
  });
}

for (const value of [undefined, 'true', Promise.resolve(true)]) {
  test(`plugin admission requires synchronous true, not ${String(value)}`, async () => {
    let starts = 0;
    const registry = new ServicePlugins({ canStart: () => value });
    const answer = await registry.add({ name: 'fixture', start: async () => starts++, stop: async () => {} }, {});
    assert.deepEqual({ refused: Boolean(answer.problem), starts, report: registry.report() }, { refused: true, starts: 0, report: [] });
  });
}

test('legacy registries without a boot guard retain ordinary stop and restart behavior', async () => {
  let starts = 0, stops = 0;
  const registry = new ServicePlugins();
  registry.register({ name: 'fixture', start: async () => starts++, stop: async () => stops++ });
  assert.deepEqual(await registry.startAll({}), []); await registry.stopAll();
  assert.deepEqual(await registry.startAll({}), []); await registry.stopAll();
  assert.deepEqual({ starts, stops }, { starts: 2, stops: 2 });
});
