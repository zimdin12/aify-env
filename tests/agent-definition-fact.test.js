import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Validator } from 'jsonschema';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { knownDefinition } from '../lib/agent-state.mjs';
import { captureAgentStatePublications } from './fixtures/agent-state-publications.mjs';

function quiet(t, definition) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'definition-fact-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = new AgentStateHost({ aifyHome: home, instance: 'fixture', nowUs: () => 1000000,
    probe: () => { throw Error('no OS probe permitted'); } });
  return host.current('fixture', { definition, mode: 'managed', stoppedByOperator: false });
}
for (const fact of ['valid', 'invalid', 'unavailable', 'none']) {
  test(`quiet agent publishes known definition ${fact} independently of launch reference`, t => {
    const row = quiet(t, fact);
    assert.equal(row.definition, fact);
    assert.equal(knownDefinition(fact), fact);
    assert.equal(row.launch.definition, null);
  });
}
test('unknown definition inputs remain absent, never implicit none or null', t => {
  for (const fact of [undefined, null, '', 'unknown', 'VALID', true, 1, {}, []]) {
    const row = quiet(t, fact);
    assert.equal(knownDefinition(fact), undefined);
    assert.equal(Object.hasOwn(row, 'definition'), false);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(row)), 'definition'), false);
  }
});
test('actual sender carries definition facts for quiet, stopped, bad and undefined agents', async () => {
  const rows = await captureAgentStatePublications();
  const agent = (name, id) => rows.find(row => row.name === name).body.agents.find(row => row.agentId === id);
  assert.deepEqual([agent('managed/cold', 'alpha').definition, agent('managed/cold', 'quiet').definition,
    agent('managed/outside-roots', 'beta').definition, agent('managed/cold', 'invalid').definition,
    agent('residents/identity-unknown', 'resident').definition], ['valid', 'valid', 'unavailable', 'invalid', 'none']);
  assert.equal(Object.hasOwn(agent('managed/definition-unknown', 'alpha'), 'definition'), false);
  assert.notEqual(agent('managed/definition-unknown', 'alpha').launch.definition, null);
});
test('schema accepts the optional four-string fact, rejects present null and keeps legacy absence', async () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/agent-state/schema.json', import.meta.url)));
  const body = structuredClone((await captureAgentStatePublications())[0].body), v = new Validator();
  body.agents[0].definition = 'valid'; assert.equal(v.validate(body, schema).valid, true);
  for (const invalid of [null, '', 'unknown', true, 1]) {
    body.agents[0].definition = invalid;
    assert.equal(v.validate(body, schema).valid, false, `invalid definition ${JSON.stringify(invalid)}`);
  }
  delete body.agents[0].definition; assert.equal(v.validate(body, schema).valid, true);
});
