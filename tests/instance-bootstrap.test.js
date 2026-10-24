import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { instanceFixture } from './helpers/instance-fixture.mjs';
import { prepareInstance, publishInstanceReady } from '../lib/instance-bootstrap.mjs';
import { contextError } from '../lib/instance-context.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return instanceFixture(root);
}
test('bootstrap rejects a context changed while owner authorization is pending', async t => {
  const f = fixture(t);
  const owner = net.createServer(socket => socket.once('data', bytes => {
    const request = JSON.parse(bytes);
    f.context.profileRef = 'changed'; f.save();
    socket.end(JSON.stringify({ ...request, accepted: true }) + '\n');
  }));
  await new Promise(resolve => owner.listen(f.context.ownerEndpoint, resolve));
  t.after(() => owner.close());
  await assert.rejects(prepareInstance(f.file, { AIFY_ADVERTISE: '0' }), /context changed/);
  assert.deepEqual(fs.readdirSync(f.context.root).sort(), ['instance.json', 'services.json']);
});
test('private ready publication is exclusive and transport-only', t => {
  const f = fixture(t);
  const receipt = publishInstanceReady(f.context, { pid: 123, envInstance: 'fixture', port: 12345, build: 'test' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.context.readinessEndpoint)), receipt);
  assert.equal(receipt.state, 'transport-ready'); assert.equal(receipt.serviceConnected, false);
  assert.throws(() => publishInstanceReady(f.context, receipt), /instance_context/);
  assert.equal(contextError('refused').message, 'instance_context: refused');
});
test('two dedicated preparations can pass before the exclusive readiness claim', async t => {
  const f = fixture(t), waiting = [];
  const owner = net.createServer(socket => socket.once('data', bytes => {
    waiting.push({ socket, request: JSON.parse(bytes) });
    if (waiting.length === 2) for (const { socket, request } of waiting)
      socket.end(JSON.stringify({ ...request, accepted: true }) + '\n');
  }));
  await new Promise(resolve => owner.listen(f.context.ownerEndpoint, resolve));
  t.after(() => owner.close());
  const prepared = await Promise.all([prepareInstance(f.file, {}), prepareInstance(f.file, {})]);
  assert.equal(prepared.length, 2, 'preparation alone is not an exclusive scope owner');
  assert.equal(prepared[0].scope, prepared[1].scope);
  publishInstanceReady(prepared[0], { pid: 123, envInstance: 'first', port: 12345, build: 'test' });
  assert.throws(() => publishInstanceReady(prepared[1],
    { pid: 124, envInstance: 'second', port: 12346, build: 'test' }), /instance_context/);
});
