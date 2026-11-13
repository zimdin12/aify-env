// Out-of-process because node-pty's Windows owner can retain a PipeWrap after the target exits.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { CredentialInstallFixture, ROOT } from '../fixtures/install-credentials.mjs';

if (process.platform !== 'win32') throw Error('native Windows prerequisite required');
const answer = process.argv[2];
if (!['y', 'n'].includes(answer)) throw Error('fixture answer required');
const after = [];
const f = await CredentialInstallFixture.create({ after: fn => after.push(fn) }, { required: false });
f.spec.name = 'fixture-service';
const marker = path.join(f.home, 'prepared.json'), reads = path.join(f.home, 'reads.json');
const prepare = path.join(f.home, 'policy-only.mjs');
fs.writeFileSync(prepare, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME}));`);
const action = { file: process.execPath, args: [prepare, 'prepare-policy'], elevate: false };
fs.writeFileSync(path.join(f.wrapperRoot, 'lib/channel-install.mjs'), `import fs from 'node:fs';
export function channelPolicyReadiness(){const p=${JSON.stringify(reads)};const n=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):0;fs.writeFileSync(p,JSON.stringify(n+1));return fs.existsSync(${JSON.stringify(marker)})?{state:'ready'}:${JSON.stringify({ state: 'needs-action', reason: 'fixture policy absent', command: action })};}`);
fs.writeFileSync(path.join(f.wrapperRoot, 'bin/aify-wrapper-connect.mjs'), `import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2),r=a[a.indexOf('--registry')+1],o=a[a.indexOf('--report-file')+1];
fs.mkdirSync(path.dirname(r),{recursive:true});fs.writeFileSync(r,JSON.stringify({version:1,services:{'fixture-service':{endpoint:a[1]}}}));
fs.writeFileSync(o,JSON.stringify({installed:[],pending:[]}));`);
const pty = createRequire(import.meta.url)('node-pty');
const env = f.environment();
for (const key of ['NODE_OPTIONS','BASH_ENV','ENV','AIFY_AGENT_ID','AIFY_AGENT_LEASE','AIFY_ENV_INSTANCE','AIFY_LIFETIME']) delete env[key];
// DLL cleanup closes this owned terminal, never enumerates another process's console.
const entry = process.argv[3] || path.join(ROOT, 'bin/aify-env-install.mjs');
const terminal = pty.spawn(process.execPath, [entry, '--connect',
  `fixture-service=${f.endpoint}`, '--client', 'claude'], { cwd: f.home, env, cols: 400, rows: 30, useConptyDll: true });
let output = '', answered = false, completed = null, forced = false, deadline;
const cleanup = [];
const endOwned = () => { if (forced) return; forced = true; cleanup.push('owned-terminal-kill'); terminal.kill(); };
const absolute = setTimeout(endOwned, 15000);
const exited = new Promise(resolve => terminal.onExit(resolve));
terminal.onData(text => {
  output += text;
  if (!answered && output.includes('? [y/N] ')) { answered = true; terminal.write(answer + '\r'); }
  if (completed === null && output.includes(answer === 'y' ? 'chain: complete' : 'chain: not complete')) {
    completed = performance.now(); deadline = setTimeout(endOwned, 3000);
  }
});
const result = await exited;
const afterCompletionMs = completed === null ? null : Math.round(performance.now() - completed);
clearTimeout(absolute); clearTimeout(deadline);
const prepared = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker)) : null;
const record = { platform: process.platform, node: process.version, conptyDll: true, pid: terminal.pid,
  promptAnswered: answered, completionSeen: completed !== null, naturalExit: !forced, exit: result.exitCode,
  afterCompletionMs, cleanup, prepared: prepared ? { args: prepared.args, homeIsPrivate: prepared.home === f.home } : null,
  readinessReads: fs.existsSync(reads) ? JSON.parse(fs.readFileSync(reads)) : 0,
  registry: fs.existsSync(f.registry), paths: f.requests.map(r => r.path), output };
for (const fn of after.reverse()) await fn();
// This exits only the rig after the target's onExit event. It cannot make the target pass.
process.stdout.write(JSON.stringify(record) + '\n', () => process.exit(0));
