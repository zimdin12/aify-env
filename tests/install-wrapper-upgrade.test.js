import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { pinnedWrapperSource } from '../lib/wrapper-pin.mjs';

const entry = fileURLToPath(new URL('../bin/aify-env-install.mjs', import.meta.url));
const windows = process.platform === 'win32';
const markerFile = 'check.mjs';
const bin = 'aify-wrapper-check';

function fixture(t, { linkedPrefix = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-upgrade-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  const prefix = path.join(home, 'prefix'), registry = path.join(home, 'registry.json');
  if (linkedPrefix) {
    const target = fs.mkdtempSync(path.join(home, 'npm-store-'));
    fs.symlinkSync(target, prefix, windows ? 'junction' : 'dir');
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home,
    npm_config_prefix: prefix, npm_config_cache: path.join(home, 'cache'), npm_config_offline: 'true',
    AIFY_SERVICE_REGISTRY: registry };
  const run = (args, extra = {}) => spawnSync(process.execPath, args, {
    env: { ...env, ...extra }, cwd: home, encoding: 'utf8', timeout: 45000,
  });
  const npm = (...args) => {
    const result = run([process.env.npm_execpath, ...args]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
  };
  const modules = npm('root', '-g'), root = path.join(modules, 'aify-wrapper');
  const binRoot = windows ? prefix : path.join(prefix, 'bin');
  const marker = (dir = root) => fs.readFileSync(path.join(dir, markerFile), 'utf8');
  function source(label) {
    const dir = path.join(home, label);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'aify-wrapper', version: '1.0.0', bin: { [bin]: markerFile } }));
    fs.writeFileSync(path.join(dir, markerFile), `#!/usr/bin/env node\nthrow new Error('never run wrapper bin: ${label}');\n`);
    return dir;
  }
  function install(dir) {
    const [pack] = JSON.parse(npm('pack', '--json', '--ignore-scripts', dir));
    npm('install', '-g', '--ignore-scripts', '--no-audit', '--no-fund', path.join(home, pack.filename));
  }
  const desired = source('desired'), old = source('old');
  function link(dir) {
    npm('install', '-g', '--install-links=false', '--ignore-scripts', '--no-audit', '--no-fund', dir);
    assert.ok(fs.lstatSync(root).isSymbolicLink(), 'npm created an actual global link');
  }
  function guided(extra = {}) {
    const result = run([entry, '--connect', 'fixture-service=http://127.0.0.1:1', '--client', 'codex', '--no-prompt'],
      { PATH: binRoot + path.delimiter + process.env.PATH, AIFY_INSTALL_WRAPPER_SOURCE: desired, ...extra });
    assert.equal(result.status, 78, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.existsSync(registry), false);
    return result.stdout + result.stderr;
  }
  return { home, desired, old, install, link, guided, root, marker, binRoot };
}

test('guided bootstrap replaces an owned stale global even when the version and manifest match', t => {
  const f = fixture(t);
  f.install(f.old);
  assert.equal(f.marker(), f.marker(f.old));
  const log = f.guided();
  assert.equal(f.marker(), f.marker(f.desired), `the stale package was silently reused:\n${log}`);
  assert.match(log, /lacks lib[\\/]connect-http\.mjs/, 'the verified package reached the wrapper interface check');
  const onDisk = fs.statSync(path.join(f.root, markerFile)).mtimeMs;
  assert.doesNotMatch(f.guided(), /installing aify-wrapper/, 'an exact npm-owned package is reused');
  assert.equal(fs.statSync(path.join(f.root, markerFile)).mtimeMs, onDisk);
});

test('a fresh override is packed and installed as a real global package', t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.root), false);
  assert.match(f.guided(), /lacks lib[\\/]connect-http\.mjs/);
  assert.equal(fs.lstatSync(f.root).isSymbolicLink(), false, 'npm must not link a local source directory');
  assert.equal(f.marker(), f.marker(f.desired));
});

