import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsApi, mintBridgeIdentity } from '../lib/plugins/aify-comms/api.mjs';
import { createCommsPlugin, HEARTBEAT_INTERVAL_MS } from '../lib/plugins/aify-comms/index.mjs';
import { ORPHAN_QUIET_MS } from '../lib/plugins/aify-comms/terminal-controls.mjs';

const at = 1_800_000_000_000;
const idle = { state: 'idle', reason: 'at-prompt' };
const ended = { state: 'ended', status: 'stopped' };
const missing = { state: 'missing' };
const renewed = { state: 'renewed' };
const evidence = terminalEvidence => ({ terminalEvidence });
const reply = (json, status = 200) => new Response(JSON.stringify(json), { status });
const start = (terminalId, id = terminalId) => ({ id, terminalId, action: 'start' });

async function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'held-evidence-'));
  const launcher = join(dir, 'worker-aify');
  writeFileSync(launcher, ['#!/bin/bash', 'HARNESS_WRAPPER_VERSION="0.6.0"', ''].join(String.fromCharCode(10)));
  const live = new Map(), listeners = new Map(), screens = new Map(), sightings = new Map();
  const polls = [], otherPolls = [], beats = [], posts = [], stops = [], timers = [];
  let answerBeat = () => reply({});
  let answerOutput = () => reply({ terminal: { status: 'attached' } });
  let time = at, nextHandle = 0;
  t.mock.method(Date, 'now', () => time);
  const api = new CommsApi({
    endpoint: 'http://127.0.0.1:1', credential: async () => '', identity: mintBridgeIdentity(),
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init.body && JSON.parse(init.body);
      if (path.endsWith('/environments/heartbeat')) { beats.push(body); return answerBeat(); }
      if (path.endsWith('/terminals/controls/claim')) return new Promise(resolve => polls.push(resolve));
      if (path.endsWith('/claim')) return new Promise(resolve => otherPolls.push(resolve));
      if (path.endsWith('/launch')) return reply({ launch: { argv: [launcher], cwd: dir, agentId: path.split('/').at(-2) } });
      if (path.endsWith('/output')) {
        posts.push({ id: path.split('/').at(-2), body });
        return answerOutput(body);
      }
      if (init.method === 'PATCH') return reply({});
      throw new Error(`unexpected fake Comms route: ${path}`);
    },
  });
  const processes = {
    async start(spec) {
      const record = { id: `proc-${++nextHandle}`, pid: nextHandle, terminal: true };
      live.set(record.id, record);
      return record;
    },
    list: () => [...live.values()],
    subscribe(id, out, exit) { listeners.set(id, { out, exit }); return () => listeners.delete(id); },
    watchScreen(id, { onActivity }) { screens.set(id, onActivity); return () => screens.delete(id); },
    screenActivity: id => sightings.get(id),
    async stop(handle) { stops.push(handle); live.delete(handle); return { stopped: true }; },
  };
  const plugin = createCommsPlugin({
    api, endpoint: 'http://127.0.0.1:1', advertisement: async () => ({ hostname: 'fixture', kind: 'linux' }),
    platform: 'linux', windows: false, cwdRoots: () => [dir],
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl() {},
  });
  t.after(async () => {
    answerBeat = () => reply({});
    await plugin.stop();
    for (const resolve of [...polls, ...otherPolls]) resolve(reply({ controls: [] }));
    rmSync(dir, { recursive: true, force: true });
  });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  await plugin.start({ processes });
  await turn();
  return {
    posts, stops, live, beats, listeners, plugin, turn,
    advance: () => { time += ORPHAN_QUIET_MS + 1; },
    screen(id, sighting) { sightings.set(id, sighting); screens.get(id)(sighting); },
    answerOutput(fn) { answerOutput = fn; },
    beat(value) {
      answerBeat = typeof value === 'function' ? value : () => reply(value);
      const i = timers.findIndex(({ ms }) => ms === HEARTBEAT_INTERVAL_MS);
      assert.notEqual(i, -1, 'the existing heartbeat did not re-arm');
      return timers.splice(i, 1)[0].fn();
    },
    async pass(...controls) {
      if (!polls.length) {
        const i = timers.findIndex(({ ms }) => ms !== HEARTBEAT_INTERVAL_MS);
        assert.notEqual(i, -1, 'the existing control loop did not re-arm');
        timers.splice(i, 1)[0].fn();
        await turn();
      }
      assert.equal(polls.length, 1, 'exactly one control claim reached fake Comms');
      polls.shift()(reply({ controls }));
      await turn();
    },
    idlePosts: () => posts.filter(p => p.body.output === '' && !p.body.activity).map(p => p.id),
  };
}

