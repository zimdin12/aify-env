// The real daemon is read, never imported. These source-bound payloads connect the independently tested core owners.
// Existing #22 boot batching was an extracted inline body; #17 moves that body to an importable core owner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { handleRequest } from '../lib/protocol.mjs';
new ProcessEffectTripwire();
const source = fs.readFileSync(new URL('../bin/aify-env.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

test('the actual host bootstrap passes its record and dedicated recovery policy to the ownership factory', async () => {
  const statement = source.match(/^const ownership = await createOwnershipRecovery\([^\n]+\);$/m)?.[0];
  assert.ok(statement, 'actual ownership initializer found');
  const calls = [], owned = {};
  const execute = new AsyncFunction('createOwnershipRecovery', 'OWNED_FILE', 'instanceContext', statement + '\nreturn ownership;');
  for (const context of [null, { invocation: 'fixture-private' }]) {
    assert.equal(await execute(async options => { calls.push(options); return owned; }, 'private-fixture-record', context), owned);
  }
  assert.deepEqual(calls, [{ file: 'private-fixture-record', recover: true }, { file: 'private-fixture-record', recover: false }]);
});

test('the actual Runner payload receives the same record owner and host-wide admission callback', async () => {
  const start = source.indexOf('const runner = new Runner('), end = source.indexOf('\n\n// SERVICE PLUGINS.', start);
  assert.ok(start >= 0 && end > start, 'actual Runner construction bounded independently');
  const record = {}, calls = [], ownership = { record, recovery: { admitStart: () => calls.push('admit') } };
  const execute = new AsyncFunction('Runner', 'OWNED_FILE', 'ownership', source.slice(start, end) + '\nreturn runner;');
  class CaptureRunner { constructor(options) { this.options = options; } }
  const runner = await execute(CaptureRunner, 'private-fixture-record', ownership);
  assert.equal(runner.options.ownedRecord, record);
  assert.equal(typeof runner.options.startGate, 'function', 'the actual host payload must provide the admission callback');
  await runner.options.startGate();
  assert.deepEqual(calls, ['admit']);
});

test('the actual bound-listener recovery trigger reaches the core owner while dedicated instances still skip it', async () => {
  const body = source.match(/^async function reapLeftovers\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(body, 'actual named boot function found');
  const calls = [];
  await new AsyncFunction('ownership', body + '\nreturn reapLeftovers();')({ recovery: { recover: () => calls.push('recover') } });
  assert.deepEqual(calls, ['recover']);
  const listen = source.slice(source.indexOf('server.listen(port, HOST, async () => {'));
  assert.match(listen, /if \(instanceContext\) \{[\s\S]*?publishInstanceReady[\s\S]*?\} else await reapLeftovers\(\);/);
});

test('the actual supersede and shutdown payloads no longer call the unverified numeric killer or replace a shared keep snapshot', () => {
  const start = source.indexOf('    superseding = true;'), end = source.indexOf('    server.listen(port, HOST);', start);
  assert.ok(start >= 0 && end > start);
  const takeover = source.slice(start, end);
  assert.match(takeover, /await ownership\.recovery\.supersede\(holder\)/);
  assert.doesNotMatch(takeover, /killTree\(holder\.pid\)/);
  const refusal = source.indexOf('if (atRisk.length > 0)');
  assert.ok(refusal > 0 && refusal < start, 'work-loss decision remains before all takeover effects');
  assert.match(source, /clearOwned: \(\) => runner\.retireEndedRecords\(\)/);
  assert.doesNotMatch(source, /clearOwned\(OWNED_FILE/);
});

test('ownership recovery diagnosis and the owner birth are actually exposed by health', async () => {
  assert.match(source, /ownerIdentity: ownership\.ownerIdentity,/);
  assert.match(source, /ownershipRecovery: ownership\.recovery\.status\(\),/);
  const ownerIdentity = { version: 1, platform: 'win32', pid: 424242, createdAtUs: 1700000000000000 };
  const ownershipRecovery = { ready: false, state: 'held', problem: 'original incumbent is unknown', displacedPid: 99, unresolvedRecords: 2 };
  const result = await handleRequest({ method: 'GET', path: '/health' }, { ownerIdentity, ownershipRecovery,
    runner: { list: () => [], instance: () => 'fixture' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.ownerIdentity, ownerIdentity);
  assert.deepEqual(result.body.ownershipRecovery, ownershipRecovery);
});
