// New fixture safety properties are not covered by the old daemon tests: these use no native effects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { ControlledDescendant } from './test-data/controlled-descendant.mjs';
import { ControlledFamily } from './fixtures/controlled-family.mjs';
import { mayExecute } from '../lib/allowlist.mjs';
new ProcessEffectTripwire();
const ROOT = 424240, CHILD = 424241, DECOY = 424242;
const birth = pid => ({ version: 1, platform: 'win32', pid, createdAtUs: 1700000000000000 + pid });
const present = pid => ({ alive: true, createdAtUs: birth(pid).createdAtUs });
const identity = probe => ({ probe });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-worker-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function family(t, { hasChild = true, probe = async pids => new Map(pids.map(pid => [pid, present(pid)])) } = {}) {
  const f = new ControlledFamily({ hasChild, platform: 'win32', identity: identity(probe) });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const root = { role: 'root', birth: birth(ROOT), rootBirth: birth(ROOT), hasChild };
  const child = { role: 'child', birth: birth(CHILD), rootBirth: birth(ROOT), hasChild: false };
  fs.writeFileSync(path.join(f.dir, 'root.json'), JSON.stringify(root));
  if (hasChild) fs.writeFileSync(path.join(f.dir, 'child.json'), JSON.stringify(child));
  return { f, registration: f.readRegistration({ expectedPid: ROOT }) };
}

test('the actual controlled launcher remains admitted by the unchanged core allowlist', t => {
  const { f } = family(t);
  assert.equal(mayExecute(fs.readFileSync(f.launcher, 'utf8')).ok, true, 'the fixture must use a real marker assignment, not bypass launcher admission');
});

test('fixture publishes its own birth before spawning a separately registered descendant, then self-exits on its private marker', async t => {
  const dir = directory(t), calls = [], finished = [];
  const worker = new ControlledDescendant({ controlDir: dir, platform: 'win32', pid: ROOT,
    identity: identity(async pids => { calls.push(pids); return new Map([[ROOT, present(ROOT)]]); }),
    start: (_command, args) => {
      assert.equal(fs.existsSync(path.join(dir, 'root.json')), true, 'root custody must be published before its child starts');
      calls.push(JSON.parse(args[1])); return new EventEmitter();
    }, now: () => 0, pause: async () => fs.writeFileSync(path.join(dir, 'stop'), ''), finish: code => finished.push(code) });
  await worker.run();
  assert.deepEqual(calls[0], [ROOT]);
  assert.deepEqual(calls[1].rootBirth, birth(ROOT));
  assert.equal(calls[1].role, 'child');
  assert.deepEqual(finished, [0]);
});

test('unknown fixture self-birth publishes nothing and never spawns', async t => {
  const dir = directory(t), starts = [], exits = [];
  const worker = new ControlledDescendant({ controlDir: dir, platform: 'win32', pid: ROOT,
    identity: identity(async () => new Map()), start: () => starts.push('spawn'), finish: code => exits.push(code) });
  await assert.rejects(worker.run(), /could not capture/);
  assert.deepEqual({ starts, exits, files: fs.readdirSync(dir) }, { starts: [], exits: [], files: [] });
});

test('the descendant captures only itself and does not turn parent death into voluntary product cleanup', async t => {
  const dir = directory(t), queried = [], exits = [];
  const worker = new ControlledDescendant({ controlDir: dir, role: 'child', rootBirth: birth(ROOT), hasChild: false,
    platform: 'win32', pid: CHILD, identity: identity(async pids => { queried.push(pids); return new Map([[CHILD, present(CHILD)]]); }),
    start: () => assert.fail('a descendant cannot create another unregistered generation'), now: () => 0,
    pause: async () => fs.writeFileSync(path.join(dir, 'stop'), ''), finish: code => exits.push(code) });
  await worker.run();
  assert.deepEqual(queried, [[CHILD]], 'no parent/table scan or parent-liveness exit trigger');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'child.json'))).rootBirth, birth(ROOT));
  assert.deepEqual(exits, [0]);
});

