// #19 covers spawn admission. These cases add the missing shutdown snapshot and cancellation windows.
// InFlightSpawns and RunnerStream are exercised through Runner; existing replay/geometry tests retain stream coverage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShutdown } from '../lib/shutdown.mjs';
import { PosixProcessGroup } from '../lib/posix-process-group.mjs';
import { StartAdmissionRefusal } from '../lib/start-admission-refusal.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { fixture, child, tick, failed } from './fixtures/spawn-outcomes.mjs';
new ProcessEffectTripwire();

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function owned(t, options = {}) {
  const c = child(), stops = [];
  c.kill = () => { stops.push('handle'); };
  const f = fixture(t, { spawnProcess: () => c, stopExitWaitMs: 100,
    isAlive: () => true,
    killTree: async pid => { assert.equal(pid, c.pid); stops.push('tree'); c.emit('close', null, 'SIGTERM'); },
    ...options });
  return { ...f, c, stops };
}

test('shutdown captures the actual child while spawn confirmation is pending, without a public 201', async t => {
  const f = owned(t), lines = [];
  let replied = false, cleared = 0, exits = 0;
  const response = f.post({ service: 'fixture', launcher: '/fixture' }, { platform: 'linux' }).then(answer => { replied = true; return answer; });
  await tick();
  assert.equal(f.runner.shutdownView().list().length, 1, 'the created child must be in the private shutdown snapshot');
  assert.deepEqual(f.runner.list(), [], 'private custody is not a public success entry');
  assert.equal(replied, false, 'HTTP cannot send 201 before spawn confirms');
  assert.equal(f.writes.length, 0, 'no durable success row before confirmation');
  const stop = createShutdown({ runner: f.runner, write: line => lines.push(line),
    clearOwned: () => cleared++, exit: () => exits++, stopDeadlineMs: 500 });
  const ending = stop('fixture');
  await tick();
  assert.ok(lines.some(line => line.includes('spawn-wait')), 'the real shutdown owner must enter the pending stop');
  f.c.emit('spawn');
  assert.equal((await response).status, 201);
  await ending;
  assert.deepEqual(f.stops, ['handle', 'tree']);
  assert.equal(cleared, 1); assert.equal(exits, 1);
  assert.deepEqual(f.runner.shutdownView().list(), []);
});

test('a shutdown snapshot taken before handoff still reaches the admitted stop witness', async t => {
  const f = owned(t), starting = f.runner.start(f.spec);
  const view = f.runner.shutdownView(), [pending] = view.list();
  assert.ok(pending, 'positive control: private entry exists before handoff');
  f.c.emit('spawn'); const handle = await starting;
  assert.deepEqual(view.list().map(row => row.id), [handle.id], 'handoff must not duplicate the public entry');
  assert.equal((await view.stop(pending.id)).stopped, true);
  assert.deepEqual(f.stops, ['handle', 'tree']);
  assert.deepEqual(view.list(), []);
});

test('a retained snapshot cannot certify a closed root whose admitted group is still unknown', async t => {
  const signals = []; let gone = false;
  const f = owned(t, { platform: 'linux', makeProcessGroup: parts => new PosixProcessGroup({ ...parts,
    selfPid: 111, parentPid: 112, signal: (target, kind) => {
      signals.push({ target, kind });
      throw Object.assign(Error('fixture observation'), { code: gone ? 'ESRCH' : 'EPERM' });
    } }) });
  const starting = f.runner.start(f.spec), view = f.runner.shutdownView(), [pending] = view.list();
  f.c.emit('spawn'); const handle = await starting;
  f.c.emit('close', null, 'SIGTERM');
  const result = await view.stop(pending.id);
  assert.equal(result.stopped, false, 'a root close must not drop the snapshot alias and manufacture successful group cleanup');
  assert.equal(result.groupCleanup?.state, 'unknown');
  assert.deepEqual(view.list().map(row => row.id), [handle.id]);
  assert.deepEqual(f.stops, []);
  assert.ok(signals.length > 0 && signals.every(call => call.target === -f.c.pid && call.kind === 0));
  gone = true;
  assert.equal((await f.runner.stop(handle.id)).stopped, true, 'positive control: admitted custody releases after fresh positive absence');
  assert.deepEqual(view.list(), []);
});

test('spawn error racing pending shutdown clears private custody without any success row', async t => {
  const f = owned(t), starting = failed(f.runner.start(f.spec));
  const view = f.runner.shutdownView(), [pending] = view.list();
  const ending = view.stop(pending.id);
  f.c.emit('error', Object.assign(Error('fixture creation error'), { code: 'ENOENT' }));
  assert.equal((await starting).error?.name, 'SpawnFailure');
  assert.equal((await ending).stopped, true);
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.effects(), f.untouched);
  assert.deepEqual(view.list(), []);
});

