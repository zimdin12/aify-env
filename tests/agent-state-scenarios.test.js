// Contract data checks only, not a second receiver or a reducer of agent state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
const read = name => JSON.parse(fs.readFileSync(new URL(`../docs/agent-state/${name}`, import.meta.url)));
const data = read('scenarios.json'), bodies = read(data.publications), schema = read('schema.json');
const rules = () => {
  const doc = fs.readFileSync(new URL('../docs/agent-state-v1.md', import.meta.url), 'utf8');
  const block = /```receiver-policy\n([\s\S]*?)```/.exec(doc);
  assert.ok(block, 'the contract must state its receiver-policy value once'); return JSON.parse(block[1]);
};
test('ordered scenario references resolve to the sole real capture set and typed outcomes', () => {
  assert.equal(new Set(data.cases.map(c => c.id)).size, data.cases.length);
  assert.ok(data.cases.length >= 8 && data.cases.length <= 11);
  for (const [index, name] of Object.entries(data.bindings)) assert.equal(bodies[+index]?.name, name, `capture ${index}`);
  for (const scenario of data.cases) {
    assert.ok(scenario.steps.some(step => step.read), `${scenario.id}: no expected outcome`);
    for (const step of scenario.steps) {
      assert.ok(Number.isSafeInteger(step.atMs) && step.atMs >= 0);
      assert.equal(['accept', 'read', 'restore'].filter(key => Object.hasOwn(step, key)).length, 1);
      if (Object.hasOwn(step, 'accept')) assert.ok(Object.hasOwn(data.bindings, step.accept));
      if (step.read) {
        assert.ok(schema.definitions.state.enum.includes(step.expect.state));
        if (step.expect.definition) assert.ok(schema.definitions.agent.properties.definition.enum.includes(step.expect.definition));
      }
    }
  }
});
test('silence boundary scenarios use the contract multiple and that publisher own cadence', () => {
  const limit = rules().staleAfterIntervals * bodies[1].body.reportEveryMs;
  const readings = id => data.cases.find(c => c.id === id).steps.filter(step => step.read).map(step => step.atMs);
  assert.deepEqual(readings('silence-just-inside'), [limit - 1]);
  assert.deepEqual(readings('silence-at-and-outside'), [limit, limit + 1]);
});
test('live-conflict scenario uses genuinely captured competing keys, not a mutated duplicate body', () => {
  const left = bodies[1].body, right = bodies[27]?.body; assert.ok(right, 'a real peer publication is required');
  assert.equal(left.machineId, right.machineId); assert.notEqual(left.instance, right.instance);
  assert.ok(right.generation > left.generation, 'newer generation alone must not win across keys');
  const a = left.agents.find(r => r.agentId === 'alpha'), b = right.agents.find(r => r.agentId === 'alpha');
  assert.notEqual(a.lifetime, b.lifetime); assert.notEqual(a.state, b.state);
});
const row = (index, id) => bodies[index]?.body.agents?.find(r => r.agentId === id);
test('same-word disagreement uses real differing non-null lifetimes, not a state mismatch', () => {
  const scenario = data.cases.find(c => c.id === 'same-word-different-lifetimes'); assert.ok(scenario);
  const [a, b] = scenario.steps.filter(s => Object.hasOwn(s, 'accept')).slice(-2).map(s => row(s.accept, 'alpha'));
  assert.ok(a?.lifetime && b?.lifetime); assert.equal(a.state, b.state); assert.notEqual(a.lifetime, b.lifetime);
  assert.deepEqual(scenario.steps.filter(s => s.read).map(s => s.expect), [{ state: 'unknown', conflict: true }]);
});
test('null identity scenarios isolate null/null and null/non-null at the same word', () => {
  const scenario = data.cases.find(c => c.id === 'null-is-not-identity'); assert.ok(scenario);
  const accepts = scenario.steps.filter(s => Object.hasOwn(s, 'accept'));
  const [a, b, c] = accepts.map(s => row(s.accept, 'invalid')); assert.ok(a && b && c);
  assert.equal(a.lifetime, null); assert.equal(b.lifetime, null); assert.notEqual(c.lifetime, null);
  assert.equal(a.state, b.state); assert.equal(b.state, c.state);
  assert.deepEqual(scenario.steps.filter(s => s.read).map(s => s.expect), [{ state: 'unknown', conflict: true }, { state: 'unknown', conflict: true }]);
});