test('fixture TTL self-exits even if teardown never publishes a marker', async t => {
  const dir = directory(t), exits = []; let clock = 0, pauses = 0;
  const worker = new ControlledDescendant({ controlDir: dir, hasChild: false, platform: 'win32', pid: ROOT,
    identity: identity(async () => new Map([[ROOT, present(ROOT)]])), now: () => clock,
    pause: async () => { assert.ok(++pauses <= 2, 'TTL must bound the fixture without a marker'); clock += 120000; }, finish: code => exits.push(code) });
  await worker.run();
  assert.equal(fs.existsSync(path.join(dir, 'stop')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'finished-root.json'))).reason, 'ttl');
  assert.deepEqual(exits, [0]);
});

test('known-child observation ignores an independently registered decoy and queries no unrelated PID', async t => {
  const calls = [], { f, registration } = family(t, { probe: async pids => {
    calls.push(pids); return new Map([[ROOT, present(ROOT)], [CHILD, present(CHILD)], [DECOY, present(DECOY)]]);
  } });
  assert.equal(await f.countChildren(registration), 1);
  assert.deepEqual(calls, [[ROOT, CHILD]]);
  assert.equal(f.stopRequested(), false, 'presence controls must run before teardown');
});

test('a live registered no-child root supplies a genuine zero control', async t => {
  const { f, registration } = family(t, { hasChild: false });
  assert.equal(await f.countChildren(registration), 0);
  assert.equal(await f.originalsGone(registration), false, 'zero children is not root absence');
});

for (const unknown of ['throw', 'missing birth']) {
  test(`fixture ${unknown} observation is unknown, never an absent descendant`, async t => {
    const { f, registration } = family(t, { probe: async () => {
      if (unknown === 'throw') throw Error('fixture query failed');
      return new Map([[ROOT, present(ROOT)], [CHILD, { alive: true }]]);
    } });
    await assert.rejects(f.countChildren(registration), /unknown|query failed/);
    assert.equal(f.stopRequested(), false);
  });
}

test('a descendant registered against another root is refused before any OS observation', t => {
  const { f } = family(t, { probe: () => assert.fail('unbound registration must never be probed') });
  const childFile = path.join(f.dir, 'child.json'), row = JSON.parse(fs.readFileSync(childFile));
  row.rootBirth = birth(DECOY); fs.writeFileSync(childFile, JSON.stringify(row));
  assert.throws(() => f.readRegistration({ expectedPid: ROOT }), /not bound/);
});

test('missing registration leaves a private stop marker and explicit unconfirmed cleanup, not a numeric signal', async t => {
  const f = new ControlledFamily({ platform: 'win32', identity: identity(() => assert.fail('no registration grants no PID probe')) });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const outcome = await f.dispose();
  assert.equal(outcome.confirmed, false);
  assert.equal(f.stopRequested(), true);
  assert.equal(fs.existsSync(f.dir), true, 'unknown cleanup keeps its private stop evidence');
});

for (const reason of ['ttl', 'marker']) {
  test(`fixture ${reason} self-exit cannot manufacture the product tree property`, async t => {
    const { f, registration } = family(t, { probe: async pids => new Map(pids.map(pid => [pid, { alive: false }])) });
    fs.writeFileSync(path.join(f.dir, 'finished-child.json'), JSON.stringify({ birth: birth(CHILD), reason }));
    await assert.rejects(f.productGone(registration), /self-exit\/TTL/);
    assert.equal(f.stopRequested(), false);
  });
}

test('a teardown marker published before the disappearance assertion refuses qualification', async t => {
  const { f, registration } = family(t, { probe: async pids => new Map(pids.map(pid => [pid, { alive: false }])) });
  fs.writeFileSync(path.join(f.dir, 'stop'), '');
  await assert.rejects(f.productGone(registration), /teardown already began/);
});

test('confirmed private teardown removes only its fixture directory after original births are gone', async t => {
  const { f, registration } = family(t, { probe: async pids => {
    assert.equal(f.stopRequested(), true, 'teardown marker precedes the self-exit observation');
    return new Map(pids.map(pid => [pid, { alive: false }]));
  } });
  assert.deepEqual(await f.dispose({ registration }), { confirmed: true });
  assert.equal(fs.existsSync(f.dir), false);
});