for (const newer of [false, true]) {
  test(`three idle passes over two PTYs ${newer ? 'with renewal' : 'on an old server'}`, async t => {
    const f = await rig(t);
    await f.pass(start('one'), start('two'));
    assert.equal(f.plugin.state().heldWorkers, 2);
    await f.beat(newer ? {
      ...evidence({ one: renewed, two: renewed }), ok: true,
      claimer: { accepted: false, bridgeId: 'peer', reason: 'an existing bridge started later than this one' },
    } : {});
    assert.deepEqual(f.beats.at(-1).metadata.heldTerminals, ['one', 'two']);
    assert.equal(f.plugin.state().claimRefused, newer, 'the fixture must actually exercise a refused claimer');
    assert.deepEqual(f.idlePosts(), [], 'no liveness frame preceded the counted passes');
    for (let i = 0; i < 3; i++) await f.pass();
    t.diagnostic(`idle POSTs across three control passes: ${f.idlePosts().length}`);
    assert.deepEqual(f.idlePosts(), newer ? [] : ['one', 'two', 'one', 'two', 'one', 'two']);
  });
}

test('only complete evidence for an ID replaces its idle probe; the next failed beat restores fallback', async t => {
  const f = await rig(t);
  await f.pass(...['keep', 'foreign', 'unknown', 'omitted', 'bad'].map(id => start(id)));
  f.advance();
  f.screen('proc-2', idle);
  f.answerOutput(body => body.activity ? reply({}, 404) : reply({ terminal: { status: 'attached' } }));
  await f.beat(evidence({ keep: renewed, foreign: { state: 'owned-elsewhere' }, unknown: { state: 'unknown' },
    bad: { state: 'ended', status: 'attached' } }));
  await f.pass();
  assert.deepEqual(f.idlePosts(), ['omitted', 'bad'], 'only absent or malformed entries should get idle probes');
  assert.deepEqual(f.stops, [], 'foreign, unknown or malformed evidence authorized a stop');
  f.answerOutput(() => reply({ terminal: { status: 'attached' } }));
  await f.beat(() => reply({}, 503));
  await f.pass();
  assert.deepEqual(f.idlePosts().slice(2), ['keep', 'unknown', 'omitted', 'bad'], 'failed beat kept old proof');
});

test('ended and missing evidence stop only quiet workers and after checking output at the control pass', async t => {
  const f = await rig(t);
  await f.pass(...['ended', 'missing', 'writing-ended', 'writing-missing'].map(id => start(id)));
  f.advance();
  await f.beat(evidence({ ended, missing, 'writing-ended': ended, 'writing-missing': missing }));
  f.listeners.get('proc-3').out('still working');
  f.listeners.get('proc-4').out('also working');
  await f.pass();
  assert.deepEqual(f.stops, ['proc-1', 'proc-2'], 'only the matching quiet handles may be stopped');
  assert.deepEqual(f.idlePosts(), [], 'heartbeat evidence did not replace the idle probe');
});

test('an in-flight beat cannot speak for a replacement handle or a terminal it did not list', async t => {
  const f = await rig(t);
  await f.pass(start('same'), start('witness'));
  let finish;
  const inFlight = f.beat(() => new Promise(resolve => { finish = resolve; }));
  await f.turn();
  assert.deepEqual(f.beats.at(-1).metadata.heldTerminals, ['same', 'witness']);
  assert.equal(typeof finish, 'function');
  await f.pass(start('same', 'replacement'), start('late'));
  f.advance();
  finish(reply(evidence({ same: ended, late: missing, witness: ended })));
  await inFlight;
  const countBefore = f.idlePosts().length;
  await f.pass();
  assert.deepEqual(f.stops, ['proc-2'], 'the listed witness may stop, not a replacement or an unlisted terminal');
  assert.deepEqual(f.idlePosts().slice(countBefore), ['same', 'late'], 'only uncaptured bindings need the fallback');
});

test('renewal leaves transition, periodic activity, real output and exit frames on the wire', async t => {
  const f = await rig(t);
  await f.pass(start('active'), start('silent'));
  f.screen('proc-1', idle);
  await f.beat(evidence({ active: renewed, silent: renewed }));
  f.listeners.get('proc-1').out('PTY tail');
  await f.pass();
  f.live.delete('proc-1');
  f.listeners.get('proc-1').exit(0, '');
  await f.turn();
  const active = f.posts.filter(p => p.id === 'active').map(p => p.body);
  assert.deepEqual(active.filter(body => body.activity).map(body => body.activity), [idle, idle]);
  const output = active.filter(body => body.output);
  assert.deepEqual(output.map(body => body.output.trim()), ['PTY tail', '[terminal exited]']);
  assert.equal(output[1].exitCode, 0);
  assert.deepEqual(f.idlePosts(), [], 'the silent worker posted an idle frame despite renewal');
});
