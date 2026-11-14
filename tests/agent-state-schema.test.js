// One shared fixture/example set, captured at AgentStateSender's transport through the real host/read/publisher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Validator } from 'jsonschema';
import { captureAgentStatePublications } from './fixtures/agent-state-publications.mjs';
import { deriveAgentState } from '../lib/agent-state.mjs';

const schemaFile = new URL('../docs/agent-state/schema.json', import.meta.url);
const examplesFile = new URL('../docs/agent-state/publications.json', import.meta.url);
const schema = JSON.parse(fs.readFileSync(schemaFile));
const examples = JSON.parse(fs.readFileSync(examplesFile));
const validator = new Validator();
const validate = body => validator.validate(body, schema, { nestedErrors: true });
let capture;
const actual = () => capture ??= captureAgentStatePublications();
const named = name => {
  const fixture = examples.find(row => row.name === name);
  assert.ok(fixture, `missing real captured example ${name}`);
  return structuredClone(fixture.body);
};

test('real sender bodies validate and exactly reproduce the single fixture/example set', async () => {
  const fresh = await actual();
  assert.ok(fresh.length >= 20, 'inspect a real publisher population, not one happy envelope');
  if (process.env.AIFY_UPDATE_AGENT_STATE_FIXTURES === '1') {
    fs.writeFileSync(examplesFile, '[\n' + fresh.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n');
  } else assert.deepEqual(fresh, examples, 'captured examples drifted; regenerate through the maintained sender fixture');
  for (const { name, body } of fresh) {
    const result = validate(body);
    assert.equal(result.valid, true, `${name}: ${result.errors.map(e => e.stack).join('; ')}`);
  }
});

test('capture covers publication kinds, null identities, screen causes, unavailable inputs and omissions', async () => {
  const fresh = await actual();
  assert.deepEqual([...new Set(fresh.map(row => row.body.kind))].sort(), ['changes', 'retired', 'snapshot', 'unavailable']);
  assert.equal(named('managed/cold').agents.some(row => row.lifetime === null && row.process.pid === null), true);
  assert.equal(named('managed/screen-rule').agents[0].stateCause, 'folder-trust');
  assert.equal(named('residents/identity-unknown').agents[0].process.verified, 'unknown');
  assert.equal(named('managed/working').agents[0].turn.ageMs, 0);
  assert.equal(Object.hasOwn(named('managed/future-turn-age').agents[0].turn, 'ageMs'), false);
  assert.equal(Object.hasOwn(named('managed/closed-turn').agents[0].turn, 'ageMs'), false);
  assert.deepEqual(named('managed/replacement').removed.map(row => row.lifetime), [named('managed/working').agents[0].lifetime]);
  assert.equal(named('managed/unavailable-stops').inputs.operatorStop, 'unavailable');
  assert.equal(Object.hasOwn(named('managed/unavailable-stops'), 'agents'), false);
  assert.deepEqual(named('managed/empty-snapshot').agents, []);
  assert.equal(Object.hasOwn(named('metadata/omitted-invalid-metadata'), 'build'), false);
  assert.equal(Object.hasOwn(named('metadata/omitted-invalid-metadata'), 'reportEveryMs'), false);
  // The current host does not emit an intermediate starting row. Preserve the real derivation's vocabulary anyway.
  const starting = deriveAgentState({ stoppedByOperator: false, definition: 'valid', mode: 'managed', process: 'starting',
    verified: 'no', startingInWindow: true, conflict: false, busy: false, awaitingInput: false, screen: null, backgroundShells: 0 });
  assert.equal(starting.state, 'starting');
  assert.ok(schema.definitions.state.enum.includes(starting.state));
});

const wrong = [
  ['incomplete snapshot', 'managed/cold', b => { b.complete = false; }],
  ['operator-attested retirement', 'managed/retired', b => { b.reason = 'operator-attested'; }],
  ['unknown envelope field', 'managed/cold', b => { b.debug = true; }],
  ['unknown publication kind', 'managed/cold', b => { b.kind = 'future-kind'; }],
  ['unsafe generation', 'managed/cold', b => { b.generation = Number.MAX_SAFE_INTEGER + 1; }],
  ['nonpositive publication', 'managed/cold', b => { b.publication = 0; }],
  ['non-string inputs', 'managed/cold', b => { b.inputs.extra = true; }],
  ['invalid build', 'managed/cold', b => { b.build = 'has spaces'; }],
  ['line-ending build', 'managed/cold', b => { b.build = 'fixture-build\n'; }],
  ['short report interval', 'managed/cold', b => { b.reportEveryMs = 999; }],
  ['retired report interval', 'managed/retired', b => { b.reportEveryMs = 60000; }],
  ['empty unavailable reason', 'managed/unavailable-stops', b => { b.reason = ''; }],
  ['missing changes removals', 'managed/working', b => { delete b.removed; }],
  ['null removal lifetime', 'managed/replacement', b => { b.removed[0].lifetime = null; }],
  ['unknown state', 'managed/working', b => { b.agents[0].state = 'future-state'; }],
  ['boolean verification', 'managed/working', b => { b.agents[0].process.verified = true; }],
  ['zero PID', 'managed/working', b => { b.agents[0].process.pid = 0; }],
  ['missing lifetime', 'managed/cold', b => { delete b.agents[0].lifetime; }],
  ['nonboolean busy', 'managed/working', b => { b.agents[0].busy = 'true'; }],
  ['negative turn age', 'managed/working', b => { b.agents[0].turn.ageMs = -1; }],
  ['missing busy proof', 'managed/working', b => { delete b.agents[0].turn.busyIf; }],
  ['invalid definition revision', 'managed/working', b => { b.agents[0].launch.definition.revision = 0; }],
  ['missing inputs', 'managed/cold', b => { delete b.inputs; }],
  ['empty agent identity', 'managed/cold', b => { b.agents[0].agentId = ''; }],
  ['unknown process state', 'managed/working', b => { b.agents[0].process.state = 'maybe'; }],
  ['unknown verification word', 'managed/working', b => { b.agents[0].process.verified = 'maybe'; }],
  ['unexpected row field', 'managed/cold', b => { b.agents[0].debug = true; }],
  ['unexpected turn field', 'managed/working', b => { b.agents[0].turn.debug = true; }],
  ['unsafe turn timestamp', 'managed/working', b => { b.agents[0].turn.startedAtUs = Number.MAX_SAFE_INTEGER + 1; }],
];
for (const [name, source, mutate] of wrong) {
  test(`schema refuses deliberately wrong body: ${name}`, () => {
    const body = named(source); mutate(body);
    const before = structuredClone(body), result = validate(body);
    assert.equal(result.valid, false, `${name} must be refused, not accepted as a valid publication`);
    assert.ok(result.errors.length > 0, 'a refusal must explain the invalid body');
    assert.deepEqual(body, before, 'validation must not repair or mutate the body');
  });
}

test('validator is an exact declared dev dependency, never a runtime dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const installed = createRequire(import.meta.url)('jsonschema/package.json');
  assert.equal(pkg.devDependencies.jsonschema, installed.version);
  assert.equal(pkg.dependencies?.jsonschema, undefined);
  assert.equal(pkg.optionalDependencies?.jsonschema, undefined);
});
