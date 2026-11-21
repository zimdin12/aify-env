import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './interpreter.mjs';

const NAME = 'aify-wrapper';
const WINDOWS = process.platform === 'win32';
const SHIM_SUFFIXES = ['', '.cmd', '.ps1'];
const require = createRequire(import.meta.url);

function stat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function samePath(a, b) {
  return path.relative(a, b) === '';
}

function requireDirectory(file, optional = false) {
  const s = stat(file);
  if (!s && optional) return;
  if (s?.isSymbolicLink()) throw new Error(`${file} is linked`);
  if (!s?.isDirectory()) throw new Error(`${file} is not a real directory`);
}

function readBins(root) {
  const file = path.join(root, 'package.json');
  if (!stat(file)?.isFile()) throw new Error(`${file} is not a regular package manifest`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest?.name !== NAME || !manifest.bin || Array.isArray(manifest.bin) || typeof manifest.bin !== 'object') {
    throw new Error(`${file} does not declare ${NAME} and its bin map`);
  }
  const bins = new Map(Object.entries(manifest.bin));
  if (!bins.size) throw new Error(`${file} declares no npm bins`);
  for (const [name, file] of bins) {
    const parts = typeof file === 'string' ? file.replace(/^\.\//, '').split('/') : [];
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || !parts.length || parts.some(part => !/^[a-z0-9_-][a-z0-9_.-]*$/i.test(part))) {
      throw new Error(`${root} declares an invalid npm bin ${JSON.stringify(name)}`);
    }
    for (let i = 1; i < parts.length; i++) requireDirectory(path.join(root, ...parts.slice(0, i)));
    if (!stat(path.join(root, ...parts))?.isFile()) throw new Error(`${root} declares npm bin ${name} without a regular target`);
    bins.set(name, parts.join('/'));
  }
  return bins;
}

