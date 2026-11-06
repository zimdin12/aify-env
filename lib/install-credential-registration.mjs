// The existing wrapper transaction owns keys, registry publication and rerender; this supplies host IO only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { globalNpmRoot } from './install-chain-host.mjs';
import { serviceIdentity } from './services.mjs';
import { credentialValueProblem } from './credential-store.mjs';

export class InstallCredentialRegistration {
  #env; #home; #envRoot; #registry; #wrapperRoot; #modules = null; #fetch; #timeout; #spawn; #connectTimeout;
  constructor({ env, home, envRoot, registry, wrapperRoot = null, fetchImpl = fetch, timeoutMs = null,
    spawnProcess = spawn, connectTimeoutMs = 300_000 }) {
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || ![home, envRoot, registry].every(value => typeof value === 'string' && path.isAbsolute(value))) {
      throw new TypeError('credential registration needs an explicit environment and absolute host paths');
    }
    this.#env = env; this.#home = home; this.#envRoot = envRoot; this.#registry = registry; this.#wrapperRoot = wrapperRoot;
    this.#fetch = fetchImpl; this.#timeout = timeoutMs; this.#spawn = spawnProcess; this.#connectTimeout = connectTimeoutMs;
  }
  async #load() {
    if (!this.#modules) this.#modules = (async () => {
      const root = this.#wrapperRoot ?? path.join(globalNpmRoot({ env: this.#env }), 'aify-wrapper');
      if (!path.isAbsolute(root)) throw Error('the installed wrapper could not be located');
      const http = await import(pathToFileURL(path.join(root, 'lib/connect-http.mjs')).href);
      const spec = await import(pathToFileURL(path.join(root, 'lib/service-spec.mjs')).href);
      if (![http.fetchSpec, spec.validateSpec, spec.resolveRoute].every(fn => typeof fn === 'function')) throw Error('the installed wrapper lacks its service-spec interface');
      return { root, fetchSpec: http.fetchSpec, validateSpec: spec.validateSpec, resolveRoute: spec.resolveRoute, timeoutMs: http.REQUEST_TIMEOUT_MS };
    })();
    return this.#modules;
  }
  async readSpec(target) {
    const owner = await this.#load(), selected = serviceIdentity(target);
    const spec = await owner.fetchSpec(selected.endpoint);
    if (owner.validateSpec(spec, selected).ok !== true) throw Error('the selected service specification is refused');
    return spec;
  }
  async probeWithoutCredential(target, probe) {
    const owner = await this.#load();
    const response = await this.#fetch(owner.resolveRoute(serviceIdentity(target).endpoint, probe.path), {
      method: 'GET', headers: {}, credentials: 'omit', redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeout ?? owner.timeoutMs),
    });
    await response.body?.cancel();
    return response.status;
  }
  async publish(target, key) {
    if (credentialValueProblem(key)) return { status: 78, reason: 'credential-invalid' };
    const owner = await this.#load(), selected = serviceIdentity(target), url = new URL(selected.endpoint);
    if (!selected.admitted || url.username || url.password) return { status: 78 };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-credential-connect-'));
    try {
      const args = [path.join(owner.root, 'bin/aify-wrapper-connect.mjs'), target.name, selected.endpoint,
        '--key-stdin', '--no-prompt', '--registry', this.#registry, '--dest', path.join(this.#home, '.local', 'bin'),
        '--aify-env', path.join(this.#envRoot, 'bin/aify-env.mjs'), '--report-file', path.join(directory, 'report.json')];
      const status = await new Promise(resolve => {
        let child;
        try { child = this.#spawn(process.execPath, args, { env: this.#env, stdio: ['pipe', 'ignore', 'ignore'], timeout: this.#connectTimeout }); }
        catch { resolve(78); return; }
        child.once('error', () => resolve(75));
        child.once('close', (code, signal) => resolve(signal || code === null ? 75 : code));
        child.stdin.on('error', () => {}); // A refusal may close stdin before consuming the supplied key.
        child.stdin.end(key);
      });
      // Owner prose is deliberately not replayed: remote metadata/redirect diagnostics can reflect secret material.
      return { status };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
