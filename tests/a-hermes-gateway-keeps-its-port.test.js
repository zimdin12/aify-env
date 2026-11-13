// An agent's hermes gateway keeps the port comms' bridge gave it when the host moved here (0.9.10), and two agents
// whose ids hash to one port still get two ports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePort, hashedPort, NO_FREE_PORT, PORT_BASE, PORT_SPAN, RESERVED_PORTS } from '../lib/hermes-gateway-ports.mjs';

const always = async () => true;

test('the inherited comms hash keeps the measured offsets and collision using neutral fixture ids', () => {
  // agent-999999991622 hashes onto the comms service's 8800 and steps past the reserved 8801 and 8802.
  assert.equal(hashedPort('agent-999999991622'), 8803);
  assert.equal(hashedPort('agent-0000000389'), 9341);
  assert.equal(hashedPort('agent-000002882'), 9341, 'the collision the probe exists for');
  assert.equal(hashedPort('agent-2120'), 8868);
  assert.equal(hashedPort('agent-bd-gpt'), 9545);
});

test('THE PREVIOUS PORT IS KEPT while it is free and no other agent holds it', async () => {
  assert.equal(await choosePort({ agentId: 'agent-2120', previous: 9000, isFree: always }), 9000);
  // The book ends the agent's own gateway first, so what still listens is something it declined to kill (review of 85cbd1a).
  assert.equal(await choosePort({ agentId: 'agent-2120', previous: 9000, isFree: async (p) => p !== 9000 }), 8868,
    'an occupied previous port is given up for the hashed one');
  assert.equal(await choosePort({ agentId: 'agent-2120', previous: 9000, others: [9000], isFree: always }), 8868,
    'a held previous port is given up for the hashed one');
  assert.equal(await choosePort({ agentId: 'agent-2120', previous: 80, isFree: always }), 8868, 'out of range is no port');
});

test('A COLLISION GETS THE NEXT PORT: held by another agent, or something already listening', async () => {
  assert.equal(await choosePort({ agentId: 'agent-000002882', others: [9341], isFree: always }), 9342);
  const listening = new Set([9341, 9342]);
  assert.equal(await choosePort({ agentId: 'agent-000002882', isFree: async (p) => !listening.has(p) }), 9343);
});

test('RESERVED PORTS are never chosen, and the search stays in range', async () => {
  for (const port of RESERVED_PORTS) assert.ok(port >= PORT_BASE && port < PORT_BASE + PORT_SPAN);
  const seen = [];
  const port = await choosePort({ agentId: 'agent-999999991622', isFree: async (p) => { seen.push(p); return p > 8805; } });
  assert.equal(port, 8806);
  assert.ok(seen.every((p) => !RESERVED_PORTS.has(p)), `asked about a reserved port: ${seen}`);
});

test('NO FREE PORT IN THE SEARCH IS A REFUSAL, never the busy start port', async () => {
  // It returned the hashed port after 64 busy answers, the occupied previous port among them (review of e7e0956).
  await assert.rejects(choosePort({ agentId: 'agent-2120', previous: 8868, isFree: async () => false }), { code: NO_FREE_PORT });
  assert.equal(await choosePort({ agentId: 'agent-2120', isFree: async (p) => p === 8868 + 63 }), 8868 + 63, 'CONTROL: the last port searched');
});