test('npm success does not admit payload bytes that fail readback', t => {
  const f = fixture(t);
  const probe = path.join(f.home, 'post-install-change.mjs');
  const marker = path.join(f.root, markerFile);
  fs.writeFileSync(probe, `
import fs from 'node:fs';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('aify-env-install.mjs')) {
  const spawn = child.spawnSync;
  child.spawnSync = (file, args, options) => {
    const result = spawn(file, args, options);
    if (result.status === 0 && args.includes('install') && args.includes('-g')) fs.appendFileSync(${JSON.stringify(marker)}, '// wrong payload');
    return result;
  };
  syncBuiltinESMExports();
}
`);
  const log = f.guided({ NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` });
  assert.match(f.marker(), /wrong payload$/, 'the private intervention ran after real npm success');
  assert.match(log, /installed bytes do not match/);
  assert.doesNotMatch(log, /lacks lib/);
});

test('guided bootstrap reuses a matching npm link under an aliased prefix', t => {
  const f = fixture(t, { linkedPrefix: true });
  f.link(f.desired);
  // A checkout can contain files npm does not ship. They are not part of the wrapper payload.
  fs.writeFileSync(path.join(f.desired, '.npmignore'), 'workspace-only\n');
  fs.writeFileSync(path.join(f.desired, 'workspace-only'), 'checkout data');
  const target = fs.realpathSync(f.root);
  const log = f.guided();
  assert.match(log, /lacks lib[\\/]connect-http\.mjs/, 'matching linked wrapper reached the interface check');
  assert.doesNotMatch(log, /installing aify-wrapper/);
  assert.ok(fs.lstatSync(f.root).isSymbolicLink());
  assert.equal(fs.realpathSync(f.root), target);
  assert.equal(f.marker(), f.marker(f.desired));
  assert.equal(fs.readFileSync(path.join(target, 'workspace-only'), 'utf8'), 'checkout data');
});

test('guided bootstrap refuses a stale npm link and names the checkout to update', t => {
  const f = fixture(t);
  f.link(f.old);
  const target = fs.realpathSync(f.root);
  const bytes = f.marker(f.old);
  const pin = pinnedWrapperSource().split('#')[1];
  const log = f.guided({ AIFY_INSTALL_WRAPPER_SOURCE: '' });
  assert.match(log, /linked payload does not match/);
  assert.ok(log.includes(`update the checkout at ${target} to ${pin} and run npm install there, then rerun`), log);
  assert.doesNotMatch(log, /installing aify-wrapper/);
  assert.ok(fs.lstatSync(f.root).isSymbolicLink());
  assert.equal(fs.realpathSync(f.root), target);
  assert.equal(f.marker(f.old), bytes);
});

for (const kind of ['plain', 'altered-bin', 'shadowed']) {
  test(`guided bootstrap leaves a ${kind} wrapper untouched`, t => {
    const f = fixture(t);
    let extra = {};
    const before = f.marker(f.old);
    if (kind === 'plain') {
      fs.cpSync(f.old, f.root, { recursive: true });
    } else {
      f.install(f.old);
      const name = windows ? `${bin}.cmd` : bin;
      if (kind === 'altered-bin') {
        const launcher = path.join(f.binRoot, name);
        fs.unlinkSync(launcher);
        fs.writeFileSync(launcher, 'not an npm launcher');
      } else {
        fs.writeFileSync(path.join(f.home, name), 'another wrapper', { mode: 0o755 });
        extra = { PATH: f.home + path.delimiter + process.env.PATH };
      }
    }
    const log = f.guided(extra);
    const refusal = { plain: /npm bin .* is missing/, 'altered-bin': /npm bin .* does not (?:match|link)/,
      shadowed: / shadows npm bin / }[kind];
    assert.match(log, refusal, log);
    assert.ok(log.includes(f.root), 'refusal must name the package path');
    assert.equal(f.marker(), before, 'the refused package has the exact original bytes');
    assert.equal(fs.lstatSync(f.root).isSymbolicLink(), kind === 'linked');
    assert.doesNotMatch(log, /installing aify-wrapper/);
  });
}
