// Native effect-adapter qualification on this rig's actual Runner-owned group, never a daemon or unrelated PID.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Runner } from '../../lib/runner.mjs';
import { OwnedProcessRecord } from '../../lib/owned-process-record.mjs';
import { ProcessIdentityProbe } from '../../lib/process-identity.mjs';
import { observedBirth } from '../../lib/process-birth.mjs';
import { RecoveredProcessTermination } from '../../lib/recovered-process-termination.mjs';
import { PosixProcessGroup } from '../../lib/posix-process-group.mjs';
assert.equal(process.platform, 'linux');
const [mode, directory, effectMode] = process.argv.slice(2), recordOnly = effectMode === 'record-only';
assert.ok(['live', 'root-dead'].includes(mode) && path.isAbsolute(directory));
fs.mkdirSync(directory, { recursive: true });
const done = path.join(directory, 'done'), pidsFile = path.join(directory, 'pids.json');
const rootFile = path.join(directory, 'root.cjs'), workerFile = path.join(directory, 'worker.cjs'), grandFile = path.join(directory, 'grand.cjs');
const watcher = `process.on('SIGTERM',()=>{});setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)}))process.exit(0)},10);setTimeout(()=>process.exit(91),12000);`;
fs.writeFileSync(grandFile, `const fs=require('node:fs');${watcher}\n`);
fs.writeFileSync(workerFile, `const fs=require('node:fs'),{spawn}=require('node:child_process');${watcher}
const child=spawn(process.execPath,[${JSON.stringify(grandFile)}],{stdio:['ignore','inherit','inherit'],detached:false});
child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({worker:process.pid,grandchild:child.pid})));
`);
const rootBody = `#!/usr/bin/env node
HARNESS_WRAPPER_VERSION="1"
const fs=require('node:fs'),{spawn}=require('node:child_process');${watcher}
spawn(process.execPath,[${JSON.stringify(workerFile)}],{stdio:['ignore','inherit','inherit'],detached:false});
`;
fs.writeFileSync(rootFile, rootBody);
const files = [rootFile, workerFile, grandFile];
const inputs = () => Object.fromEntries(files.map(file => [path.basename(file), { present: fs.existsSync(file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), body: fs.readFileSync(file, 'utf8') }]));
const before = inputs(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout) { const end = performance.now() + timeout; do { if (check()) return true; await pause(10); } while (performance.now() < end); return check(); }
function stat(pid) { const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/); return { pid, parent: Number(fields[1]), group: Number(fields[2]) }; }
const identity = new ProcessIdentityProbe(), selfBirth = observedBirth(process.pid, (await identity.probe([process.pid])).get(process.pid));
const record = new OwnedProcessRecord(path.join(directory, 'owned.json'), { ownerIdentity: selfBirth });
let root, rootExit, liveGroup, validated = false;
const signals = [];
const runner = new Runner({ ownedRecord: record, openTerminal: null, loadCheckpoint: null,
  spawnProcess: (...args) => { root = spawn(...args); rootExit = new Promise(resolve => root.once('exit', resolve)); return root; },
  makeProcessGroup: parts => { liveGroup = new PosixProcessGroup({ ...parts, signal: (pid, signal) => {
    assert.equal(pid, -parts.child.pid); assert.equal(signal, 0, 'origin Runner is never asked to terminate this recovered fixture');
    return process.kill(pid, 0);
  } }); return liveGroup; } });
let result;
try {
  const handle = await runner.start({ service: 'native-recovery-fixture', command: process.execPath, args: [rootFile], launcher: rootFile,
    cwd: directory, env: { HOME: directory, PATH: '/usr/bin:/bin' }, fileText: rootBody });
  assert.ok(await until(() => { try { JSON.parse(fs.readFileSync(pidsFile, 'utf8')); return true; } catch { return false; } }, 3000));
  const pids = { root: handle.pid, ...JSON.parse(fs.readFileSync(pidsFile, 'utf8')) };
  const roots = [stat(pids.root), stat(pids.worker), stat(pids.grandchild)];
  assert.equal(roots[0].parent, process.pid); assert.equal(roots[1].parent, pids.root); assert.equal(roots[2].parent, pids.worker);
  for (const row of roots) assert.equal(row.group, pids.root);
  assert.notEqual(stat(process.pid).group, pids.root); validated = true;
  const entry = record.load().entries[0];
  assert.equal(entry.pid, pids.root); assert.deepEqual(entry.groupScope, { kind: 'posix-process-group', pgid: pids.root });
  assert.deepEqual(entry.startToken, (await identity.probe([pids.root])).get(pids.root).startToken);
  if (mode === 'root-dead') { root.kill('SIGKILL'); await rootExit; } // Actual ChildProcess spawned by THIS rig, no numeric lookup.
  const termination = new RecoveredProcessTermination({ identity, timeoutMs: 800, signal: (pid, signal) => {
    assert.equal(pid, -pids.root); assert.ok(validated);
    signals.push(signal);
    // Negative probe control: a denied observation must not masquerade as the known-present group.
    if (recordOnly && mode === 'root-dead' && signal === 0) throw Object.assign(Error('probe control denied'), { code: 'EPERM' });
    if (signal === 0 || !recordOnly) return process.kill(pid, signal);
  } });
  const answer = await termination.child(entry);
  const groupState = termination.groupState(entry);
  if (answer.state === 'gone' && answer.scope === 'recorded-posix-group') record.retire([entry]);
  const retained = record.load().entries.some(row => row.id === entry.id);
  result = { mode, platform: process.platform, node: process.version, recordOnly, pids, observedGroups: roots,
    answer, groupState, retained, signals, record: entry, rootIdentity: entry.startToken, ownerIdentity: entry.ownerIdentity,
    inputs: { before, after: inputs() } };
} finally {
  // Private voluntary cleanup, including record-only controls. No numeric kill after an observed exit.
  fs.writeFileSync(done, 'done');
  if (liveGroup) assert.ok(await until(() => liveGroup.observe() === 'gone', 3000), 'private DONE cleanup did not confirm own group absence');
}
assert.ok(result);
process.stdout.write(JSON.stringify(result) + '\n');
