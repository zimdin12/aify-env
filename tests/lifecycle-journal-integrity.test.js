import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LifecycleJournal, AgentLifecycle } from '../lib/agent-lifecycle.mjs';
import { bootDaemonAgentState } from '../lib/daemon-agent-state.mjs';
import { generationFile } from '../lib/publication-generation.mjs';

const request = (patch = {}) => ({ id: 'r1', agentId: 'a', machineId: 'm', storeId: 's',
  expectedIncarnation: 1, expectedRevision: 1, expectedLifetime: null, action: 'stop',
  requestedBy: 'agent', freshContext: false, ...patch });
const answer = (patch = {}) => ({ status: 'done', outcome: 'stop', resultLifetime: null,
  finishedAt: '2026-10-08T00:00:00.000Z', ...patch });
function fixture(t, seeded = true) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR, 'd9-integrity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'agent-lifecycle.json');
  if (seeded) fs.writeFileSync(file, JSON.stringify({ version: 1, records: {}, stops: {} }));
  return { home, file, journal: new LifecycleJournal({ file }) };
}
function poison(f, mutate) {
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  mutate(state, state.records.r1);
  fs.writeFileSync(f.file, JSON.stringify(state));
  return fs.readFileSync(f.file, 'utf8');
}

test('healthy pending custody, terminal result and cross-instance replay remain typed', t => {
  const f = fixture(t), r = request();
  const admission = f.journal.reserve(r);
  assert.equal(admission.fresh, true);
  assert.deepEqual(admission.unknown, answer({ status: 'failed', outcome: 'execution-unknown',
    finishedAt: admission.unknown.finishedAt }));
  assert.deepEqual(new LifecycleJournal({ file: f.file }).reserve(r), { fresh: false, result: admission.unknown });
  assert.equal(f.journal.reserve(request({ id: 'r2' })).result.outcome, 'agent-reserved');
  const terminal = f.journal.finish(r, answer(), true);
  assert.deepEqual(terminal, answer());
  assert.deepEqual(new LifecycleJournal({ file: f.file }).reserve(r), { fresh: false, result: terminal });
  assert.equal(f.journal.stopFacts().get('s:1:a'), true);
  assert.equal(f.journal.open().length, 0);
});

const corruptions = [
  ['scalar unknown', (_s, row) => { row.unknown = 1; }],
  ['array unknown', (_s, row) => { row.unknown = []; }],
  ['unknown wrong status', (_s, row) => { row.unknown.status = 'done'; }],
  ['unknown wrong outcome', (_s, row) => { row.unknown.outcome = 'other'; }],
  ['unknown non-null lifetime', (_s, row) => { row.unknown.resultLifetime = 'live'; }],
  ['unknown empty timestamp', (_s, row) => { row.unknown.finishedAt = ''; }],
  ['unknown missing lifetime', (_s, row) => { delete row.unknown.resultLifetime; }],
  ['incomplete terminal', (_s, row) => { row.phase = 'terminal'; row.result = { status: 'done' }; }],
  ['terminal scalar', (_s, row) => { row.phase = 'terminal'; row.result = 'done'; }],
  ['terminal untyped outcome', (_s, row) => { row.phase = 'terminal'; row.result = answer({ outcome: 1 }); }],
  ['terminal missing timestamp', (_s, row) => { row.phase = 'terminal'; row.result = answer(); delete row.result.finishedAt; }],
  ['pending with terminal result', (_s, row) => { row.result = answer(); }],
  ['changed row agent', (_s, row) => { row.agentId = 'b'; }],
  ['changed map id', (s, row) => { s.records.r2 = row; delete s.records.r1; }],
  ['unparseable intent', (_s, row) => { row.intent = '{bad'; }],
  ['noncanonical intent whitespace', (_s, row) => { row.intent = ' ' + row.intent; }],
  ['intent wrong action', (_s, row) => { const tuple = JSON.parse(row.intent); tuple[7] = 'dance'; row.intent = JSON.stringify(tuple); }],
  ['intent missing tuple field', (_s, row) => { const tuple = JSON.parse(row.intent); tuple.pop(); row.intent = JSON.stringify(tuple); }],
  ['intent untyped revision', (_s, row) => { const tuple = JSON.parse(row.intent); tuple[5] = '1'; row.intent = JSON.stringify(tuple); }],
  ['intent untyped fresh context', (_s, row) => { const tuple = JSON.parse(row.intent); tuple[9] = null; row.intent = JSON.stringify(tuple); }],
];
for (const [name, mutate] of corruptions) test(`${name} refuses reads and same-agent reservation without writes`, t => {
  const f = fixture(t); f.journal.reserve(request());
  const before = poison(f, mutate);
  assert.throws(() => f.journal.reserve(request()), /lifecycle-journal-malformed/);
  assert.throws(() => f.journal.reserve(request({ id: 'r3' })), /lifecycle-journal-malformed/);
  assert.throws(() => f.journal.open(), /lifecycle-journal-malformed/);
  assert.throws(() => f.journal.stopFacts(), /lifecycle-journal-malformed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

for (const invalid of [{ status: 'done' }, 1, answer({ resultLifetime: 1 }), answer({ finishedAt: '' }),
  answer({ resultIncarnation: 1 })]) test(`invalid finish ${JSON.stringify(invalid)} cannot corrupt custody`, t => {
  const f = fixture(t); f.journal.reserve(request());
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.journal.finish(request(), invalid), /lifecycle-journal-malformed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.journal.open().length, 1);
});
test('invalid reserve request and stop fact cannot publish corrupt journal', t => {
  const f = fixture(t); const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.journal.reserve(request({ expectedRevision: '1' })), /invalid lifecycle request/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  f.journal.reserve(request()); const reserved = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.journal.finish(request(), answer(), 'yes'), /lifecycle-journal-malformed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), reserved);
});

