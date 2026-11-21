#!/usr/bin/env node
// Design candidate. Run only inside the prepared disposable Windows guest or its dedicated WSL distro.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const roles = ['env', 'wrapper', 'comms', 'dashboard'];
const services = { comms: 'aify-comms', dashboard: 'aify-dashboard' };
const clients = ['claude', 'codex', 'hermes'];
const ids = { comms: ['comms-bridge', 'comms-skills'], dashboard: ['dashboard-bridge'] };
const sha = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

function origin(text) {
  const url = new URL(text);
  assert.equal(url.origin, text, 'origin must contain only scheme, host and port');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) >= 49152, 'only dedicated guest loopback ports are allowed');
  return text;
}

function manifest(file) {
  const m = json(file);
  assert.match(m.id, /^[0-9a-f]{12}$/);
  assert.match(m.host, /^aify-rehearsal-[a-z0-9-]+$/);
  if (m.platform === 'wsl') assert.match(m.distro, /^aify-rehearsal-[a-z0-9-]+$/);
  assert.ok(['windows', 'wsl'].includes(m.platform));
  for (const role of roles) assert.match(m.pins?.[role] ?? '', sha, `missing exact ${role} pin`);
  assert.equal(Object.keys(m.pins).length, roles.length);
  const origins = [m.origins?.comms, m.origins?.dashboard, m.origins?.keylessComms].map(origin);
  assert.equal(new Set(origins).size, origins.length, 'the keyless control needs a separate Comms instance');
  assert.match(m.dashboardGitRepo ?? '', /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/, 'name the approved Dashboard HTTPS repository');
  assert.ok(Array.isArray(m.approve) && m.approve.length > 0 && m.approve.every(entry => /^[a-f0-9]{64}$/.test(entry)), 'reviewed tuple digests are required');
  return { ...m, root: fs.realpathSync(path.dirname(file)) };
}

export function requireWslIsolation(config, mounts, searchPath) {
  const settings = {};
  let section;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const heading = /^\[([A-Za-z]+)\]$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    const property = /^(\w+)\s*=\s*(\w+)$/.exec(line);
    if (section && property) {
      const key = `${section}.${property[1]}`;
      assert.ok(!Object.hasOwn(settings, key), 'duplicate WSL setting');
      settings[key] = property[2];
    }
  }
  for (const name of ['automount.enabled', 'interop.enabled', 'interop.appendWindowsPath']) {
    assert.equal(settings[name], 'false', `WSL isolation requires ${name}=false`);
  }
  assert.doesNotMatch(mounts, /\s-\s(?:9p|drvfs|cifs|smb3)\s/, 'Windows or network filesystem is mounted');
  assert.ok(!searchPath.some(dir => /^\/mnt\/[a-z](?:\/|$)/i.test(dir)), 'Windows PATH leaked into WSL');
}

function gate(m) {
  assert.ok(['AIFY_AGENT_ID', 'AIFY_COMMS_AGENT_ID', 'AIFY_AGENT_LEASE', 'AIFY_ENV_INSTANCE', 'AIFY_LIFETIME'].every(k => !process.env[k]), 'refusing inherited agent identity');
  assert.equal(os.hostname().toLowerCase(), m.host);
  const profile = fs.realpathSync(os.homedir());
  assert.match(path.basename(profile).toLowerCase(), /^aify-rehearsal-/);
  assert.ok(inside(profile, m.root), 'fixture must live inside the disposable profile');
  if (m.platform === 'windows') assert.equal(process.platform, 'win32');
  else {
    assert.equal(process.platform, 'linux');
    assert.match(os.release(), /microsoft|wsl/i);
    assert.equal(process.env.WSL_DISTRO_NAME, m.distro);
    assert.equal(fs.statfsSync(m.root).type, 0xef53, 'WSL fixture must be on native ext4');
    requireWslIsolation(fs.readFileSync('/etc/wsl.conf', 'utf8'), fs.readFileSync('/proc/self/mountinfo', 'utf8'),
      [...(process.env.PATH ?? '').split(path.delimiter), ...m.tools.path]);
  }
  const seal = json(path.join(m.root, 'isolated-guest.json'));
  assert.deepEqual(seal, { id: m.id, host: m.host, platform: m.platform, origins: m.origins, noHostShares: true,
    envDaemonAbsent: true, network: 'build-https-and-loopback-fixtures-only' }, 'missing isolated-guest preparation receipt');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 24 || (major === 24 && minor >= 15), 'use Node 24.15 or newer');
  for (const name of ['git', 'bash']) {
    assert.ok(path.isAbsolute(m.tools?.[name]) && fs.statSync(m.tools[name]).isFile(), `absolute ${name} executable required`);
  }
  assert.ok(Array.isArray(m.tools.path) && m.tools.path.length > 0 && m.tools.path.every(dir => path.isAbsolute(dir) && fs.statSync(dir).isDirectory()), 'curated native PATH required');
}

