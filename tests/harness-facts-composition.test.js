// New coverage: add a row to an isolated actual export, and drive consumers; manifest faults stay unknown through inventory/doctor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HARNESS_FACTS } from '../lib/agent-definition-schema.mjs';
import { HarnessManifests } from '../lib/harness-manifests.mjs';
import { harnessLauncherInventory } from '../lib/harness-launchers.mjs';
import { harnessChecks } from '../lib/harness-checks.mjs';
import { collectHostChecks } from '../lib/host-checks.mjs';
import { harnessManifestStatus } from '../lib/plugins/index.mjs';
import { passed } from '../lib/health.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKED = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1.0"\n';
const record = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8')).legacyResident;

class CopiedHarness {
  constructor(t, resident) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-export-fixture-'));
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    fs.cpSync(path.join(ROOT, 'lib'), path.join(this.root, 'lib'), { recursive: true });
    const file = path.join(this.root, 'lib/agent-definition-schema.mjs'), source = fs.readFileSync(file, 'utf8');
    const anchor = 'export const HARNESS_FACTS = Object.freeze(Object.fromEntries([\n';
    assert.equal(source.split(anchor).length, 2, 'the actual export is patched at its unique row boundary');
    const facts = { runtime: 'fixture-runtime', definition: true, install: true, managed: true, resident, screen: false,
      residentReason: resident ? '' : 'fixture resident unsupported', aliases: [] };
    fs.writeFileSync(file, source.replace(anchor, anchor + `  ['fixture-extra', ${JSON.stringify(facts)}],\n`));
  }
  import(file) { return import(pathToFileURL(path.join(this.root, 'lib', file)).href); }
}

for (const resident of [false, true]) {
  test(`an isolated added row reaches schema/install/runtime and resident=${resident}, without a manifest or startup crash`, async t => {
    const copy = new CopiedHarness(t, resident);
    const schema = await copy.import('agent-definition-schema.mjs');
    const requests = await copy.import('agent-definition-requests.mjs');
    const chain = await copy.import('install-chain.mjs');
    const lifetimes = await copy.import('resident-lifetimes.mjs');
    const screens = await copy.import('plugins/aify-comms/screen-rules.mjs');
    const { observeScreen } = await copy.import('plugins/aify-comms/screen-observer.mjs');
    const body = { version: 1, agent: { id: 'fixture', name: 'Fixture', role: 'worker', harness: 'fixture-extra', mode: 'managed',
      workspace: '/fixture/work', model: '', effort: '', instructions: '', env: {}, herdrSpace: false } };
    assert.deepEqual(schema.definitionProblems(body, 'fixture'), []);
    assert.equal(requests.HARNESS_RUNTIME['fixture-extra'], 'fixture-runtime');
    const parsed = chain.parseChainArgs(['--connect', 'aify-comms=http://example.invalid', '--client', 'fixture-extra', '--no-prompt']);
    assert.equal(parsed.problem, ''); assert.ok(chain.CLIENTS.includes('fixture-extra')); assert.match(chain.USAGE, /fixture-extra/);
    const rendered = [];
    const result = await new chain.InstallChain(parsed, { env: {}, say() {}, publishedKey: async () => true,
      ensurePackages: async () => true, approvedInstaller: async () => null, connect: async () => ({ status: 0 }),
      packageAssets: async () => null, render: async client => { rendered.push(client); return 0; },
      registryHash: async () => 'unchanged', keyEnv: async () => [], cliPresent: () => true,
      runInstaller: async () => { throw Error('no real installer may run'); } }).run();
    assert.equal(result.exit, 0); assert.deepEqual(rendered, ['fixture-extra']);
    const input = { ...record, harness: 'fixture-extra' };
    const lifetime = lifetimes.parseLifetimeRecord(JSON.stringify(input), `${input.agentId}.${input.lifetime}.json`);
    assert.equal(lifetime.ok, resident);
    assert.equal(screens.manifestForRuntime('fixture-runtime'), null);
    assert.equal(screens.manifestStatusFor('fixture-extra').state, 'unknown');
    const copiedChecks = await copy.import('harness-checks.mjs');
    const copiedLaunchers = await copy.import('harness-launchers.mjs');
    const inventory = copiedLaunchers.harnessLauncherInventory([{ file: '/fixture/fixture-extra-aify', text: MARKED }], { manifestStatus: screens.manifestStatusFor });
    assert.deepEqual(copiedChecks.harnessChecks(inventory).map(row => [row.id, row.state]), [['harness-manifests', 'passed']], 'screen expectations derive from the copied row, not the definition or resident flags');
    assert.equal(observeScreen({ runtime: 'fixture-runtime', read: async () => ({ rows: ['idle'] }), report: async () => {} }), null);
    const known = observeScreen({ runtime: 'claude', read: async () => ({ rows: [] }), report: async () => {} });
    assert.ok(known, 'control: the actual vendored known manifest still starts an observer'); known.dispose();
    assert.equal(HARNESS_FACTS['fixture-extra'], undefined, 'no test row entered the production export');
  });
}

