// An agent's hermes gateway keeps the port comms' bridge gave it when the host moved here (0.9.10), and two agents
// whose ids hash to one port still get two ports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePort, hashedPort, PORT_BASE, PORT_SPAN, RESERVED_PORTS } from '../lib/hermes-gateway-ports.mjs';

const always = async () => true;

test('THE SAME PORTS as comms: values its agentPort answered on 2026-10-26 (its rule left comms with this move)', () => {
  // general-helper-gpt hashes onto the comms service's 8800 and steps past the reserved 8801 and 8802.
  assert.equal(hashedPort('general-helper-gpt'), 8803);
  assert.equal(hashedPort('comms-senior-dev'), 9341);
  assert.equal(hashedPort('graph-hermes-tl'), 9341, 'the collision the probe exists for');
  assert.equal(hashedPort('pc-manager'), 8868);
  assert.equal(hashedPort('sc-coder-gpt'), 9545);
});

test('THE PREVIOUS PORT IS KEPT while it is free and no other agent holds it', async () => {
  assert.equal(await choosePort({ agentId: 'pc-manager', previous: 9000, isFree: always }), 9000);
  // The book ends the agent's own gateway first, so what still listens is something it declined to kill (review of 85cbd1a).
  assert.equal(await choosePort({ agentId: 'pc-manager', previous: 9000, isFree: async (p) => p !== 9000 }), 8868,
    'an occupied previous port is given up for the hashed one');
  assert.equal(await choosePort({ agentId: 'pc-manager', previous: 9000, others: [9000], isFree: always }), 8868,
    'a held previous port is given up for the hashed one');
  assert.equal(await choosePort({ agentId: 'pc-manager', previous: 80, isFree: always }), 8868, 'out of range is no port');
});

test('A COLLISION GETS THE NEXT PORT: held by another agent, or something already listening', async () => {
  assert.equal(await choosePort({ agentId: 'graph-hermes-tl', others: [9341], isFree: always }), 9342);
  const listening = new Set([9341, 9342]);
  assert.equal(await choosePort({ agentId: 'graph-hermes-tl', isFree: async (p) => !listening.has(p) }), 9343);
});

test('RESERVED PORTS are never chosen, and the search stays in range', async () => {
  for (const port of RESERVED_PORTS) assert.ok(port >= PORT_BASE && port < PORT_BASE + PORT_SPAN);
  const seen = [];
  const port = await choosePort({ agentId: 'general-helper-gpt', isFree: async (p) => { seen.push(p); return p > 8805; } });
  assert.equal(port, 8806);
  assert.ok(seen.every((p) => !RESERVED_PORTS.has(p)), `asked about a reserved port: ${seen}`);
});