class Rehearsal {
  constructor(m) {
    this.m = m;
    this.source = Object.fromEntries(roles.map(role => [role, this.owned('src', role)]));
    const file = this.owned('keys', 'dashboard-git.credential');
    const credential = new URL(fs.readFileSync(file, 'utf8').trim());
    assert.ok(credential.origin === 'https://github.com' && credential.pathname === `/${m.dashboardGitRepo}.git`
      && credential.username === 'x-access-token' && /^[A-Za-z0-9_]{20,}$/.test(credential.password)
      && !credential.search && !credential.hash, 'Dashboard HTTPS credential scope or format is wrong');
    this.dashboardGit = { file, value: credential.password };
    this.keys = Object.fromEntries(Object.keys(services).map(role => {
      const file = this.owned('keys', `${role}.txt`);
      const value = fs.readFileSync(file, 'utf8').trim();
      assert.ok(new RegExp(`^rehearsal-${m.id}-${role}-[a-f0-9]{48}$`).test(value), 'a run-owned synthetic key is required');
      return [role, { file, value }];
    }));
    this.out = path.join(m.root, 'evidence');
    fs.mkdirSync(this.out, { mode: 0o700 });
    assert.throws(() => this.safe(this.keys.comms.value), /leaked/);
    this.safe('clean evidence control');
    this.save('manifest', { platform: m.platform, pins: m.pins, origins: m.origins, approve: m.approve });
  }

  owned(...parts) {
    const candidate = path.join(this.m.root, ...parts);
    const actual = fs.realpathSync(candidate);
    assert.equal(actual, candidate, 'fixture inputs must be real paths, not links');
    assert.ok(inside(this.m.root, actual));
    return actual;
  }

  safe(text) {
    for (const { value } of [...Object.values(this.keys), this.dashboardGit]) {
      assert.ok(!text.includes(value) && !text.includes(Buffer.from(`x-access-token:${value}`).toString('base64')), 'credential leaked outside custody');
    }
    return text;
  }

  save(label, data) {
    fs.writeFileSync(path.join(this.out, `${label}.json`), this.safe(JSON.stringify(data, null, 2)), { flag: 'wx', mode: 0o600 });
  }

