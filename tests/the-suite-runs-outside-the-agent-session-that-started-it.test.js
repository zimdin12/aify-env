// tests/run-in-a-temp-root.mjs hands the suite an environment without the Herdr, agent and lifetime of the
// terminal it was started from. Run from an agent's Herdr pane, tests held that pane's live socket and that
// agent's id (2026-10-03); run from a managed agent's pane, a single file held that agent's live lifetime
// (2026-10-28).
//
// THE RUNNER IS STARTED WITH THEM PLANTED, so this does not depend on the terminal it runs from: the first
// version read its own environment and was green for nothing from a plain terminal, which holds none of them.
// The planted names are mixed case because Windows reads `aify_lifetime` as the same variable.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LIFETIME_CARRIERS } from '../lib/managed-lifetimes.mjs';

const PLANTED = {
  HERDR_SOCKET_PATH: 'live-socket', AIFY_HERDR_PANE_FILE: 'live-pane', AIFY_AGENT_ID: 'live-agent',
  aify_agent_lease: 'live-lease', CLAUDE_CODE_CHILD_SESSION: '1',
  ...Object.fromEntries(LIFETIME_CARRIERS.map((name, i) => [i % 2 ? name.toLowerCase() : name, `live-${name}`])),
};

test('no test file sees a Herdr, an agent identity or a lifetime it did not set itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-env-'));
  const out = path.join(dir, 'names.txt');
  // Without NODE_TEST_CONTEXT: the outer run sets it, and a `node --test` that inherits it reports to this run
  // instead of running the file.
  const { NODE_TEST_CONTEXT, ...outer } = process.env;
  const run = spawnSync(process.execPath, ['tests/run-in-a-temp-root.mjs', 'tests/data/print-env-names.mjs'], {
    env: { ...outer, ...PLANTED, ENV_NAMES_OUT: out, RUNNER_KEEPS_THIS: 'kept' }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const seen = fs.readFileSync(out, 'utf8').split('\n').map((name) => name.toUpperCase());
  // The control: an ordinary name gets through, so an absence below is the runner's doing, not an empty read.
  assert.ok(seen.includes('RUNNER_KEEPS_THIS'));
  assert.deepEqual(Object.keys(PLANTED).filter((name) => seen.includes(name.toUpperCase())), []);
});
