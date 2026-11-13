// The chain delegates authentication and publication to the actual released connect owner, in an owned home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { InstallChain, installCommand, parseChainArgs } from '../lib/install-chain.mjs';
import { CredentialInstallFixture, KEY, PEER_REQUIRED, ROOT } from './fixtures/install-credentials.mjs';

for (const mode of ['keyless', 'required-missing', 'required-wrong', 'required-valid', 'required-malformed']) {
  test(`real connect ${mode}: only admitted credentials can publish the private registry`, { skip: PEER_REQUIRED, timeout: 30000 }, async t => {
    const f = await CredentialInstallFixture.create(t, { required: mode !== 'keyless', status: 200 });
    f.registrationProbes = mode !== 'keyless';
    const { connect, aifyEnvTools } = await import(pathToFileURL(path.join(f.wrapperRoot, 'lib/connect.mjs')).href);
    const { channelPolicyReadiness } = await import(pathToFileURL(path.join(f.wrapperRoot, 'lib/channel-install.mjs')).href);
    // Only these two subcommands are exposed. This dispatcher cannot run or import the daemon entry.
    const owner = path.join(f.home, 'owner.mjs');
    fs.writeFileSync(owner, `import {pathToFileURL} from 'node:url'; import path from 'node:path';
const [kind,...args]=process.argv.slice(2); if(!['credential','registry'].includes(kind))throw Error('refused command');
const file=path.join(${JSON.stringify(ROOT)},'bin','aify-env-'+kind+'.mjs'); process.argv=[process.execPath,file,...args]; await import(pathToFileURL(file).href);\n`);
    const env = f.environment();
    const value = mode === 'required-valid' ? KEY : mode === 'required-wrong' ? 'wrong-fixture-key' : mode === 'required-malformed' ? 'bad\nkey' : undefined;
    const lines = [], trace = [];
    let refusal = '';
    const io = {
      env, windows: process.platform === 'win32', say: line => lines.push(line),
      ensurePackages: async () => true, unapproved: async () => [], askTerminal: async () => { throw Error('unexpected consent'); },
      policyReadiness: clients => channelPolicyReadiness({ clients, env, read: () => { throw Error('Codex policy read'); } }),
      preparePolicy: async () => { throw Error('unexpected preparation'); },
      approvedInstaller: async () => null, packageAssets: async () => null,
      connect: async ({ stdin }) => {
        assert.equal(stdin?.field, value === undefined ? undefined : 'credentialRef');
        trace.push('connect');
        try {
          const report = await connect({ name: 'aify-comms', endpoint: f.endpoint, secrets: value === undefined ? {} : { credentialRef: value },
            approved: new Set(), registryPath: f.registry, home: f.home, dest: path.join(f.home, 'launchers'),
            wrapperRoot: f.wrapperRoot, execPath: process.execPath, env, readStored: () => '',
            packageRoot: path.join(f.home, 'packages'), stagingDir: path.join(f.home, 'staging'),
            tools: aifyEnvTools(owner, env), npm: () => { throw Error('unexpected package install'); } });
          return { status: report.result === 'committed' ? 0 : 78, installed: {} };
        } catch (error) { refusal = error.message; return { status: 78, installed: {} }; }
      },
      render: async () => { trace.push('render'); return 0; }, cliPresent: () => true,
      registryHash: async () => fs.existsSync(f.registry) ? fs.readFileSync(f.registry, 'utf8') : 'absent', keyEnv: async () => [],
    };
    const parsed = parseChainArgs(['--connect', `aify-comms=${f.endpoint}`, '--client', 'codex', '--no-prompt',
      ...(value === undefined ? [] : ['--secret-stdin', 'aify-comms.credentialRef'])]);
    const { exit } = await new InstallChain(parsed, io).run();
    const admitted = mode === 'keyless' || mode === 'required-valid';
    assert.equal(exit, admitted ? 0 : 78, refusal);
    assert.equal(fs.existsSync(f.registry), admitted, 'a refusal must publish no registry');
    assert.equal(trace.includes('render'), admitted);
    assert.equal(lines.join('\n').includes(KEY), false);
    if (admitted) {
      const entry = JSON.parse(fs.readFileSync(f.registry, 'utf8')).services['aify-comms'];
      assert.equal(entry.endpoint, f.endpoint);
      assert.equal(typeof entry.credentialRef === 'string', mode === 'required-valid');
    } else {
      assert.equal(fs.existsSync(f.root) ? fs.readdirSync(f.root).some(name => !name.startsWith('.')) : false, false, 'failed admission keeps no staged key');
    }
    if (mode === 'required-missing') assert.match(refusal, /required.*none.*stored or supplied/);
    if (mode === 'required-wrong') assert.match(refusal, /401.*the key.*200/);
    if (mode === 'keyless') {
      // Optional absence skips connect's secret probe. Independently witness this fixture's real API admission.
      assert.equal((await fetch(f.endpoint + '/declared-api')).status, 200);
    }
  });
}

