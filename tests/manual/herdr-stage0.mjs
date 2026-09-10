// Opt-in real Windows Stage 0. Usage: node tests/manual/herdr-stage0.mjs <herdr.exe>
// Starts only UUID-scoped homes, sockets, a loopback ephemeral daemon and owned PTYs.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const pty = createRequire(import.meta.url)('node-pty');
let ui, uiExited = false, uiOutput = '';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
const repo = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'win32', 'This probe is Windows-only');
assert.ok(process.argv[2], 'Pass the absolute path to a complete Herdr 0.9.0 installation');
const binary = path.resolve(process.argv[2]);
const supervised = process.argv[3] === '--owned-job';
const root = supervised ? process.argv[5] : path.join(repo, '.local/herdr-stage0', 'run-' + randomUUID());
fs.mkdirSync(root, { recursive: true });
const powershell = path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const supervisor = path.join(repo, 'tests/manual/herdr-owned-processes.ps1');
if (!supervised) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN)$/i.test(k)));
  Object.assign(clean, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root });
  const result = spawnSync(powershell, ['-NoProfile', '-File', supervisor, '-Node', process.execPath, '-Fixture', process.argv[1], '-Binary', binary, '-Root', root], { cwd: repo, env: clean, encoding: 'utf8', timeout: 210000 });
  fs.writeFileSync(path.join(root, 'supervisor-output.txt'), (result.stdout || '') + (result.stderr || '') + (result.error?.stack || ''));
  console.log(JSON.stringify({ root, status: result.status, error: result.error?.message }));
  if (result.status !== 0) process.exit(result.status ?? 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'));
  const job = JSON.parse(fs.readFileSync(path.join(root, 'job-receipt.json'), 'utf8'));
  assert.equal(receipt.failure, undefined); assert.equal(job.assignedBeforeResume, true);
  assert.equal(job.activeProcessesAfterTerminate, 0); assert.equal(job.exitCode, 0);
  const gone = address => new Promise(resolve => {
    const s = net.connect({ path: address }); const timer = setTimeout(() => { s.destroy(); resolve(false); }, 2000);
    s.once('error', () => { clearTimeout(timer); s.destroy(); resolve(true); });
    s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve(false); });
  });
  const pipe = '\\\\.\\pipe\\' + receipt.socket;
  const cleanup = { job, pipeGone: await gone(pipe), clientPipeGone: await gone(pipe.replace(/\.sock$/, '-client.sock')) };
  fs.writeFileSync(path.join(root, 'cleanup-receipt.json'), JSON.stringify(cleanup, null, 2));
  assert.equal(cleanup.pipeGone, true); assert.equal(cleanup.clientPipeGone, true);
  process.exit(0);
}
// The checking child must belong to the named job too. A forged argument alone cannot launch Herdr.
const membership = spawnSync(powershell, ['-NoProfile', '-File', supervisor, '-CheckJob', process.argv[4]], { encoding: 'utf8', timeout: 10000 });
assert.equal(membership.status, 0, membership.stderr);
const socket = 'aify-env-stage0-' + randomUUID() + '.sock';
const pipe = '\\\\.\\pipe\\' + socket;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN)$/i.test(k)));
Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
  HERDR_CONFIG_PATH: path.join(root, 'config.toml'), HERDR_SOCKET_PATH: socket, HERDR_CLIENT_SOCKET_PATH: socket + '.client',
  AIFY_ADVERTISE: '0', AIFY_NO_DASHBOARD: '1', AIFY_SERVICE_REGISTRY: path.join(root, 'no-registry.json'),
  AIFY_ENV_PROCESS_RECORD: path.join(root, 'owned.json') });