  arm(name) {
    const dir = path.join(this.m.root, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    const folders = Object.fromEntries(['home', 'temp', 'prefix', 'roaming', 'local', 'claude', 'codex', 'hermes'].map(key => {
      const folder = path.join(dir, key); fs.mkdirSync(folder); return [key, folder];
    }));
    const system = Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERNAME', 'USERDOMAIN'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const empty = path.join(dir, 'empty-npmrc');
    fs.writeFileSync(empty, '');
    return { dir, ...folders, env: { ...system, PATH: [process.platform === 'win32' ? folders.prefix : path.join(folders.prefix, 'bin'), path.join(folders.home, '.local', 'bin'), ...this.m.tools.path].join(path.delimiter),
      HOME: folders.home, USERPROFILE: folders.home, APPDATA: folders.roaming, LOCALAPPDATA: folders.local,
      TMP: folders.temp, TEMP: folders.temp, TMPDIR: folders.temp, XDG_CONFIG_HOME: path.join(folders.home, '.config'),
      CLAUDE_CONFIG_DIR: folders.claude, CODEX_HOME: folders.codex, HERMES_HOME: folders.hermes,
      AIFY_HERMES_AGENT: this.owned('runtimes', 'hermes-agent'), AIFY_HOME: path.join(folders.home, '.aify-comms'),
      NPM_CONFIG_PREFIX: folders.prefix, NPM_CONFIG_CACHE: path.join(dir, 'npm-cache'), NPM_CONFIG_USERCONFIG: empty, NPM_CONFIG_GLOBALCONFIG: empty,
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', GIT_CONFIG_GLOBAL: empty,
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', AIFY_ADVERTISE: '0' } };
  }

  run(label, executable, args, arm, wanted = 0, cwd = arm.dir, extra = {}) {
    const r = spawnSync(executable, args, { cwd, env: { ...arm.env, ...extra }, encoding: 'utf8', timeout: 600_000,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    try { this.safe((r.stdout ?? '') + (r.stderr ?? '')); }
    catch { this.save(label, { status: r.status, refused: 'output discarded because it contained a fixture key' }); throw new Error(`${label}: leaked fixture key`); }
    this.save(label, { executable, args, cwd, status: r.status, signal: r.signal, error: r.error?.code,
      stdout: r.stdout, stderr: r.stderr });
    assert.equal(r.status, wanted, `${label}: see recorded command and result`);
    return r.stdout + r.stderr;
  }

  sources(arm) {
    for (const role of roles) {
      const git = (label, ...args) => this.run(`${role}-${label}`, this.m.tools.git, ['-C', this.source[role], ...args], arm).trim();
      assert.equal(git('head', 'rev-parse', 'HEAD'), this.m.pins[role]);
      assert.equal(git('clean', 'status', '--porcelain', '--untracked-files=no'), '');
    }
    assert.ok(json(path.join(this.source.env, 'package.json')).aifyWrapper.endsWith(`#${this.m.pins.wrapper}`), 'env wrapper pin is not the candidate');
    assert.ok(json(path.join(this.source.comms, 'mcp/stdio/package.json')).dependencies['aify-wrapper'].endsWith(`#${this.m.pins.wrapper}`), 'Comms wrapper pin is not the candidate');
    assert.equal(json(path.join(this.source.comms, 'package.json')).aifySkills.directory, '.agents/skills');
    assert.match(fs.readFileSync(path.join(this.source.comms, 'install.sh'), 'utf8'), /^# aify-env-skills-handoff-v1: comms-skills\r?$/m);
    this.run('env-handoff-capability', process.execPath, [path.join(this.source.env, 'bin/aify-env-install.mjs'), '--supports-skills-handoff-v1'], arm);
  }

  async wrapperLock(arm) {
    const wrapper = this.source.wrapper;
    const lock = path.join(wrapper, 'package-lock.json');
    const before = hash(fs.readFileSync(lock));
    this.save('online-lock', { before, resolvedEnv: json(lock).packages['node_modules/aify-env'].resolved });
    assert.ok(!fs.existsSync(path.join(wrapper, 'node_modules')), 'online source must be cold');
    assert.ok(!fs.existsSync(path.join(wrapper, '.npmrc')), 'online source must not inject an npm configuration');
    const online = { GIT_TRACE: '1' };
    this.run('online-npm-version', this.m.tools.bash, ['-c', 'exec npm --version'], arm, 0, wrapper, online);
    try {
      this.run('online-wrapper-ci', this.m.tools.bash, ['-c', 'exec npm ci --no-audit --no-fund'], arm, 0, wrapper, online);
      const require = createRequire(path.join(wrapper, 'package.json'));
      const { skillDirectory } = await import(pathToFileURL(require.resolve('aify-env/client/installed-skills')));
      assert.equal(skillDirectory({ directory: '.agents/skills' }), '.agents/skills', 'wrapper lock lacks shared skill grammar');
    } finally {
      const after = hash(fs.readFileSync(lock));
      this.save('online-lock-after', { after });
      assert.equal(after, before, 'npm ci may not rewrite the wrapper lock');
    }
  }

  async request(label, base, route, expect, headers = {}) {
    assert.ok(typeof route === 'string' && route.startsWith('/') && new URL(route, base).origin === base);
    const response = await fetch(new URL(route, base), { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const text = this.safe(await response.text());
    this.save(label, { base, route, status: response.status });
    assert.equal(response.status, expect, label);
    return response.ok ? JSON.parse(text) : null;
  }

  async service(role, base, label, keyRequired) {
    const spec = await this.request(`${label}-spec`, base, '/.well-known/aify-service', 200);
    assert.equal(spec.name, services[role]);
    for (const id of ids[role]) {
      const git = spec.artifacts.find(a => a.id === id)?.source.git;
      assert.equal(git?.revision, this.m.pins[role], 'scratch service must offer the exact pin');
      if (role === 'dashboard') assert.equal(git.repo, this.m.dashboardGitRepo, 'wrong private HTTPS scope');
    }
    const health = await this.request(`${label}-health`, base, '/health', 200);
    if (role === 'dashboard') assert.equal(health.gitSha, this.m.pins[role]);
    else assert.ok(/^[a-f0-9]{7,40}$/.test(health.build) && this.m.pins[role].startsWith(health.build) && !health.buildIdentityOverriddenBy?.length);
    const secret = spec.secrets.find(s => s.field === 'credentialRef');
    assert.equal(secret.required, keyRequired);
    const { path: route, header } = spec.verify.probes[secret.probe];
    await this.request(`${label}-no-key`, base, route, keyRequired ? 401 : 200);
    if (keyRequired) {
      await this.request(`${label}-wrong-key`, base, route, 401, { [header]: `absent-${this.m.id}` });
      await this.request(`${label}-fixture-key`, base, route, 200, { [header]: this.keys[role].value });
    }
  }

  install(label, arm, { approve = true, key = true, expected = 0, keyless = false } = {}) {
    const args = [path.join(this.source.env, 'install.sh'), '--no-prompt',
      '--connect', `${services.comms}=${this.m.origins[keyless ? 'keylessComms' : 'comms']}`,
      '--connect', `${services.dashboard}=${this.m.origins.dashboard}`, ...clients.flatMap(client => ['--client', client])];
    if (approve) for (const digest of this.m.approve) args.push('--approve', digest);
    if (key && !keyless) args.push('--secret', `${services.comms}.credentialRef=${this.keys.comms.file}`);
    if (key) args.push('--secret', `${services.dashboard}.credentialRef=${this.keys.dashboard.file}`);
    const credentialFile = this.dashboardGit.file.replaceAll('\\', '/').replaceAll("'", "'\\''");
    const trace = path.join(arm.temp, `${label}-git.trace`);
    const result = this.run(label, this.m.tools.bash, args, arm, expected, arm.dir, {
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.useHttpPath', GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: `credential.https://github.com/${this.m.dashboardGitRepo}.git.helper`,
      GIT_CONFIG_VALUE_1: `store --file='${credentialFile}'`, GIT_TRACE: trace.replaceAll('\\', '/'),
    });
    const observed = fs.existsSync(trace) && this.safe(fs.readFileSync(trace, 'utf8')).split(/\r?\n/)
      .some(line => /credential-store.*\bget\b/.test(line) && line.includes('dashboard-git.credential'));
    this.save(`${label}-git-auth`, { httpsRepoScopedCredentialStoreObserved: observed });
    if (label === 'cold-install') assert.ok(observed, 'missing witness that cold Dashboard acquire used the scoped HTTPS credential');
    return result;
  }

  seedClaude(arm) {
    const folder = path.join(arm.home, '.claude');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ env: { REHEARSAL_UNRELATED: this.m.id } }));
    fs.writeFileSync(path.join(arm.home, '.claude.json'), '{"projects":{}}');
  }

  claudeHooks(label, arm) {
    const jsonText = this.safe(fs.readFileSync(path.join(arm.home, '.claude', 'settings.json'), 'utf8'));
    const settings = JSON.parse(jsonText);
    assert.equal(settings.env?.REHEARSAL_UNRELATED, this.m.id);
    const events = Object.keys(settings.hooks ?? {});
    assert.ok(events.includes('UserPromptSubmit') && events.includes('Stop'));
    const commands = (settings.hooks.UserPromptSubmit ?? []).flatMap(row => row.hooks ?? []).map(row => row.command ?? '');
    assert.ok(commands.some(command => /agent-state-event|turn-start/.test(command)), 'Comms turn-start hook not present');
    this.save(label, { events, unrelatedPreserved: true, settingsSha256: hash(jsonText) });
  }

  async mcp(arm) {
    const registry = json(path.join(arm.home, '.aify', 'services.json')).services;
    const comms = registry[services.comms].mcp.find(row => row.name === services.comms);
    const sdk = createRequire(path.resolve(comms.args[0]));
    const load = name => import(pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/client/${name}.js`)));
    const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all(['index', 'stdio', 'streamableHttp'].map(load));
    const agent = `rehearsal-${this.m.id}`;
    const witness = async (label, transport, tool) => {
      const client = new Client({ name: 'rehearsal', version: '1' });
      let stderr = '';
      transport.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
      try {
        await client.connect(transport, { timeout: 10_000 });
        const result = await client.listTools(undefined, { timeout: 10_000 });
        assert.ok(result.tools.some(entry => entry.name === tool), `${label}: named tool did not answer`);
        assert.ok(!result.tools.some(entry => entry.name === 'not_a_rehearsal_tool'));
        this.save(label, { status: 'initialized and listed expected tool', tool });
      } finally { await client.close(); this.safe(stderr); }
    };
    for (const [role, tool] of [['comms', 'comms_agents'], ['dashboard', 'dashboard_whoami']]) {
      const { command, args } = registry[services[role]].mcp.find(row => row.name === services[role]);
      assert.equal(fs.realpathSync(command), fs.realpathSync(process.execPath), 'unexpected MCP executable');
      assert.equal(args.length, 1);
      assert.ok(inside(arm.dir, fs.realpathSync(args[0])), 'MCP entry escaped the fixture');
      await witness(`${role}-stdio`, new StdioClientTransport({ command, args, cwd: arm.dir,
        env: { ...arm.env, AIFY_AGENT_ID: agent, AIFY_SERVICE_REGISTRY: path.join(arm.home, '.aify', 'services.json') }, stderr: 'pipe' }), tool);
    }
    const http = new StreamableHTTPClientTransport(new URL('/mcp/http', this.m.origins.comms), { requestInit: { redirect: 'error',
      headers: { 'x-api-key': this.keys.comms.value, 'x-aify-agent-id': agent } } });
    await witness('comms-http', http, 'comms_agents');
  }

  async readback(label, arm, keyless = false) {
    const base = path.join(arm.home, '.aify');
    const raw = readFileSafe(path.join(base, 'services.json'), text => this.safe(text));
    const registry = JSON.parse(raw).services;
    assert.equal(registry[services.comms].endpoint, this.m.origins[keyless ? 'keylessComms' : 'comms']);
    assert.equal(registry[services.dashboard].endpoint, this.m.origins.dashboard);
    for (const role of Object.keys(services)) {
      const entry = registry[services[role]];
      assert.ok(entry.mcp?.some(row => row.name === services[role]), `missing ${role} MCP entry`);
      if (role !== 'comms' || !keyless) assert.equal(typeof entry.credentialRef, 'string');
    }
    const npm = process.platform === 'win32' ? path.join(arm.prefix, 'node_modules') : path.join(arm.prefix, 'lib', 'node_modules');
    const require = createRequire(path.join(npm, 'aify-env', 'package.json'));
    const { verifyPlacement } = await import(pathToFileURL(require.resolve('aify-env/client/installed-skills')));
    const receipt = readFileSafe(path.join(base, 'installed-skills.json'), text => this.safe(text));
    const rows = JSON.parse(receipt).placements;
    const trees = { comms: this.owned('src', 'comms', '.agents', 'skills'), dashboard: this.owned('src', 'dashboard', 'skill') };
    for (const role of Object.keys(trees)) {
      const dirs = fs.readdirSync(trees[role], { withFileTypes: true }).filter(item => item.isDirectory());
      assert.ok(dirs.length > 0);
      for (const { name: skill } of dirs) for (const harness of clients) {
        const matches = rows.filter(row => row.service === services[role] && row.skill === skill && row.harness === harness);
        assert.equal(matches.length, 1, 'one receipt per selected skill');
        const [row] = matches;
        assert.equal(row.source.revision, this.m.pins[role]);
        assert.ok(inside(arm.dir, fs.realpathSync(row.destination)), 'placement must be inside this arm');
        assert.equal(verifyPlacement({ home: arm.home, service: services[role], skill, harness }).state, 'placed');
        assert.deepEqual(tree(path.join(trees[role], skill)), tree(row.destination), 'receipt must attest source bytes, not merely agree with its own copy');
      }
    }
    this.save(label, { registrySha256: hash(raw), receiptSha256: hash(receipt), placements: rows });
    return { receipt: hash(receipt), registry: hash(raw) };
  }
}

function readFileSafe(file, inspect) { return inspect(fs.readFileSync(file, 'utf8')); }
function tree(folder) {
  return Object.fromEntries(fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return [[entry.name, 'dir'], ...Object.entries(tree(file)).map(([name, digest]) => [`${entry.name}/${name}`, digest])];
    assert.ok(entry.isFile() && !entry.isSymbolicLink());
    return [[entry.name, hash(fs.readFileSync(file))]];
  }));
}

async function main(args) {
  const [mode, file, ...rest] = args;
  assert.ok(rest.length === 0 && file && ['--preflight', '--run'].includes(mode), 'usage: node rehearse.mjs --preflight|--run <fixture>/pins.json');
  const m = manifest(path.resolve(file));
  if (mode === '--preflight') { console.log('Pin and origin syntax valid; no checkout, child process or endpoint was touched.'); return; }
  gate(m);
  const r = new Rehearsal(m);
  const lock = r.arm('wrapper-lock');
  r.sources(lock);
  await r.wrapperLock(lock);
  const cold = r.arm('cold');
  r.seedClaude(cold);
  await r.service('comms', m.origins.comms, 'comms-required', true);
  await r.service('dashboard', m.origins.dashboard, 'dashboard-required', true);
  await r.service('comms', m.origins.keylessComms, 'comms-keyless', false);
  const refused = r.arm('unapproved');
  assert.match(r.install('unapproved', refused, { approve: false, expected: 78 }), /not approved/);
  assert.equal(fs.existsSync(path.join(refused.home, '.aify', 'services.json')), false);
  const missing = r.arm('missing-key');
  assert.match(r.install('missing-key', missing, { key: false, expected: 78 }), /key|credential/i);
  assert.equal(fs.existsSync(path.join(missing.home, '.aify', 'services.json')), false);
  r.install('cold-install', cold);
  const before = await r.readback('cold-readback', cold);
  r.claudeHooks('cold-hooks', cold);
  await r.mcp(cold);
  r.install('identical-rerun', cold);
  assert.deepEqual(await r.readback('rerun-readback', cold), before, 'unchanged invocation must keep the receipt and registry bytes');
  r.claudeHooks('rerun-hooks', cold);
  const keyless = r.arm('keyless');
  r.seedClaude(keyless);
  r.install('keyless-install', keyless, { keyless: true });
  await r.readback('keyless-readback', keyless, true);
  const collision = r.arm('legacy-collision');
  r.seedClaude(collision);
  const firstSkill = fs.readdirSync(r.owned('src', 'comms', '.agents', 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()[0];
  assert.ok(firstSkill);
  const legacy = path.join(collision.claude, 'skills', firstSkill);
  fs.cpSync(r.owned('src', 'comms', '.agents', 'skills', firstSkill), legacy, { recursive: true, force: false, errorOnExist: true });
  const prior = tree(legacy);
  assert.match(r.install('legacy-collision', collision, { expected: 78 }), /unmanaged or changed|would shadow/);
  assert.deepEqual(tree(legacy), prior);
  assert.equal(fs.existsSync(path.join(collision.home, '.aify', 'installed-skills.json')), false);
  r.save('legacy-readback', { sameBytes: true, placementReceipt: 'absent' });
  const standalone = r.arm('standalone');
  r.seedClaude(standalone);
  delete standalone.env.CLAUDE_CONFIG_DIR; // explicit legacy default, still under its throwaway home
  r.run('standalone-install', m.tools.bash, [path.join(r.source.comms, 'install.sh'), '--standalone', '--client', 'claude', m.origins.comms],
    standalone, 0, standalone.dir, { AIFY_API_KEY: r.keys.comms.value });
  const standaloneTree = path.join(standalone.home, '.claude', 'skills', firstSkill);
  assert.deepEqual(tree(standaloneTree), tree(r.owned('src', 'comms', '.agents', 'skills', firstSkill)));
  assert.equal(fs.existsSync(path.join(standalone.home, '.aify', 'installed-skills.json')), false);
  r.claudeHooks('standalone-hooks', standalone);
  r.save('qualification', { automated: 'PASS', rollout: 'NOT QUALIFIED until supervised runtime discovery, native hook trace, missing-client, and update/removal controls are attached' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
