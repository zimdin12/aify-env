import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { credentialRoot, writeCredentialFile } from '../../lib/credential-fs.mjs';
import { defaultCredentialRef } from '../../lib/credential-store.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const KEY = 'fixture-credential-0123456789abcdef';
export const PEER_REQUIRED = !process.env.AIFY_WRAPPER_REPO ? 'requires explicit AIFY_WRAPPER_REPO checkout' : false;

export class CredentialInstallFixture {
  static async create(t, { status = 401, required = true, probe = true } = {}) {
    const f = new CredentialInstallFixture();
    f.home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-credentials-'));
    f.root = credentialRoot(f.home);
    f.registry = path.join(f.home, 'custom', 'services.json');
    f.defaultRegistry = path.join(f.home, '.aify', 'services.json');
    f.npmRoot = path.join(f.home, 'npm-global');
    f.wrapperRoot = path.join(f.npmRoot, 'aify-wrapper');
    const peer = process.env.AIFY_WRAPPER_REPO;
    assert.ok(peer && fs.existsSync(path.join(peer, 'lib/connect.mjs')), 'explicit maintained wrapper fixture source');
    for (const dir of ['lib', 'bin']) fs.cpSync(path.join(peer, dir), path.join(f.wrapperRoot, dir), { recursive: true });
    const manifest = path.join(peer, 'package.json');
    fs.copyFileSync(manifest, path.join(f.wrapperRoot, 'package.json'));
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies?.['aify-env']) {
      // Use the source checkout's installed pin, never this fixture's primary env or a global package.
      const pin = spawnSync(process.execPath, [path.join(peer, 'lib/checkout-env-pin.mjs')], { encoding: 'utf8', timeout: 5000 });
      assert.equal(pin.status, 0, `Install the locked aify-env dependency in the isolated wrapper peer first. ${pin.stderr ?? ''}`);
      const { includePinnedEnv } = await import(pathToFileURL(path.join(peer, 'tests/pinned-env-fixture.mjs')).href);
      includePinnedEnv(f.wrapperRoot);
    }
    f.bin = path.join(f.home, 'bin'); fs.mkdirSync(f.bin);
    const npmStub = path.join(f.bin, 'npm-stub.mjs');
    fs.writeFileSync(npmStub, `if (JSON.stringify(process.argv.slice(2)) !== '["root","-g"]') process.exit(91); process.stdout.write(process.env.FIXTURE_NPM_ROOT + '\\n');\n`);
    fs.writeFileSync(path.join(f.bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${npmStub}" %*\r\n`);
    fs.writeFileSync(path.join(f.bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${npmStub}" "$@"\n`, { mode: 0o755 });
    f.status = status; f.requests = []; f.location = '';
    f.spec = { specVersion: 1, name: 'aify-comms', version: 'fixture', fixed: { keyEnv: ['FIXTURE_SERVICE_KEY'] }, artifacts: [], mcp: [],
      secrets: [{ field: 'credentialRef', required, ...(probe ? { probe: 'api' } : {}) }],
      verify: { health: { path: '/health' }, probes: probe ? { api: { path: '/declared-api', header: 'x-api-key' } } : {} } };
    f.server = http.createServer((req, res) => {
      f.requests.push({ path: req.url, headers: { ...req.headers } });
      if (req.url === '/.well-known/aify-service') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(f.spec)); return;
      }
      if (req.url === '/health') { res.writeHead(200); res.end('{}'); return; }
      if (req.url === '/declared-api') {
        if (f.holdProbe) return;
        const code = f.registrationProbes ? (req.headers['x-api-key'] === KEY ? 200 : 401) : f.status;
        res.writeHead(code, { ...(f.location ? { location: f.location } : {}) }); res.end('{}'); return;
      }
      res.writeHead(404); res.end();
    });
    f.server.listen(0, '127.0.0.1'); await once(f.server, 'listening');
    f.endpoint = `http://127.0.0.1:${f.server.address().port}`;
    t.after(async () => {
      await new Promise(resolve => { f.server.close(resolve); f.server.closeAllConnections(); });
      fs.rmSync(f.home, { recursive: true, force: true });
    });
    return f;
  }
  writeRegistry(services, file = this.registry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, services }));
  }
  target(over = {}) { return { name: 'aify-comms', endpoint: this.endpoint, keyEnv: ['FIXTURE_SERVICE_KEY'], ...over }; }
  async store(ref = 'non-default.key', value = KEY) {
    const result = await writeCredentialFile({ root: this.root, ref, value }); assert.equal(result.ok, true, result.detail); return ref;
  }
  defaultRef() { return defaultCredentialRef('aify-comms'); }
  // CLI tests pass through bootstrap. Pack the already configured fixture and let real npm own its global bins.
  prepareGuidedWrapper() {
    const source = path.join(this.home, 'wrapper-source');
    for (const dir of ['lib', 'bin']) fs.cpSync(path.join(this.wrapperRoot, dir), path.join(source, dir), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'aify-wrapper', version: '0.0.0', type: 'module',
      bin: { 'aify-wrapper-check': 'bin/aify-wrapper-check.mjs' } }));
    const prefix = path.join(this.home, 'guided-npm');
    const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    const env = { ...this.environment(), PATH: bin + path.delimiter + process.env.PATH, npm_config_prefix: prefix, npm_config_offline: 'true',
      npm_config_cache: path.join(this.home, 'npm-cache'), AIFY_INSTALL_WRAPPER_SOURCE: source };
    const npm = (...args) => {
      const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { env, cwd: this.home, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      return result.stdout.trim();
    };
    const [pack] = JSON.parse(npm('pack', '--json', '--ignore-scripts', source));
    npm('install', '-g', '--no-audit', '--no-fund', '--ignore-scripts', path.join(this.home, pack.filename));
    const installed = path.join(npm('root', '-g'), 'aify-wrapper');
    const dependencies = path.join(this.wrapperRoot, 'node_modules');
    if (fs.existsSync(dependencies)) fs.cpSync(dependencies, path.join(installed, 'node_modules'), { recursive: true });
    return env;
  }
  environment(extra = {}) {
    const env = { ...process.env, HOME: this.home, USERPROFILE: this.home, APPDATA: this.home, LOCALAPPDATA: this.home,
      AIFY_SERVICE_REGISTRY: this.registry, FIXTURE_NPM_ROOT: this.npmRoot, PATH: this.bin + path.delimiter + process.env.PATH };
    delete env.FIXTURE_SERVICE_KEY;
    return { ...env, ...extra };
  }
  runInteractive(input, { newline = true } = {}) {
    const preload = path.join(this.home, 'controlled-tty.mjs');
    fs.writeFileSync(preload, `if (String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('/scripts/install-credentials.mjs')) Object.defineProperty(process.stdin, 'isTTY', {value:true});\n`);
    return this.run([], { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, input + (newline ? '\n' : ''));
  }
  run(args = ['--no-prompt'], extra = {}, input) {
    const env = this.environment(extra);
    return new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'scripts/install-credentials.mjs'), ...args], { cwd: this.home, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 30000 });
      if (input !== undefined) { c.stdin.on('error', () => {}); c.stdin.end(input); }
      let stdout = '', stderr = '';
      c.stdout.on('data', b => stdout += b); c.stderr.on('data', b => stderr += b); c.once('error', reject);
      c.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
  }
}