/** Hash names and bytes of the npm payload, not npm's generated dependency tree, timestamps or modes. */
export function wrapperPayloadDigest(root) {
  function walk(dir, prefix = '') {
    const rows = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (!prefix && name === 'node_modules') continue;
      const file = path.join(dir, name), relative = prefix + name;
      const s = stat(file);
      if (s?.isDirectory()) rows.push(...walk(file, relative + '/'));
      else if (s?.isFile()) rows.push([relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
      else throw new Error(`${file} is not a regular ${NAME} payload entry`);
    }
    return rows;
  }
  return createHash('sha256').update(JSON.stringify(walk(root))).digest('hex');
}

function npmTool(env) {
  // Keep paths as argv on Windows as well. npm.cmd is a shell script; never pass a package spec through cmd.exe.
  const shim = WINDOWS ? resolveExecutable('npm.cmd', { pathValue: env.PATH, pathExt: [''] }) : '';
  const npmRoot = WINDOWS ? path.join(path.dirname(shim), 'node_modules', 'npm') : '';
  const cli = path.join(npmRoot, 'bin', 'npm-cli.js');
  if (WINDOWS && (!path.isAbsolute(shim) || !stat(cli)?.isFile())) {
    throw new Error(`could not find the npm CLI beside ${shim}; put the Node installation's npm.cmd first on PATH`);
  }
  return {
    run: (args, { cwd, inherit = false } = {}) => {
      const result = spawnSync(WINDOWS ? process.execPath : 'npm', WINDOWS ? [cli, ...args] : args, {
        env, cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      if (result.status !== 0) throw new Error(`npm ${args[0]} did not complete (${result.error?.code || result.status})`);
      return result.stdout;
    },
    cmdShim: () => require(path.join(npmRoot, 'node_modules', 'cmd-shim')),
  };
}

function globalLayout(npm) {
  const selected = npm.run(['prefix', '-g']).trim();
  const reported = npm.run(['root', '-g']).trim();
  const modulesPath = WINDOWS ? 'node_modules' : path.join('lib', 'node_modules');
  if (!path.isAbsolute(selected) || !path.isAbsolute(reported) || /[\r\n\0]/.test(selected + reported)
      || !samePath(reported, path.join(selected, modulesPath))) {
    throw new Error(`npm reports an ambiguous global root ${JSON.stringify(reported)} for prefix ${JSON.stringify(selected)}; select one npm global prefix`);
  }
  // The selected prefix may be an alias to the active Node version. Package and bin directories still must agree.
  const prefix = stat(selected)?.isSymbolicLink() ? fs.realpathSync(selected) : selected;
  const modules = path.join(prefix, modulesPath);
  const bin = WINDOWS ? prefix : path.join(prefix, 'bin');
  for (const dir of new Set([prefix, path.dirname(modules), modules, bin])) requireDirectory(dir, true);
  return { prefix, root: path.join(modules, NAME), bin };
}

function suffixes(env) {
  if (!WINDOWS) return [''];
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(ext => /^\.[a-z0-9]+$/.test(ext));
  return [...new Set([...SHIM_SUFFIXES, ...extensions])];
}

function refuseShadow(name, bin, env) {
  if (typeof env.PATH !== 'string') throw new Error('PATH is absent');
  const dirs = env.PATH.split(path.delimiter);
  if (WINDOWS) dirs.unshift(process.cwd()); // cmd.exe can search the working directory before PATH.
  for (const dir of dirs) {
    const absolute = path.resolve(WINDOWS ? dir.replace(/^"(.*)"$/, '$1') : dir);
    if (samePath(absolute, bin)) return;
    for (const ext of suffixes(env)) {
      const candidate = path.join(absolute, name + ext);
      if (!stat(candidate)) continue;
      if (stat(bin) && samePath(fs.realpathSync(absolute), fs.realpathSync(bin))) return;
      throw new Error(`${candidate} shadows npm bin ${path.join(bin, name)}; move it later on PATH`);
    }
  }
}

async function verifyNpmBin(name, target, layout, npm, scratch, env) {
  const launcher = path.join(layout.bin, name);
  if (!WINDOWS) {
    if (!stat(launcher)?.isSymbolicLink() || fs.readlinkSync(launcher) !== path.relative(layout.bin, target)) {
      throw new Error(`npm bin ${launcher} is missing or does not link to ${target}`);
    }
    return;
  }
  const relative = path.relative(layout.bin, target);
  const staged = path.join(scratch, relative), shim = path.join(scratch, name);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.copyFileSync(target, staged);
  await npm.cmdShim()(staged, shim);
  for (const ext of suffixes(env)) {
    const actual = launcher + ext;
    if (SHIM_SUFFIXES.includes(ext)) {
      if (stat(actual)?.isFile() && fs.readFileSync(actual).equals(fs.readFileSync(shim + ext))) continue;
      throw new Error(`npm bin ${actual} is missing or does not match npm's shim for ${target}`);
    }
    if (stat(actual)) throw new Error(`npm bin ${actual} collides with npm's shim for ${target}`);
  }
}

async function inspect(layout, npm, scratch, env, root = layout.root) {
  if (!stat(root)) return new Map();
  requireDirectory(root);
  const bins = readBins(root);
  for (const [name, target] of bins) {
    await verifyNpmBin(name, path.join(layout.root, target), layout, npm, scratch, env);
    refuseShadow(name, layout.bin, env);
  }
  return bins;
}

/** Pack the selected source into a private directory and read the payload npm will install. */
export function packWrapper({ source, scratch, env = process.env, npm = npmTool(env) }) {
  // Run pack from the caller's directory: an explicit relative source is relative to that directory.
  const reports = JSON.parse(npm.run(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch, '--', source]));
  const [report] = reports;
  if (reports.length !== 1 || report?.name !== NAME || !/^aify-wrapper-[a-z0-9_.+-]+\.tgz$/i.test(report.filename)) {
    throw new Error(`npm did not produce one ${NAME} archive`);
  }
  const archive = path.join(scratch, report.filename);
  if (!stat(archive)?.isFile()) throw new Error(`npm did not write ${archive}`);
  const result = spawnSync('tar', ['-xf', report.filename], { cwd: scratch, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('tar could not read the private npm package; check that tar is installed');
  const root = path.join(scratch, 'package');
  requireDirectory(root);
  return { archive, bins: readBins(root), digest: wrapperPayloadDigest(root) };
}

function verifyNewNames(desired, installed, layout, env) {
  for (const name of desired.keys()) {
    if (installed.has(name)) continue;
    refuseShadow(name, layout.bin, env);
    for (const ext of suffixes(env)) {
      const file = path.join(layout.bin, name + ext);
      if (stat(file)) throw new Error(`npm bin ${file} is already occupied outside the installed ${NAME}`);
    }
  }
}

async function reuseLinked({ layout, npm, temp, env, source, pinnedDigest }) {
  const target = fs.realpathSync(layout.root);
  const revision = pinnedDigest ? ` to ${source.split('#').at(-1)}` : ` to match ${source}`;
  const repair = `update the checkout at ${target}${revision} and run npm install there, then rerun`;
  try {
    const linkedScratch = fs.mkdtempSync(path.join(temp, 'linked-'));
    const actual = packWrapper({ source: target, scratch: linkedScratch, env, npm }).digest;
    const expected = pinnedDigest ?? packWrapper({ source, scratch: temp, env, npm }).digest;
    if (actual !== expected) throw new Error('linked payload does not match the selected wrapper');
    if (!stat(layout.root)?.isSymbolicLink() || !samePath(fs.realpathSync(layout.root), target)) {
      throw new Error('the wrapper link changed during inspection');
    }
    const bins = await inspect(layout, npm, temp, env, target);
    if (!bins.size || !samePath(fs.realpathSync(layout.root), target)) throw new Error('the wrapper link changed during inspection');
    return { root: target };
  } catch (error) {
    return { problem: `${NAME} at ${layout.root}, linked to ${target}: ${error.message}; ${repair}` };
  }
}

/** Identify the selected global package before allowing the guided chain to load it. */
export async function ensureWrapper({ source, pinnedDigest, env = process.env, say = () => {} }) {
  let layout, temp;
  try {
    const npm = npmTool(env);
    layout = globalLayout(npm);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-wrapper-bootstrap-'));
    if (stat(layout.root)?.isSymbolicLink()) return await reuseLinked({ layout, npm, temp, env, source, pinnedDigest });
    const installed = await inspect(layout, npm, temp, env);
    const digest = installed.size ? wrapperPayloadDigest(layout.root) : null;
    if (digest && digest === pinnedDigest) return { root: layout.root };

    const desired = packWrapper({ source, scratch: temp, env, npm });
    if (pinnedDigest && desired.digest !== pinnedDigest) throw new Error('npm packed bytes do not match the recorded pin');
    const current = await inspect(layout, npm, temp, env);
    const currentDigest = current.size ? wrapperPayloadDigest(layout.root) : null;
    if (currentDigest !== digest) throw new Error('the global package changed while npm packed the source; rerun the guided install');
    if (currentDigest === desired.digest) return { root: layout.root };
    verifyNewNames(desired.bins, current, layout, env);
    say(`installing ${NAME} (${source})`);
    npm.run(['install', '-g', '--prefix', layout.prefix, '--bin-links', '--no-audit', '--no-fund', '--', desired.archive], { inherit: true });
    const after = await inspect(layout, npm, temp, env);
    if (!after.size || wrapperPayloadDigest(layout.root) !== desired.digest) {
      throw new Error('npm installed bytes do not match the selected package');
    }
    return { root: layout.root };
  } catch (error) {
    return { problem: `${NAME} at ${layout?.root ?? 'the selected npm global root'}: ${error.message}; correct that npm prefix or move the conflicting installation aside before rerunning` };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}
