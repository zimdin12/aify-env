// Staged capability facts are new. Existing definition fixtures retain structural validation coverage unchanged.
// These tests use file text/data and private ports; no launcher, installer or live OS process is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as schema from '../lib/agent-definition-schema.mjs';
import { HARNESS_RUNTIME } from '../lib/agent-definition-requests.mjs';
import { CLIENTS, parseChainArgs } from '../lib/install-chain.mjs';
import { installedHarnesses, runtimeAvailability } from '../lib/advertise.mjs';
import { parseLifetimeRecord } from '../lib/resident-lifetimes.mjs';
import { collectHostChecks } from '../lib/host-checks.mjs';
import { passed } from '../lib/health.mjs';
const MARKED = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"\n';
const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8')).legacyResident;
const definition = harness => ({ version: 1, agent: { id: 'fixture', name: 'Fixture', role: 'worker', harness, mode: 'managed',
  workspace: '/fixture/work', model: '', effort: '', instructions: '', env: {}, herdrSpace: false } });
const facts = () => { assert.ok(schema.HARNESS_FACTS, 'the shared schema exports the capability table'); return schema.HARNESS_FACTS; };

test('HARNESS_FACTS is deeply frozen and distinguishes Pi facts from definition admission', () => {
  const table = facts();
  assert.deepEqual(Object.keys(table), ['claude', 'codex', 'hermes', 'pi']);
  assert.ok(Object.isFrozen(table));
  for (const row of Object.values(table)) { assert.ok(Object.isFrozen(row)); assert.ok(Object.isFrozen(row.aliases)); }
  assert.deepEqual({ runtime: table.pi.runtime, definition: table.pi.definition, install: table.pi.install,
    managed: table.pi.managed, resident: table.pi.resident, screen: table.pi.screen, aliases: table.pi.aliases },
    { runtime: 'pi', definition: false, install: false, managed: true, resident: false, screen: false, aliases: ['omp'] });
  assert.deepEqual(Object.entries(table).filter(([, row]) => row.screen === true).map(([name]) => name), ['claude', 'codex', 'hermes']);
  assert.match(table.pi.residentReason, /single-client.*resident wake/i);
  assert.throws(() => { table.pi.definition = true; }, TypeError);
});

test('the production definition enum and definition-runtime map stay exactly the existing three harnesses', () => {
  const table = facts(), admitted = Object.entries(table).filter(([, row]) => row.definition === true).map(([name]) => name);
  assert.deepEqual(admitted, ['claude', 'codex', 'hermes']);
  assert.deepEqual(HARNESS_RUNTIME, { claude: 'claude-code', codex: 'codex', hermes: 'hermes' });
  for (const harness of admitted) assert.deepEqual(schema.definitionProblems(definition(harness), 'fixture'), []);
  assert.deepEqual(schema.definitionProblems(definition('pi'), 'fixture'), ['agent.harness: unsupported']);
});

for (const harness of ['claude', 'codex', 'hermes']) {
  test(`the existing ${harness} resident record still loads unchanged`, () => {
    const record = { ...baseline, harness }, file = `${record.agentId}.${record.lifetime}.json`;
    assert.deepEqual(parseLifetimeRecord(JSON.stringify(record), file), { ok: true, record });
    assert.equal(facts()[harness].resident, true);
  });
}
for (const harness of ['pi', 'omp', 'claude-code', 'hermes-agent']) {
  test(`${harness} is not a newly admitted resident-record spelling`, () => {
    const record = { ...baseline, harness };
    assert.equal(parseLifetimeRecord(JSON.stringify(record), `${record.agentId}.${record.lifetime}.json`).ok, false);
  });
}

test('installer selections derive install facts and retain exactly three clients, refusing Pi and omp', () => {
  assert.deepEqual(CLIENTS, ['claude', 'codex', 'hermes']);
  assert.deepEqual(CLIENTS, Object.entries(facts()).filter(([, row]) => row.install === true).map(([name]) => name));
  for (const client of CLIENTS) assert.equal(parseChainArgs(['--connect', 'fixture=http://example.invalid', '--client', client]).problem, '');
  assert.equal(parseChainArgs(['--connect', 'fixture=http://example.invalid', '--client', 'pi']).problem, 'unknown client pi (claude, codex, hermes)');
  assert.equal(parseChainArgs(['--connect', 'fixture=http://example.invalid', '--client', 'omp']).problem, 'unknown client omp (claude, codex, hermes)');
});

test('known launcher aliases resolve canonically while unknown marked launchers are not advertised as supported', () => {
  const rows = installedHarnesses([{ file: '/fixture/claude-aify', text: MARKED },
    { file: '/fixture/omp-aify', text: MARKED }, { file: '/fixture/future-aify', text: MARKED }]);
  assert.deepEqual(rows.map(row => [row.client, row.command]), [['claude', 'claude-aify'], ['pi', 'omp-aify']]);
  assert.deepEqual(runtimeAvailability(rows).map(row => row.runtime), ['claude', 'pi']);
});

const doctor = harnesses => collectHostChecks({ services: [], harnesses: () => harnesses,
  claudeLogin: () => passed('fixture-login', 'private control'), gatewayRecords: () => [], listProcesses: () => [] });

test('doctor reports decided Pi limitations as passed information without granting definition support', async () => {
  const rows = await doctor([{ client: 'pi', command: 'pi-aify', found: true, path: '/fixture/pi-aify' }]);
  const admission = rows.find(row => row.id === 'harness-definitions');
  assert.ok(admission, 'definition admission deferred is an explicit diagnosis');
  assert.match(admission.detail, /pi.*definition admission deferred/i); assert.equal(admission.state, 'passed');
  const manifest = rows.find(row => row.id === 'harness-manifests');
  assert.ok(manifest, 'a missing manifest must remain an observation, not disappear from inventory');
  assert.equal(manifest.state, 'passed'); assert.match(manifest.detail, /pi.*screen detection unsupported by design/i);
});
