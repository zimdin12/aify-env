// Owned native rig only: actual Runner + shutdown library, never the daemon entry or any fleet process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Runner } from '../../lib/runner.mjs';
import { PosixProcessGroup } from '../../lib/posix-process-group.mjs';
import { createShutdown } from '../../lib/shutdown.mjs';

assert.equal(process.platform, 'linux', 'NOT_RUN: this rig requires Linux/WSL');
const [mode, directory, effectMode] = process.argv.slice(2);
const recordOnly = effectMode === 'record-only'; // Negative probe control: no termination syscall, then voluntary private cleanup.
assert.ok(directory && path.isAbsolute(directory), 'explicit private fixture directory required');
fs.mkdirSync(directory, { recursive: true });
const done = path.join(directory, 'done'), pidsFile = path.join(directory, 'pids.json');
const workerFile = path.join(directory, 'worker.mjs'), grandchildFile = path.join(directory, 'grandchild.mjs'), launcher = path.join(directory, 'launcher.sh');
const grandchild = `import fs from 'node:fs';
const [done,mode]=process.argv.slice(2);
if(mode==='pipe-holder')process.on('SIGTERM',()=>{});else process.on('SIGTERM',()=>process.exit(0));
const watch=setInterval(()=>{if(fs.existsSync(done)){clearInterval(watch);process.exit(0);}},10);
setTimeout(()=>process.exit(91),12000);
`;
const worker = `import fs from 'node:fs';import {spawn} from 'node:child_process';
const [done,file,grand,mode]=process.argv.slice(2);
const child=spawn(process.execPath,[grand,done,mode],{stdio:['ignore','inherit','inherit'],detached:false});
child.once('spawn',()=>fs.writeFileSync(file,JSON.stringify({worker:process.pid,grandchild:child.pid})));
if(mode==='pipe-holder')process.on('SIGTERM',()=>{});else process.on('SIGTERM',()=>process.exit(0));
const watch=setInterval(()=>{if(fs.existsSync(done)){clearInterval(watch);process.exit(0);}},10);
setTimeout(()=>process.exit(91),12000);
`;
const shell = `#!/bin/bash
HARNESS_WRAPPER_VERSION="1"
set -eu
mode="$1"; worker="$2"; done_file="$3"; pids="$4"; grandchild="$5"
if [ "$mode" = parent-trap ]; then trap '' TERM; fi
/usr/bin/node "$worker" "$done_file" "$pids" "$grandchild" "$mode" &
child=$!
wait "$child" || true
if [ "$mode" = parent-trap ]; then
  while [ ! -f "$done_file" ] && [ "$SECONDS" -lt 12 ]; do read -r -t 0.05 ignored || true; done
fi
`;
for (const [file, body] of [[grandchildFile, grandchild], [workerFile, worker], [launcher, shell]]) fs.writeFileSync(file, body);
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputFiles = [grandchildFile, workerFile, launcher];
const before = Object.fromEntries(inputFiles.map(file => [path.basename(file), { present: true, sha256: digest(file), body: fs.readFileSync(file, 'utf8') }]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (probe, ms) => { const deadline = performance.now() + ms; do { if (probe()) return true; await pause(10); } while (performance.now() < deadline); return probe(); };
function stat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { pid, parent: Number(fields[1]), group: Number(fields[2]), state: fields[0] };
}
let group, validated = false, signalled = [];
const runner = new Runner({ openTerminal: null, loadCheckpoint: null, stopExitWaitMs: 800,
  makeProcessGroup: parts => {
    group = new PosixProcessGroup({ ...parts, signal: (target, name) => {
      assert.equal(target, -parts.child.pid, 'only the fresh fixture-owned group is ever addressed');
      if (name !== 0) { assert.ok(validated, 'owned PGID must be observed before any signal'); signalled.push(name); }
      if (name === 0 || !recordOnly) process.kill(target, name);
    } });
    return group;
  } });
let result;
try {
  const treeMode = mode.startsWith('shutdown-') ? 'pipe-holder' : mode;
  const handle = await runner.start({ service: 'native-fixture', command: '/bin/bash', args: [launcher, treeMode, workerFile, done, pidsFile, grandchildFile],
    cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: directory }, fileText: shell });
  assert.ok(await until(() => fs.existsSync(pidsFile), 3000), 'owned descendants reported their PIDs');
  const pids = { root: handle.pid, ...JSON.parse(fs.readFileSync(pidsFile, 'utf8')) };
  const root = stat(pids.root), child = stat(pids.worker), grand = stat(pids.grandchild), self = stat(process.pid);
  assert.equal(root.parent, process.pid); assert.equal(child.parent, root.pid); assert.equal(grand.parent, child.pid);
  for (const row of [root, child, grand]) assert.equal(row.group, root.pid);
  assert.notEqual(root.pid, self.group); validated = true;
  let answer, shutdown = null;
  if (mode.startsWith('shutdown-')) {
    const signal = mode.slice('shutdown-'.length); assert.ok(['SIGINT', 'SIGTERM'].includes(signal));
    let finish; const exited = new Promise(resolve => { finish = resolve; }); let cleared = false;
    const end = createShutdown({ runner, closeServer: () => {}, clearOwned: () => { cleared = true; }, exit: code => finish(code), write: () => {},
      beforeStopBudgetMs: 20, stopDeadlineMs: 2000, afterStopsDeadlineMs: 20 });
    process.once(signal, () => { void end(signal); });
    process.kill(process.pid, signal); // This rig signals itself, never another supervisor or daemon.
    const code = await exited;
    shutdown = { signal, code, cleared }; answer = { stopped: cleared && runner.list().length === 0 };
  } else answer = await runner.stop(handle.id, { requestId: 'native-stop' });
  const groupState = group.observe();
  const gone = Object.fromEntries(Object.entries(pids).map(([name, pid]) => {
    try { process.kill(pid, 0); return [name, false]; } catch (error) { return [name, error?.code === 'ESRCH']; }
  }));
  result = { mode, recordOnly, platform: process.platform, node: process.version, pids, observedGroups: [root, child, grand], answer, groupState, gone,
    remaining: runner.list().length, signalled, shutdown, inputs: { before, after: Object.fromEntries(inputFiles.map(file => [path.basename(file), { present: fs.existsSync(file), sha256: digest(file) }])) } };
} finally {
  // Voluntary self-cleanup only if an assertion failed. It cannot make the observations above pass.
  fs.writeFileSync(done, 'done');
  if (group) await until(() => group.observe() === 'gone', 2000);
}
assert.ok(result);
process.stdout.write(JSON.stringify(result) + '\n');
