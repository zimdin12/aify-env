// `gateway-orphans` (moved from aify-comms doctor in 0.9.10): a hermes gateway in the agent port range that no
// recorded lifetime holds is named; one a record holds, directly or as its launcher's child, is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatewayOrphans, gatewayOrphansCheck, gatewayPort } from '../lib/gateway-orphans-check.mjs';
import { collectHostChecks } from '../lib/host-checks.mjs';
import { PORT_BASE, PORT_SPAN } from '../lib/hermes-gateway-ports.mjs';

const gw = (pid, port, ppid = 1) => ({ pid, ppid, commandLine: `C:/py/hermes.exe dashboard --port ${port} --host 127.0.0.1 --no-open --skip-build` });
const record = (pid, port = 9341) => ({ agentId: `a${pid}`, record: { pid, port, lifetime: 'L' } });

test('A GATEWAY is `hermes dashboard --port P` with P in the agent range, and nothing else is', () => {
  assert.equal(gatewayPort(gw(1, 9341).commandLine), 9341);
  assert.equal(gatewayPort('hermes dashboard --port=8642'), PORT_BASE, 'the = form and the first port in range');
  assert.equal(gatewayPort(`hermes dashboard --port ${PORT_BASE + PORT_SPAN}`), null, 'one past the range');
  assert.equal(gatewayPort('hermes dashboard --port 9119'), 9119, 'CONTROL: inside the range');
  assert.equal(gatewayPort('hermes dashboard --port 8000'), null, "an operator's own dashboard below the range");
  assert.equal(gatewayPort('node hermes-managed-host.js run pc-manager --port 9341'), null, 'no dashboard');
  assert.equal(gatewayPort('python -m http.server dashboard --port 9341'), null, 'no hermes');
});

test('ORPHANS: unrecorded gateways only; a recorded pid and its launcher child are spoken for', () => {
  const processes = [
    gw(100, 9341), // recorded itself
    { pid: 200, ppid: 1, commandLine: 'C:/py/hermes.exe dashboard --port 8868' }, gw(201, 8868, 200), // a launcher and the child serving
    gw(300, 9545), // nobody's
    gw(400, 8803), // a record prepared it (pid 0) and nothing registered
    { pid: 500, ppid: 1, commandLine: 'node server.js' },
  ];
  const orphans = gatewayOrphans({ processes, records: [record(100), record(200, 8868), record(0, 8803)] });
  assert.deepEqual(orphans, [{ pid: 300, port: 9545 }, { pid: 400, port: 8803 }]);
  assert.deepEqual(gatewayOrphans({ processes, records: [] }).map(({ pid }) => pid), [100, 200, 201, 300, 400],
    'CONTROL: with no records every gateway is an orphan');
});

test('THE ROW: unanswered when the process table cannot be read, passed when clean, failed naming each orphan', () => {
  const unread = gatewayOrphansCheck({ listProcesses: () => { throw new Error('ps failed'); }, records: () => [] });
  assert.equal(unread.state, 'unanswered');
  assert.match(unread.detail, /ps failed/);
  assert.equal(gatewayOrphansCheck({ listProcesses: () => [gw(1, 9341)], records: () => [record(1)] }).state, 'passed');
  const row = gatewayOrphansCheck({ listProcesses: () => [gw(7, 9545)], records: () => [] });
  assert.equal(row.state, 'failed');
  assert.match(row.detail, /pid 7 on port 9545/);
  assert.ok(row.fix);
});

test('THE DOCTOR asks it: collectHostChecks answers a gateway-orphans row from its own process listing', async () => {
  const rows = await collectHostChecks({ services: [], listProcesses: () => [gw(9, 9545)], gatewayRecords: () => [],
    claudeLogin: () => ({ id: 'claude-login', state: 'passed', detail: '' }) });
  const row = rows.find(({ id }) => id === 'gateway-orphans');
  assert.ok(row, rows.map(({ id }) => id).join(','));
  assert.match(row.detail, /pid 9 on port 9545/);
});