test('the actual install entry asks the wrapper with original env and refuses absent policy before connect', { skip: PEER_REQUIRED, timeout: 30000 }, async t => {
  const f = await CredentialInstallFixture.create(t);
  const seen = path.join(f.home, 'readiness.json'), effect = path.join(f.home, 'must-not-prepare');
  const action = { file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(effect)},'bad')`], elevate: false };
  fs.writeFileSync(path.join(f.wrapperRoot, 'lib/channel-install.mjs'), `import fs from 'node:fs';
export function channelPolicyReadiness({clients,env}) { fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({clients,home:env.HOME,profile:env.USERPROFILE})); return ${JSON.stringify({ state: 'needs-action', command: action, reason: 'fixture policy absent' })}; }\n`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/aify-env-install.mjs'), '--connect', `aify-comms=${f.endpoint}`,
      '--client', 'claude', '--secret-stdin', 'aify-comms.credentialRef', '--no-prompt'],
    { env: f.environment(), cwd: f.home, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.once('error', reject); child.once('close', status => resolve({ status, out, err })); child.stdin.end(KEY);
  });
  assert.equal(result.status, 78, result.err);
  assert.equal(fs.existsSync(seen), true, 'the actual entry must call the owner');
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { clients: ['claude'], home: f.home, profile: f.home });
  assert.equal(fs.existsSync(effect), false);
  assert.equal(fs.existsSync(f.registry), false);
  assert.equal(f.requests.some(r => r.path === '/health' || r.path === '/declared-api'), false, 'connect must not run');
  assert.equal((result.out + result.err).includes(KEY), false);
  assert.equal(result.out.split('\n').filter(line => line.startsWith(process.platform === 'win32' ? "& " : "'")).length, 1);
});

test('actual entry prepares only the owner action after a controlled terminal yes, rereads and continues', { skip: PEER_REQUIRED, timeout: 30000 }, async t => {
  const f = await CredentialInstallFixture.create(t, { required: false });
  f.spec.name = 'fixture-service';
  const marker = path.join(f.home, 'prepared.json'), seen = path.join(f.home, 'reads.json');
  const prepare = path.join(f.home, 'policy-only.mjs');
  fs.writeFileSync(prepare, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME}));\n`);
  const action = { file: process.execPath, args: [prepare, 'prepare-policy'], elevate: false };
  fs.writeFileSync(path.join(f.wrapperRoot, 'lib/channel-install.mjs'), `import fs from 'node:fs';
export function channelPolicyReadiness({clients,env}) { const p=${JSON.stringify(seen)};const n=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):0;fs.writeFileSync(p,JSON.stringify(n+1));return fs.existsSync(${JSON.stringify(marker)})?{state:'ready',command:null,reason:'prepared'}:${JSON.stringify({ state: 'needs-action', command: action, reason: 'fixture absent' })}; }\n`);
  // A fixture connect marks its own publication. Real connect admission is covered in the cases above.
  fs.writeFileSync(path.join(f.wrapperRoot, 'bin/aify-wrapper-connect.mjs'), `import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2),r=a[a.indexOf('--registry')+1],o=a[a.indexOf('--report-file')+1];fs.mkdirSync(path.dirname(r),{recursive:true});fs.writeFileSync(r,JSON.stringify({version:1,services:{'fixture-service':{endpoint:a[1]}}}));fs.writeFileSync(o,JSON.stringify({installed:[]}));\n`);
  const answers = path.join(f.home, 'answers'), terminalOut = path.join(f.home, 'terminal-out');
  fs.writeFileSync(answers, 'yes\n');
  const preload = path.join(f.home, 'controlled-terminal.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1].endsWith('aify-env-install.mjs')) {const open=fs.openSync;fs.openSync=function(file,...rest){if(file==='CONIN$'||file==='/dev/tty'&&rest[0]==='r')return open(${JSON.stringify(answers)},'r');if(file==='CONOUT$'||file==='/dev/tty'&&rest[0]==='w')return open(${JSON.stringify(terminalOut)},'a');return open(file,...rest)};Object.defineProperty(process.stdout,'isTTY',{value:true});syncBuiltinESMExports();}\n`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(ROOT, 'bin/aify-env-install.mjs'),
      '--connect', `fixture-service=${f.endpoint}`, '--client', 'claude'],
    { env: f.environment(), cwd: f.home, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.once('error', reject); child.once('close', status => resolve({ status, out, err }));
  });
  assert.equal(result.status, 0, result.err + result.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { args: ['prepare-policy'], home: f.home });
  assert.equal(JSON.parse(fs.readFileSync(seen, 'utf8')), 2, 'preparation must be read back by its owner');
  assert.equal(fs.existsSync(f.registry), true, 'connect continues only after preparation');
  assert.equal(result.out.includes('chain: complete'), true);
});

for (const windows of [false, true]) {
  test(`printed ${windows ? 'PowerShell' : 'POSIX'} command executes with literal argv, not shell fragments`, () => {
    const words = ['space value', "quote'value", '$NOT_A_SECRET', 'semi;colon', 'line\nvalue', '', 'path\\tail'];
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const text = installCommand([process.execPath.replaceAll('\\', '/'), '-e', script, ...words], windows);
    const result = windows
      ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', text], { encoding: 'utf8', timeout: 10000 })
      : spawnSync('bash', ['-c', text], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), words);
  });
}
