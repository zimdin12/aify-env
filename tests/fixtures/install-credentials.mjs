import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
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
    fs.copyFileSync(path.join(peer, 'package.json'), path.join(f.wrapperRoot, 'package.json'));
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
