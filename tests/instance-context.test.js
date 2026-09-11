import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instanceFixture } from './helpers/instance-fixture.mjs';

const modulePath = new URL('../lib/instance-context.mjs', import.meta.url);
async function api() {
  assert.ok(fs.existsSync(modulePath), 'inert instance-context module must exist');
  return import(modulePath);
}
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-instance-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, ...instanceFixture(parent) };
}

test('context import and reads are inert; host identity stays physical', async t => {
  const f = fixture(t); const before = fs.readdirSync(f.context.root);
  const { readInstanceContext, instanceAdvertisement } = await api();
  const context = readInstanceContext(f.file);
  assert.deepEqual(context, f.context); assert.ok(Object.isFrozen(context));
  assert.deepEqual(fs.readdirSync(f.context.root), before);
  const host = { machineId: 'physical', hostname: 'host', metadata: { build: 'original' } };
  const scoped = instanceAdvertisement(host, context);
  assert.equal(scoped.machineId, host.machineId);
  assert.equal(scoped.metadata.scope, context.scope);
  assert.equal(scoped.metadata.invocation, context.invocation);
  assert.deepEqual(host.metadata, { build: 'original' });
});

test('invalid context fields fail closed without creating runtime artifacts', async t => {
  const { readInstanceContext } = await api();
  const f = fixture(t); const original = { ...f.context };
  for (const patch of [
    { invocation: undefined }, { invocation: 'not-a-uuid' }, { version: 2 },
    { scope: 'default' }, { takeover: 'force' }, { recovery: 'restore' },
    { root: f.parent }, { processRecord: path.join(os.homedir(), '.aify/env-processes.json') },
    { processRecord: path.join(f.context.root, '../escaped.json') },
    { ownerEndpoint: 'http://127.0.0.1:8802' }, { readinessEndpoint: path.join(f.parent, 'ready.json') },
    { herdrApiEndpoint: 'unknown' }, { profileRef: '../secret' }, { extra: 'unsupported' },
  ]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => readInstanceContext(f.file), /instance_context/);
    assert.deepEqual(fs.readdirSync(f.context.root).sort(), ['instance.json', 'services.json']);
  }
  assert.throws(() => readInstanceContext('relative.json'), /instance_context/);
});

test('junction roots and multiply-linked context files are refused', async t => {
  const { readInstanceContext } = await api(); const f = fixture(t);
  const alias = path.join(f.parent, 'alias');
  fs.symlinkSync(f.context.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readInstanceContext(path.join(alias, 'instance.json')), /instance_context/);
  fs.renameSync(f.file, path.join(f.context.root, 'source.json'));
  fs.linkSync(path.join(f.context.root, 'source.json'), f.file);
  assert.throws(() => readInstanceContext(f.file), /instance_context/);
});

test('CLI context option is exact and cannot combine with force or subcommands', async () => {
  const { instanceContextArgument } = await api();
  assert.equal(instanceContextArgument([]), null);
  assert.equal(instanceContextArgument(['--port', '0']), null);
  assert.equal(instanceContextArgument(['run', '--', '--instance-context', 'child-option']), null);
  for (const args of [['--instance-context'], ['--instance-context', 'relative'],
    ['--instance-context=x'], ['--force', '--instance-context', '/absolute'],
    ['tui', '--instance-context', '/absolute'],
    ['--instance-context', '/absolute', '--instance-context', '/other']]) {
    assert.throws(() => instanceContextArgument(args), /instance_context/);
  }
});
