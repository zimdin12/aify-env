// Exclusion is measured by checkpoint bytes and writer exits, not lock acknowledgments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture, prerequisite, until } from './_activity-fixture.mjs';
const actor = fileURLToPath(new URL('./fixtures/activity-checkpoint-actor.mjs', import.meta.url));
function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_)/i.test(name)
    && !['NODE_OPTIONS', 'HERMES_SESSION_ID'].includes(name.toUpperCase())));
}
class Writers {
  constructor(t, f) {
    this.f = f; this.children = []; this.box = path.join(f.root, 'writers'); fs.mkdirSync(this.box);
    t.after(async () => {
      for (const item of this.children) {
        if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
        await item.closed;
      }
    });
  }
  file(who, phase) { return path.join(this.box, `${who}-${phase}`); }
  has(who, phase) { return fs.existsSync(this.file(who, phase)); }
  release(who, phase) { fs.writeFileSync(this.file(who, phase), 'go'); }
  async wait(who, ...phases) {
    await until(() => phases.some(p => this.has(who, p)), `${who} reaches ${phases.join(' or ')}`, 15000);
  }
  async start(who, mode = 'normal') {
    const child = spawn(process.execPath, [actor, this.f.directory, this.f.endpoint, this.box, who, mode], { env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const item = { child, closed: once(child, 'close'), stderr: () => stderr };
    this.children.push(item); await this.wait(who, 'ready');
    const ready = JSON.parse(fs.readFileSync(this.file(who, 'ready')));
    assert.equal(ready.version, process.version); assert.equal(ready.executable, process.execPath);
    assert.equal(ready.sealed, Boolean(process.env.ACTIVITY_SEALED_ROOT));
    return item;
  }
  result(who) { return JSON.parse(fs.readFileSync(this.file(who, 'result'))); }
  async settle(who, item) {
    this.release(who, 'finish'); await this.wait(who, 'result');
    return { result: this.result(who), exit: (await item.closed)[0], stderr: item.stderr() };
  }
  async finish(who, item, expected) {
    const observed = await this.settle(who, item);
    assert.deepEqual(observed.result, expected, `${who} transaction result`);
    assert.equal(observed.exit, expected.ok ? 0 : 2, `${who} native exit: ${observed.stderr}`);
  }
}
function generation(f) { return Object.values(JSON.parse(fs.readFileSync(f.checkpoint)).sources)[0].generation; }

// The old implementation passes the live-owner control, then fails the two-dead-lock-read schedule.
for (const stale of [false, true]) {
  test(`${stale ? 'two stale recovery claimants' : 'a live owner'} cannot overlap checkpoint writes`, { skip: prerequisite }, async t => {
    const f = await fixture(t); assert.equal(f.open().read().ok, true);
    const before = fs.readFileSync(f.checkpoint), initial = generation(f), w = new Writers(t, f);
    if (stale) {
      const former = await w.start('D'); w.release('D', 'go'); await w.wait('D', 'entered');
      const pid = former.child.pid;
      assert.equal(former.child.kill(), true, 'terminate the real fixture-owned operation holder');
      await former.closed;
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'genuinely dead operation owner');
      assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'dead owner has not replaced the checkpoint');
    }
    const a = await w.start('A', stale ? 'stale' : 'normal');
    const b = await w.start('B', stale ? 'stale' : 'normal');
    w.release('A', 'go'); await w.wait('A', 'read', 'entered');
    w.release('B', 'go'); await w.wait('B', 'read', 'entered', 'result');
    w.release('A', 'recover'); await w.wait('A', 'entered');
    w.release('B', 'recover'); await w.wait('B', 'entered', 'result');
    const overlap = w.has('B', 'entered');
    const bObserved = await w.settle('B', b), afterB = fs.readFileSync(f.checkpoint);
    const aObserved = await w.settle('A', a);
    console.log(JSON.stringify({ checkpointWriters: { stale, overlap, b: bObserved.result, a: aObserved.result,
      exits: [aObserved.exit, bObserved.exit], bChangedCheckpoint: !afterB.equals(before), finalGeneration: generation(f) } }));
    assert.deepEqual(afterB, before, 'B cannot overwrite checkpoint bytes while A owns the operation');
    assert.equal(overlap, false, 'B must not enter while A owns checkpoint operation');
    assert.deepEqual(bObserved.result, { entered: false, ok: false, error: 'state-busy' });
    assert.equal(bObserved.exit, 2, bObserved.stderr);
    assert.deepEqual(aObserved.result, { entered: true, ok: true });
    assert.equal(aObserved.exit, 0, aObserved.stderr);
    assert.equal(generation(f), initial + 1, 'only A committed a generation');
    const c = await w.start('C'); w.release('C', 'go'); await w.wait('C', 'entered');
    await w.finish('C', c, { entered: true, ok: true });
    assert.equal(generation(f), initial + 2, 'released lock permits a subsequent persisted write');
  });
}
for (const phase of ['entered', 'saved']) {
  test(`owner death after ${phase} releases checkpoint operation without discarding committed bytes`, { skip: prerequisite }, async t => {
    const f = await fixture(t); assert.equal(f.open().read().ok, true);
    const w = new Writers(t, f), initial = generation(f);
    const a = await w.start('A', phase === 'saved' ? 'die-after-save' : 'normal');
    w.release('A', 'go'); await w.wait('A', 'entered');
    if (phase === 'saved') { w.release('A', 'finish'); await w.wait('A', 'saved'); }
    const bytes = fs.readFileSync(f.checkpoint);
    assert.equal(generation(f), initial + (phase === 'saved' ? 1 : 0));
    assert.equal(a.child.kill(), true, 'only this fixture-owned process is terminated');
    const exit = await a.closed; assert.ok(exit[0] !== 0 || exit[1], 'owner really died before cleanup');
    assert.deepEqual(fs.readFileSync(f.checkpoint), bytes, 'death preserves last committed bytes');
    const b = await w.start('B'); w.release('B', 'go'); await w.wait('B', 'entered', 'result');
    assert.equal(w.has('B', 'entered'), true, 'dead owner must not strand checkpoint operations');
    assert.deepEqual(fs.readFileSync(f.checkpoint), bytes, 'recovery never resets checkpoint');
    await w.finish('B', b, { entered: true, ok: true });
    assert.equal(generation(f), initial + (phase === 'saved' ? 2 : 1), 'successor updates the exact surviving generation');
  });
}
test('native dependency is lazy and absence fails closed without exposing loader details', { skip: prerequisite }, async t => {
  const f = await fixture(t); assert.equal(f.open().read().ok, true);
  const before = fs.readFileSync(f.checkpoint), raw = f.raw();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/activity-lock-dependency-child.mjs', import.meta.url)), f.directory, f.endpoint],
    { env: childEnv(), encoding: 'utf8', timeout: 15000 });
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'unavailable native dependency preserves checkpoint bytes');
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { version: process.version, executable: process.execPath, calls: 1, entered: false });
  assert.deepEqual(f.raw(), raw, 'unavailable native dependency never edits producer bytes');
});