fs.writeFileSync(env.HERDR_CONFIG_PATH, 'onboarding = false\n[terminal]\ndefault_shell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"\n[update]\nversion_check = false\nmanifest_check = false\n[server]\nheadless_cols = 132\nheadless_rows = 26\n');
const receipts = [], checks = {}, children = [];
let client, worker, base, failure;
function own(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const item = { child, command, args, output: '' }; children.push(item);
  child.stdout.on('data', b => item.output += b);
  child.stderr.on('data', b => item.output += b);
  child.on('error', e => item.output += String(e));
  return item;
}
async function until(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error('timeout: ' + label);
}
async function connect() {
  await until(async () => {
    try { await call('ping'); return true; } catch { return false; }
  }, 'owned pipe ready');
}
// Upstream closes ordinary RPC connections; subscriptions use a separate stream.
async function call(method, params = {}) {
  const id = randomUUID();
  const value = await new Promise((resolve, reject) => {
    client = net.connect({ path: pipe });
    const s = client; let text = '';
    const finish = (error, value) => { clearTimeout(timer); s.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('timeout: ' + method)), 5000);
    s.on('error', e => finish(e));
    s.on('connect', () => s.write(JSON.stringify({ id, method, params }) + '\n'));
    s.on('data', b => {
      text += b; const n = text.indexOf('\n'); if (n < 0) return;
      try { const r = JSON.parse(text.slice(0,n)); if (!r.error) assert.equal(r.id, id); finish(null, r); }
      catch (e) { finish(e); }
    });
  });
  receipts.push({ method, params, response: value });
  return value;
}
async function ok(method, params = {}) {
  const r = await call(method, params); assert.ok(!r.error, JSON.stringify(r)); return r.result;
}
async function http(route, method = 'GET', body) {
  const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = response.status === 204 ? null : await response.json(); receipts.push({ http: route, method, status: response.status, result });
  assert.ok(response.ok, JSON.stringify(result)); return result;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
try {
  const schemaRun = spawnSync(binary, ['api', 'schema', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(schemaRun.status, 0, schemaRun.stderr);
  const schema = JSON.parse(schemaRun.stdout); checks.schema_version = schema.schema_version;
  fs.writeFileSync(path.join(root, 'schema.json'), schemaRun.stdout);
  own(binary, ['server']); await connect();
  checks.pong = await ok('ping');
  assert.equal(checks.pong.version, '0.9.0'); assert.equal(checks.schema_version, 1);
  checks.initialPanes = await ok('pane.list');
  checks.unopenedWorkerReport = await call('pane.report_agent', { pane_id: 'not-an-existing-pane', source: 'aify-env-stage0', agent: 'hermes', state: 'idle' });
  assert.ok(checks.unopenedWorkerReport.error);
  checks.lockCommand = await call('pane.lock', { pane_id: 'not-an-existing-pane' });
  assert.ok(checks.lockCommand.error);
  const daemon = own(process.execPath, [path.join(repo, 'bin/aify-env.mjs'), '--port', '0']);
  base = await until(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(daemon.output)?.[1], 'daemon port');
  const health = await http('/health'); assert.equal(health.processes.length, 0);
  const workerFile = path.join(root, 'worker.mjs');
  fs.writeFileSync(workerFile, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(root, 'worker-pid.json'))}, JSON.stringify({pid:process.pid}));\nprocess.stdin.setRawMode(true);process.stdin.resume();\nconst size=()=>console.log('WORKER-SIZE:'+process.stdout.columns+'x'+process.stdout.rows);\nconsole.log('WORKER-READY');size();\nprocess.stdout.on('resize',size);\nprocess.stdin.on('data',b=>{const s=b.toString();console.log('WORKER-INPUT:'+s.trim());size();if(s.includes('quit-owned'))process.exit(0);});\n`);
  const launcher = path.join(root, 'stage0-aify');
  fs.writeFileSync(launcher, '#!/bin/bash\nHARNESS_WRAPPER_VERSION="0.6.0"\nexec "' + process.execPath.replaceAll('\\', '/') + '" "' + workerFile.replaceAll('\\', '/') + '"\n');
  worker = await http('/processes', 'POST', { service: 'stage0-test', launcher, args: [], cwd: root, env, label: 'owned-stage0-worker' });
  checks.worker = worker;
  assert.ok(worker.id); assert.equal(worker.terminal, true);
  await until(() => fs.existsSync(path.join(root, 'worker-pid.json')), 'worker readiness');
  checks.workerPid = JSON.parse(fs.readFileSync(path.join(root, 'worker-pid.json'), 'utf8')).pid;
  // Exercise the shipped dispatcher, not a hand-written attach command.
  env.AIFY_ENV_ENDPOINT = base;
  env.PATH = path.dirname(binary) + ';' + (env.PATH || env.Path || '');
  const opened = own(process.execPath, [path.join(repo, 'bin/aify-env.mjs'), 'herdr', worker.id]);
  await until(() => opened.child.exitCode !== null, 'integration command');
  assert.equal(opened.child.exitCode, 0, opened.output);
  checks.commandOutput = opened.output;
  const workspace = JSON.parse(opened.output.split('\n').find(line => line.startsWith('{')));
  checks.workspace = workspace;
  const panes = await ok('pane.list'); checks.panesAfterCreate = panes;
  const pane = panes.panes.find(p => p.pane_id === workspace.pane_id);
  assert.ok(pane, JSON.stringify({ workspace, panes })); checks.attachPane = pane;
  let pane_id = pane.pane_id;
  await pause(1000);
  checks.shellBeforeAttach = await ok('pane.read', { pane_id, source: 'recent_unwrapped', lines: 100, format: 'text', strip_ansi: true });
  ui = pty.spawn(binary, [], { cwd: root, env, cols: 150, rows: 44, name: 'xterm-256color' });
  ui.onData(b => { uiOutput = (uiOutput + b).slice(-200000); });
  ui.onExit(() => { uiExited = true; });
  await pause(1500);
  // The integration already submitted attach through the real Herdr API.
  const read = async () => (await ok('pane.read', { pane_id, source: 'recent_unwrapped', lines: 100, format: 'text', strip_ansi: true })).read.text;
  checks.attachedOutput = await until(async () => { const text = await read(); return text?.includes('WORKER-READY') && text; }, 'readable worker output');
  await ok('pane.send_text', { pane_id, text: 'stage0-input-proof' });
  checks.inputOutput = await until(async () => { const text = await read(); return text?.includes('WORKER-INPUT:stage0-input-proof') && text; }, 'input forwarded');
  checks.beforeResize = await ok('pane.get', { pane_id });
  const sizes = text => [...text.matchAll(/WORKER-SIZE:(\d+x\d+)/g)].map(m => m[1]);
  checks.sizeBefore = sizes(checks.inputOutput).at(-1);
  assert.ok(checks.sizeBefore); assert.notEqual(checks.sizeBefore, '120x30');
  ui.resize(110, 32);
  checks.resizeOutput = await until(async () => { const text = await read(); return sizes(text).at(-1) && sizes(text).at(-1) !== checks.sizeBefore && text; }, 'worker observes TUI resize');
  checks.sizeAfter = sizes(checks.resizeOutput).at(-1);
  assert.ok(checks.sizeAfter); assert.notEqual(checks.sizeAfter, checks.sizeBefore);
  checks.afterResize = await ok('pane.get', { pane_id });
  checks.attachedProcesses = (await ok('pane.process_info', { pane_id })).process_info;
  const shellPid = checks.attachedProcesses.shell_pid;
  assert.ok(Number.isInteger(shellPid) && shellPid > 0);
  const treeScript = `$all = @(Get-CimInstance Win32_Process); $ids = @(${shellPid}); do { $next = @($all | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $ids += $next } while ($next.Count); ConvertTo-Json -Compress -InputObject @($ids)`;
  const tree = spawnSync(path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-EncodedCommand', Buffer.from(treeScript, 'utf16le').toString('base64')], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(tree.status, 0, tree.stderr);
  const attachedPids = JSON.parse(tree.stdout);
  assert.ok(attachedPids.length >= 3, 'must observe shell, nested PowerShell and attach Node');
  checks.attachedPids = attachedPids;
  await ok('pane.close', { pane_id });
  await until(() => attachedPids.every(pid => !alive(pid)), 'pane clients exit on close');
  checks.paneClientsGone = true;
  checks.livePaneClosed = !(await ok('pane.list')).panes.some(p => p.pane_id === pane_id);
  assert.equal(checks.livePaneClosed, true);
  await pause(500);
  checks.workerSurvivedClose = (await http('/processes')).processes.some(p => p.id === worker.id) && alive(checks.workerPid);
  assert.equal(checks.workerSurvivedClose, true);
  const reopened = own(process.execPath, [path.join(repo, 'bin/aify-env.mjs'), 'herdr', worker.id]);
  await until(() => reopened.child.exitCode !== null, 'reattach command');
  assert.equal(reopened.child.exitCode, 0, reopened.output);
  pane_id = JSON.parse(reopened.output.split('\n').find(line => line.startsWith('{'))).pane_id;
  await until(async () => (await read()).includes('WORKER-READY'), 'reattached output');
  await ok('pane.send_text', { pane_id, text: 'after-close-proof' });
  checks.reattachOutput = await until(async () => { const text = await read(); return text.includes('WORKER-INPUT:after-close-proof') && text; }, 'reattached input');
  await ok('pane.send_text', { pane_id, text: 'quit-owned' });
  checks.exitOutput = await until(async () => { const text = await read(); return text?.includes('exited with code 0') && text; }, 'attach observes worker exit');
  await until(async () => !(await http('/processes')).processes.some(p => p.id === worker.id), 'worker removed');
  checks.panesAfterWorkerExit = await ok('pane.list');
  await ok('pane.close', { pane_id });
  checks.panesAfterClose = await ok('pane.list');
  assert.ok(!checks.panesAfterClose.panes.some(p => p.pane_id === pane_id));
  checks.workerGone = !alive(checks.workerPid); assert.equal(checks.workerGone, true);
} catch (e) { failure = e.stack; console.error(failure); }
finally {
  if (worker && base) { try { const list = await http('/processes'); if (list.processes.some(p => p.id === worker.id)) await http('/processes/' + worker.id, 'DELETE'); } catch (e) { receipts.push({ cleanupError: String(e) }); } }
  if (client) { try { await ok('server.stop'); } catch (e) { receipts.push({ stopError: String(e) }); } client.destroy(); }
  // Lifecycle assertions above happen before this root exits and before job termination.
  // Do not derive kill authority from PID observations. The supervisor owns every descendant.
  if (ui) fs.writeFileSync(path.join(root, 'tui-output.txt'), uiOutput);
  checks.beforeJobCleanup = children.map(({ child, command }) => ({ command, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({ binary, socket, root, failure, checks, receipts, children: children.map(({ child, ...item }) => ({ ...item, pid: child.pid })) }, null, 2));
  console.log(JSON.stringify({ root, failure, checks }, null, 2));
  process.exit(failure ? 1 : 0);
}