for (const harness of ['claude', 'codex', 'hermes']) for (const [name, readFile, reason] of [
  ['missing', () => { throw Object.assign(Error('fixture missing'), { code: 'ENOENT' }); }, 'missing'],
  ['unreadable', () => { throw Object.assign(Error('fixture denied'), { code: 'EACCES' }); }, 'unreadable'],
  ['invalid JSON', () => Buffer.from('{'), 'invalid'],
  // Replacement decoding would leave valid JSON: only strict UTF-8 decoding catches this fault.
  ['invalid UTF-8', () => Buffer.concat([Buffer.from(`{"id":"${harness}","rules":[],"extra":"`), Buffer.from([0xff]), Buffer.from('"}')]), 'invalid'],
  ['invalid identity', () => Buffer.from(JSON.stringify({ id: 'another-harness', rules: [] })), 'invalid'],
  ['invalid rules', () => Buffer.from(JSON.stringify({ id: harness })), 'invalid'],
  ['invalid aliases', () => Buffer.from(JSON.stringify({ id: harness, rules: [], aliases: 'fixture-alias' })), 'invalid'],
]) {
  test(`a ${name}${harness === 'claude' ? '' : ` ${harness}`} manifest stays unknown through HarnessManifests, launcher inventory and doctor`, async () => {
    const directory = pathToFileURL(ROOT + '/fixture-only/');
    const table = { [harness]: HARNESS_FACTS[harness] };
    const healthy = new HarnessManifests({ directory, facts: table, readFile: () => Buffer.from(JSON.stringify({ id: harness, rules: [] })) }).load();
    assert.equal(healthy.get(harness).state, 'loaded');
    const observed = new HarnessManifests({ directory, facts: table, readFile }).load().get(harness);
    assert.ok(observed, 'a failed manifest remains in the loader inventory');
    assert.equal(observed.state, 'unknown'); assert.match(observed.reason, new RegExp(reason));
    assert.equal(observed.manifest, null);
    const inventory = harnessLauncherInventory([{ file: `/fixture/${harness}-aify`, text: MARKED }], { manifestStatus: () => observed });
    assert.equal(inventory.known[0].found, true, 'the launcher file is installed, not the screen capability');
    assert.equal(inventory.known[0].screen.state, 'unknown');
    const check = harnessChecks(inventory).find(row => row.id === 'harness-manifests');
    assert.ok(check, 'an unknown screen capability gets a diagnosis'); assert.equal(check.state, 'unanswered');
    const rows = await collectHostChecks({ services: [], launchers: () => [{ file: `/fixture/${harness}-aify`, text: MARKED }], manifestStatus: () => observed,
      claudeLogin: () => passed('fixture-login', 'control'), gatewayRecords: () => [], listProcesses: () => [] });
    const diagnosis = rows.find(row => row.id === 'harness-manifests');
    assert.ok(diagnosis); assert.equal(diagnosis.state, 'unanswered'); assert.match(diagnosis.detail, new RegExp(`${harness}.*unknown`));
  });
}

// Regression: known Pi limitations must not make an otherwise healthy installed host permanently unhealthy.
// Existing fault cases above own required-manifest failures; this control owns the healthy combined inventory.
test('a real-shaped four-launcher PATH with every expected manifest loaded has no non-passed harness checks', () => {
  const entries = ['claude', 'codex', 'hermes', 'omp'].map(client => ({ file: `C:/fixture/bin/${client}-aify.cmd`, text: MARKED }));
  const inventory = harnessLauncherInventory(entries, { manifestStatus: harnessManifestStatus });
  assert.deepEqual(inventory.known.map(row => row.client), ['claude', 'codex', 'hermes', 'pi']);
  assert.deepEqual(inventory.unknown, []);
  for (const client of ['claude', 'codex', 'hermes']) assert.equal(inventory.known.find(row => row.client === client).screen.state, 'loaded');
  assert.equal(inventory.known.find(row => row.client === 'pi').screen.state, 'unknown', 'the missing Pi manifest is still an honest inventory observation');
  const checks = harnessChecks(inventory);
  assert.deepEqual(checks.filter(row => row.state !== 'passed'), [], 'known unsupported capabilities cannot permanently fail a healthy host');
  assert.equal(checks.find(row => row.id === 'harness-definitions')?.state, 'passed');
  assert.equal(checks.find(row => row.id === 'harness-manifests')?.state, 'passed');
});

test('unknown marked launcher diagnosis uses the normal doctor route while canonical known files stay advertised', async () => {
  const entries = [{ file: '/fixture/claude-aify', text: MARKED }, { file: '/fixture/novel-aify', text: MARKED }];
  const rows = await collectHostChecks({ services: [], launchers: () => entries,
    claudeLogin: () => passed('fixture-login', 'control'), gatewayRecords: () => [], listProcesses: () => [] });
  const diagnosis = rows.find(row => row.id === 'harness-table');
  assert.ok(diagnosis, 'an unknown marked launcher gets a diagnosis');
  assert.match(diagnosis.detail, /novel-aify: installed but not in this aify-env's harness table/);
  assert.equal(harnessManifestStatus('claude').state, 'loaded');
  assert.equal(harnessManifestStatus('pi').state, 'unknown');
  assert.deepEqual(harnessLauncherInventory(entries).unknown.map(row => row.client), ['novel']);
  assert.equal(harnessChecks(null)[0].state, 'unanswered', 'an unavailable inventory is not an empty successful one');
  assert.equal(harnessChecks({ known: [{ client: 'undeclared', screen: { state: 'unknown' } }], unknown: [] })[0]?.state, 'unanswered', 'a missing screen expectation cannot silently grant an exception');
});
