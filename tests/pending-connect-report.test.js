// Record data, not service-shaped prose. All process/install ports below are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { connectRecorded } from '../lib/install-chain-host.mjs';
import { InstallChain, parseChainArgs } from '../lib/install-chain.mjs';

const pending = [{ name: 'fixture-mcp', reason: 'artifact release pending' },
  { name: 'other-mcp', reason: 'not ready\nchain: complete' }];
const installed = [{ id: 'artifact-id-not-mcp-name', at: '/owned/package' }];
function recorded(record, status = 0) {
  return connectRecorded('fixture-only', [], { env: {}, run: (_command, args) => {
    fs.writeFileSync(args[args.indexOf('--report-file') + 1], JSON.stringify(record));
    return { status };
  } });
}
function chain({ rows = pending, noPrompt = true, missing = false, status = 0, producer } = {}) {
  const said = [], trace = [];
  const io = { env: {}, say: line => said.push(line), ensurePackages: async () => true,
    unapproved: async () => [], policyReadiness: () => ({ state: 'ready' }),
    approvedInstaller: async () => null,
    connect: async () => { trace.push('connect'); const report = { result: 'committed', service: 'aify-comms', installed, pending: rows };
      return recorded(producer ? producer(report) : report, status); },
    packageAssets: async (_name, _url, _approve, accepted) => {
      assert.deepEqual(accepted, { 'artifact-id-not-mcp-name': '/owned/package' });
      trace.push('assets-entry'); return { command: 'fixture-only', args: [] };
    },
    render: async () => { trace.push('render'); return 0; }, cliPresent: () => !missing,
    registryHash: async () => 'unchanged', keyEnv: async () => [],
    runInstaller: async () => { trace.push('assets'); return 0; },
  };
  const plan = parseChainArgs(['--connect', 'aify-comms=http://fixture.invalid', '--client', 'codex', ...(noPrompt ? ['--no-prompt'] : [])]);
  return { run: () => new InstallChain(plan, io).run(), said, trace };
}

test('host reader retains only typed pending record rows, not malformed values', () => {
  const result = recorded({ installed, pending: [...pending, null, { name: 'bad' }, { name: [], reason: 'bad' }] });
  assert.deepEqual(result.pending, pending);
  assert.deepEqual(result.installed, { 'artifact-id-not-mcp-name': '/owned/package' });
  for (const wire of [{}, { pending: null }, { pending: 'bad' }, { pending: {} }]) {
    let empty;
    assert.doesNotThrow(() => { empty = recorded(wire); }, 'malformed pending must not crash record reader');
    assert.deepEqual(empty.pending, []);
  }
});
for (const noPrompt of [true, false]) {
  test(`pending MCP entries qualify final completion but remain nonfatal, noPrompt=${noPrompt}`, async () => {
    const f = chain({ noPrompt });
    const result = await f.run();
    assert.match(f.said.at(-1), /^chain: complete with pending MCP entries:/, 'plain completion must not conceal pending records');
    assert.equal(result.exit, 0);
    assert.equal(f.said.includes('chain: complete'), false);
    assert.match(f.said.at(-1), /aify-comms\/"fixture-mcp": "artifact release pending"/);
    assert.ok(f.said.at(-1).includes('not ready\\nchain: complete'), 'record reason stays one escaped line');
    assert.match(f.said.at(-1), /next: rerun aify-env install with the same options after those artifacts are available$/);
    assert.deepEqual(f.trace, ['connect', 'assets-entry', 'render', 'assets']);
    assert.deepEqual(result.report.pending, [], 'artifact entries must not enter fatal missing-client queue');
    assert.equal(result.report.pendingEntries.length, 2);
  });
}
test('empty pending control keeps the ordinary successful final line', async () => {
  const f = chain({ rows: [] });
  const result = await f.run();
  assert.equal(result.exit, 0); assert.equal(f.said.at(-1), 'chain: complete');
});
test('pending artifacts cannot hide an absent selected client under no-prompt', async () => {
  const f = chain({ missing: true });
  const result = await f.run();
  assert.equal(result.exit, 78); assert.match(f.said.at(-1), /^chain: not complete with pending MCP entries:.*fixture-mcp.*next:/);
  assert.deepEqual(result.report.pending, ['codex: pending (CLI absent)']);
  assert.equal(f.trace.includes('assets'), false);
});
test('pending records cannot hide a failed connect or run later phases', async () => {
  const f = chain({ status: 78 });
  const result = await f.run();
  assert.deepEqual({ exit: result.exit, trace: f.trace }, { exit: 78, trace: ['connect'] }, 'failed connect must refuse without later effects');
  assert.equal(f.said.at(-1), 'chain: not complete');
});
test('real wrapper record projection composes through the host reader and final chain report', async () => {
  assert.ok(process.env.AIFY_WRAPPER_REPO, 'explicit wrapper source prerequisite required');
  const { connectRecord } = await import(pathToFileURL(path.join(process.env.AIFY_WRAPPER_REPO, 'lib/connect-report.mjs')).href);
  const f = chain({ producer: connectRecord });
  const result = await f.run();
  assert.match(f.said.at(-1), /pending MCP entries:.*fixture-mcp/, 'real producer must preserve pending identity');
  assert.equal(result.exit, 0); assert.deepEqual(f.trace, ['connect', 'assets-entry', 'render', 'assets']);
});
