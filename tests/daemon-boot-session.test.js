// Existing shutdown tests cover stop order; these add pending boot acquisition and cancellation custody.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BootSession, BootCancelled } from '../lib/daemon-boot-session.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('cancellation refuses a new boot acquisition without entering its factory', async () => {
  const session = new BootSession(); let created = 0;
  session.cancel();
  const error = await session.acquire('socket', () => { created++; return {}; }, () => {}).then(() => null, error => error);
  assert.deepEqual({ cancelled: error instanceof BootCancelled, created }, { cancelled: true, created: 0 });
});

test('shutdown joins a pending socket and its late acquisition is disposed exactly once', async () => {
  const session = new BootSession(), gate = deferred(), socket = {}, stopped = [];
  const acquiring = session.acquire('socket', () => gate.promise, value => stopped.push(value)).then(() => null, error => error);
  session.cancel();
  const ending = session.stop('socket'), repeated = session.stop('socket');
  assert.ok(ending === repeated, 'the stop request must publish replay custody before entering its disposal');
  assert.deepEqual(stopped, [], 'a pending resource cannot be fabricated for disposal');
  gate.resolve(socket);
  assert.ok(await acquiring instanceof BootCancelled);
  await ending;
  assert.deepEqual(stopped, [socket], 'late completion must close the actual acquired socket once');
});

test('an acquired view restores its screen synchronously before the first shutdown await', async () => {
  const session = new BootSession(), events = [];
  const view = await session.acquire('view', () => ({ stop() { events.push('restore'); } }), value => value.stop());
  assert.ok(view);
  const ending = session.stop('view');
  assert.deepEqual(events, ['restore'], 'a microtask-deferred screen restore is too late');
  await ending; await session.stop('view');
  assert.deepEqual(events, ['restore']);
});

test('pending plugin failure still lets the registry owner stop its partial acquisitions', async () => {
  const session = new BootSession(), gate = deferred(); let stopped = 0;
  const acquiring = session.acquire('plugins', () => gate.promise, () => stopped++).then(() => null, error => error);
  session.cancel(); const ending = session.stop('plugins');
  gate.reject(Error('partial startup failed'));
  assert.ok(await acquiring instanceof BootCancelled);
  await ending; assert.equal(stopped, 1);
});

test('a synchronous advertising factory failure is preserved rather than mistaken for acquisition', () => {
  const session = new BootSession(), cause = Error('advertising factory failed');
  assert.throws(() => session.capture('advertising', () => { throw cause; }, () => {}), error => error === cause);
});

test('a malformed asynchronous advertising factory retains and disposes its late resource', async () => {
  const session = new BootSession(), gate = deferred(), stop = () => {}; const disposed = [];
  assert.throws(() => session.capture('advertising', () => gate.promise, value => disposed.push(value)), /must complete synchronously/);
  gate.resolve(stop); await session.stop('advertising');
  assert.deepEqual({ count: disposed.length, same: disposed[0] === stop }, { count: 1, same: true });
});

test('normal boot acquisition stays live until the existing shutdown slot stops it', async () => {
  const session = new BootSession(), resource = {}; let stopped = 0;
  assert.equal(await session.acquire('socket', () => resource, () => stopped++), resource);
  assert.equal(stopped, 0, 'successful boot must not dispose its own live resource');
  await session.stop('socket'); assert.equal(stopped, 1);
});

test('finishing cancelled boot joins a pending view before stopping service plugins', async () => {
  const session = new BootSession(), viewReady = deferred(), events = [];
  const acquiring = session.acquire('view', () => viewReady.promise, view => view.stop()).catch(error => error);
  session.cancel();
  const ending = session.finishBootAndStopPlugins({ stopAll: () => events.push('plugins') });
  assert.deepEqual(events, []);
  viewReady.resolve({ stop: () => events.push('view') });
  await ending; assert.ok(await acquiring instanceof BootCancelled);
  assert.deepEqual(events, ['view', 'plugins']);
});
