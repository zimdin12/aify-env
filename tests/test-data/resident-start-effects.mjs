// Owned composition effects. Real lease state and parser; OS probes and watch spawning are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, ...args] = process.argv.slice(2);
const root = process.env.START_PROOF_HOME;
assert.ok(root && process.env.START_PROOF_TOKEN, 'explicit owned fixture required');
assert.equal(fs.readFileSync(path.join(root, 'owner'), 'utf8'), process.env.START_PROOF_TOKEN);
assert.equal(process.env.AIFY_LEASE_RESIDENT_START, undefined, 'permission is not an exported capability');
const log = value => fs.appendFileSync(path.join(root, 'effects.jsonl'), JSON.stringify(value) + '\n');

if (mode === 'claim') {
  const wrapper = process.env.AIFY_WRAPPER_REPO;
  const [{ runLease }, { AgentLease }] = await Promise.all([
    import(pathToFileURL(path.join(wrapper, 'bin/aify-agent-lease.mjs')).href),
    import(pathToFileURL(path.join(wrapper, 'lib/agent-lease.mjs')).href),
  ]);
  assert.equal(path.resolve(args[0]), path.resolve(wrapper, 'bin/aify-agent-lease.mjs'));
  const pid = Number(process.env.START_PROOF_PID);
  const at = Date.now() - 1000;
  const probe = { isAlive: id => id === pid,
    startTimes: ids => new Map(ids.filter(id => id === pid).map(id => [id, at])),
    processTable: () => new Map([[pid, { pid, ppid: 0, startedAtMs: at }]]),
    killTree() { throw Error('fixture forbids process kill'); } };
  log({ event: 'claim', args: args.slice(1) });
  process.exitCode = runLease(args.slice(1), { env: process.env,
    lease: options => new AgentLease({ ...options, directory: path.join(root, 'private-lease'), probe }),
    watch: () => log({ event: 'watch-not-spawned' }),
  });
} else if (mode === 'before-capture') {
  assert.deepEqual(args, ['agents', 'resident-start-binding', 'fixture', 'claude', 'SessionStart']);
  const records = path.join(root, '.aify/residents');
  assert.deepEqual(fs.existsSync(records) ? fs.readdirSync(records) : [], [], 'capture must precede the process record');
  log({ event: 'before-capture', args });
} else if (mode === 'after-capture') {
  const url = process.env.START_PROOF_CONTROL;
  assert.match(url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/fixture\/after-capture$/);
  const result = await fetch(url, { method: 'POST', body: '{}', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(5000) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).applied, true);
} else if (mode === 'snapshot') {
  const directory = path.join(root, '.aify/residents');
  const records = fs.existsSync(directory) ? fs.readdirSync(directory).map(name =>
    JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [];
  process.stdout.write(JSON.stringify({ records, settings: JSON.parse(fs.readFileSync(args[0], 'utf8')),
    env: Object.fromEntries(['AIFY_AGENT_ID', 'AIFY_LIFETIME', 'AIFY_ENV_INSTANCE'].map(name => [name, process.env[name]])) }));
} else if (mode === 'failed-invocation') {
  process.exitCode = 127; // A fixture process, never an agent runtime.
} else throw Error(`unknown proof mode ${mode}`);