test('construction, reads and reservations never initialize absent journal', t => {
  const f = fixture(t, false);
  assert.equal(fs.existsSync(f.file), false);
  for (const read of [() => f.journal.stopFacts(), () => f.journal.open(), () => f.journal.reserve(request())])
    assert.throws(read, /^Error: lifecycle journal missing$/);
  assert.equal(fs.existsSync(f.file), false);
});
test('only explicit virgin initialization creates journal and existing valid bytes are preserved', t => {
  const f = fixture(t, false);
  f.journal.initialize({ priorBoot: false });
  f.journal.reserve(request()); f.journal.finish(request(), answer(), true);
  const before = fs.readFileSync(f.file, 'utf8');
  new LifecycleJournal({ file: f.file }).initialize({ priorBoot: true });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.unlinkSync(f.file);
  assert.throws(() => f.journal.initialize({ priorBoot: true }), /^Error: lifecycle journal missing$/);
  assert.equal(fs.existsSync(f.file), false);
});
test('explicit initialization refuses malformed existing journal and untyped prior boot', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{}');
  assert.throws(() => f.journal.initialize({ priorBoot: false }), /lifecycle-journal-malformed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{}');
  const absent = fixture(t, false);
  assert.throws(() => absent.journal.initialize({}), TypeError);
  assert.equal(fs.existsSync(absent.file), false);
});
test('missing reserve yields typed refusal before any dependency or effect', async t => {
  const f = fixture(t, false); let effects = 0;
  const poison = () => { effects++; throw Error('must not reach dependency'); };
  const lifecycle = new AgentLifecycle({ journal: f.journal, definitions: { list: poison },
    identity: poison, stop: poison, start: poison, buildSpec: poison });
  const result = await lifecycle.execute(request());
  assert.deepEqual(result, answer({ status: 'refused', outcome: 'lifecycle journal missing', finishedAt: result.finishedAt }));
  assert.equal(effects, 0); assert.equal(fs.existsSync(f.file), false);
});

test('complete explicit absence may durably stop without termination', async t => {
  const f = fixture(t); let stops = 0;
  const reading = { id: 'a', incarnation: 1, revision: 1, problems: [], agent: { mode: 'managed' } };
  const listing = { storeId: 's', definitions: [reading] };
  const lifecycle = new AgentLifecycle({ journal: f.journal, machineId: 'm',
    definitions: { list: () => listing, withLifecycleDefinition: work => work(listing) },
    identity: () => ({ conflict: false, unknown: false, current: null }), stop: () => { stops++; } });
  const result = await lifecycle.execute(request());
  assert.equal(result.status, 'done'); assert.equal(result.outcome, 'stop'); assert.equal(stops, 0);
  assert.equal(f.journal.stopFacts().get('s:1:a'), true);
  assert.deepEqual(await lifecycle.execute(request()), result);
});
test('omitted current is unanswered identity, not explicit absence', async t => {
  const f = fixture(t);
  const listing = { storeId: 's', definitions: [{ id: 'a', incarnation: 1, revision: 1,
    problems: [], agent: { mode: 'managed' } }] };
  const lifecycle = new AgentLifecycle({ journal: f.journal, machineId: 'm',
    definitions: { list: () => listing, withLifecycleDefinition: work => work(listing) },
    identity: () => ({ conflict: false, unknown: false }) });
  assert.equal((await lifecycle.execute(request())).outcome, 'identity-unknown');
  assert.equal(f.journal.stopFacts().size, 0);
});

function boot(f, patch = {}) {
  return bootDaemonAgentState({ aifyHome: f.home, url: 'http://127.0.0.1:9999', pid: 9,
    nowMs: 1000, nowUs: () => 1000000, probe: () => new Map(), ...patch });
}
test('actual boot initializes virgin home once before generation and preserves durable custody', t => {
  const f = fixture(t, false); const first = boot(f);
  assert.equal(fs.existsSync(f.file), true);
  assert.equal(first.generation, 1000);
  f.journal.reserve(request()); f.journal.finish(request(), answer(), true);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.equal(boot(f).generation, 1001);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('a lost journal is reported and never recreated; the host boots and lifecycle actions refuse', async t => {
  const f = fixture(t, false); boot(f); fs.unlinkSync(f.file);
  const reports = [];
  const booted = boot(f, { context: { scope: 'new-scope' }, report: text => reports.push(text) });
  assert.equal(booted.generation, 1000, 'the host still boots');
  assert.equal(fs.existsSync(f.file), false, 'a lost journal is never silently recreated');
  assert.ok(reports.some(text => text.startsWith('agent state: lifecycle journal missing; lifecycle actions are refused')));
  const refused = await new AgentLifecycle({ journal: f.journal }).execute(request());
  assert.equal(refused.outcome, 'lifecycle journal missing');
});
test('a malformed journal is reported, kept as found, and the host boots', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{}');
  const reports = [];
  assert.equal(boot(f, { report: text => reports.push(text) }).generation, 1000);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{}');
  assert.ok(reports.some(text => text.startsWith('agent state: lifecycle-journal-malformed;')));
});
test('unreadable generation evidence refuses virgin initialization and generation write', t => {
  const f = fixture(t, false);
  fs.mkdirSync(generationFile(f.home, 'other-scope'), { recursive: true });
  const reports = [];
  assert.throws(() => boot(f, { report: text => reports.push(text) }));
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(generationFile(f.home, 'default')), false);
  assert.equal(reports.length, 1);
});
