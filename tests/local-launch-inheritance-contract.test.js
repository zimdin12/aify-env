import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { composeDefinedLaunch, LOCAL_START_NEVER_INHERITED } from '../lib/defined-launch.mjs';

const { AIFY_COMMS_REPO: comms, AIFY_WRAPPER_REPO: wrapper } = process.env;

test('local starts strip or replace every parent field comms and wrapper declare', {
  skip: (!comms || !wrapper) && 'requires explicit AIFY_COMMS_REPO and AIFY_WRAPPER_REPO checkouts',
}, async () => {
  const python = fs.readFileSync(path.join(comms, 'service/api_core/launch_env.py'), 'utf8');
  const tuple = /^NEVER_INHERITED\s*=\s*\(\s*\r?\n([\s\S]*?)^\)/m.exec(python);
  assert.ok(tuple, 'comms must declare a readable NEVER_INHERITED tuple');
  const entries = tuple[1].split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean);
  assert.ok(entries.length > 0, 'comms inheritance policy must not be empty');
  const commsNames = entries.map(line => {
    const match = /^"([A-Z][A-Z0-9_]*)",?$/.exec(line);
    assert.ok(match, `unreadable comms inheritance entry: ${line}`);
    return match[1];
  });
  const shell = fs.readFileSync(path.join(wrapper, 'bin/aify-inherited-session.sh'), 'utf8');
  const wrapperNames = ['AIFY_SESSION_MARKERS', 'AIFY_NEVER_INHERITED_BY_A_START', 'AIFY_NAMES_THE_SESSION'].flatMap(name => {
    const match = shell.split(/\r?\n/).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1);
    assert.match(match ?? '', /^"[A-Z0-9_]+(?: [A-Z0-9_]+)*"$/, `unreadable wrapper ${name}`);
    return match.slice(1, -1).split(' ');
  });

  // No definition variables, contributors or ambient env: only actual composer assignments
  // can satisfy a peer rule without putting the name in the core strip list.
  const agent = { id: 'fixture', harness: 'claude', role: 'worker', mode: 'managed', workspace: '/fixture', env: {} };
  const spec = await composeDefinedLaunch(agent, { agentId: 'fixture', storeId: 'store', expectedIncarnation: 1, expectedRevision: 1 }, {
    definitions: { boundReading: () => ({ agent }) }, checkCwd: () => {}, baseEnv: {}, platform: 'linux',
    resolve: () => ['/fixture/claude-aify'], readFile: () => '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1"\n',
  });
  const covered = new Set([...LOCAL_START_NEVER_INHERITED, ...Object.keys(spec.env)]);
  const missing = [...new Set([...commsNames, ...wrapperNames])].filter(name => !covered.has(name));
  assert.deepEqual(missing, [], 'local start leaves newly declared peer fields inherited');
});