test('an unconfirmed timeout retains custody, replays one stop, and stops a late successful handoff', async t => {
  const f = owned(t, { stopExitWaitMs: 5 }), budgets = [];
  const original = f.runner.stop.bind(f.runner);
  t.mock.method(f.runner, 'stop', (id, options) => { budgets.push(options.budgetMs); return original(id, options); });
  const starting = f.runner.start(f.spec), view = f.runner.shutdownView(), [pending] = view.list();
  const ending = view.stop(pending.id), replay = view.stop(pending.id);
  assert.ok(ending === replay, 'one in-flight child has one pending stop attempt');
  const result = await ending;
  assert.equal(result.stopped, false);
  assert.match(result.problem, /^execution-unknown:/);
  assert.deepEqual(f.stops, ['handle'], 'timeout may use the actual handle, never a PID-only tree guess');
  assert.equal(view.list().length, 1, 'a kill attempt does not retire unknown custody');
  assert.equal(f.writes.length, 0);
  f.c.emit('spawn'); await starting; await tick();
  assert.deepEqual(budgets, [0], 'handoff cannot acquire a fresh stop budget after the pending deadline');
  assert.deepEqual(f.stops, ['handle', 'handle', 'tree']);
  assert.deepEqual(view.list(), []);
});

test('timeout followed by spawn failure retires no success record and does not invent a tree kill', async t => {
  const f = owned(t, { stopExitWaitMs: 5 }), starting = failed(f.runner.start(f.spec));
  const view = f.runner.shutdownView(), [pending] = view.list();
  assert.equal((await view.stop(pending.id)).stopped, false);
  f.c.emit('error', Object.assign(Error('late failure'), { code: 'EACCES' }));
  assert.equal((await starting).error?.name, 'SpawnFailure'); await tick();
  assert.deepEqual(view.list(), []);
  assert.deepEqual(f.stops, ['handle']);
  assert.equal(f.writes.length, 0); assert.deepEqual(f.runner.list(), []);
});

for (const boundary of ['checkpoint', 'gate', 'roots']) {
  test(`cancellation during ${boundary} is checked after all awaits and before child creation`, async t => {
    const wait = deferred(), c = child(); let cancelled = false, created = 0;
    c.onData = fn => c.on('data', fn); c.onExit = fn => c.on('pty-exit', fn);
    const spawn = () => { created++; queueMicrotask(() => c.emit('spawn')); return c; };
    const f = fixture(t, { openTerminal: boundary === 'checkpoint' ? spawn : null, spawnProcess: spawn,
      loadCheckpoint: boundary === 'checkpoint' ? () => wait.promise : null,
      startGate: boundary === 'gate' ? () => wait.promise : null });
    const options = { admitSpawn: () => boundary === 'roots' ? wait.promise : f.home,
      assertOpen: () => { if (cancelled) throw new StartAdmissionRefusal('boot cancelled'); } };
    const pending = failed(f.runner.start(f.spec, options));
    await tick(); cancelled = true; wait.resolve(boundary === 'roots' ? f.home : null);
    const refused = await pending;
    assert.ok(refused.error instanceof StartAdmissionRefusal, 'late cancellation must be a typed admission refusal');
    assert.equal(created, 0, 'no child may be created after cancellation during the final roots await');
    assert.deepEqual(f.effects(), f.untouched);
    assert.deepEqual(f.runner.shutdownView().list(), []);
    cancelled = false;
    const handle = await f.runner.start(f.spec, options);
    assert.equal(created, 1, 'positive control: the same path admits a fresh open start');
    c.emit('close', 0, null); c.emit('pty-exit', { exitCode: 0 }); await handle.exited;
  });
}

for (const rejected of [false, true]) {
  test(`a ${rejected ? 'rejecting' : 'fulfilling'} thenable final guard is refused, not awaited into spawn`, async t => {
    let created = 0;
    const f = fixture(t, { spawnProcess: () => { created++; const c = child(); queueMicrotask(() => c.emit('spawn')); return c; } });
    const result = await failed(f.runner.start(f.spec, { assertOpen: () => rejected ? Promise.reject(Error('fixture')) : Promise.resolve() }));
    assert.equal(result.error?.name, 'TypeError');
    assert.match(result.error?.message ?? '', /must be synchronous/);
    assert.equal(created, 0); assert.deepEqual(f.effects(), f.untouched); await tick();
  });
}
