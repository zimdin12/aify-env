// The credential store has one admission sequence. The two drivers supply only the IO.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { CREDENTIAL_INSECURE, CREDENTIAL_MISSING, CREDENTIAL_UNREADABLE, MAX_CREDENTIAL_BYTES, decodeCredential } from './credential-store.mjs';
import { aclProblem, parseIcaclsAces } from './windows-acl.mjs';

const execAsync = promisify(execFile);
const fault = (state, detail) => ({ state, value: '', detail, identity: '' });

export function currentWindowsOwner(env = process.env) {
  const user = String(env.USERNAME || '').trim();
  const domain = String(env.USERDOMAIN || '').trim();
  return user ? domain ? `${domain}\\${user}` : user : '';
}

function icaclsPath() {
  const { SystemRoot, SYSTEMROOT, windir, WINDIR } = process.env;
  const root = SystemRoot || SYSTEMROOT || windir || WINDIR || '';
  return path.isAbsolute(root) ? path.join(root, 'System32', 'icacls.exe') : '';
}

export async function readAcl(target, run = execAsync) {
  // Injected collectors use a symbolic command name; the runtime collector never searches PATH.
  const command = run === execAsync ? icaclsPath() : 'icacls';
  if (!command) return '';
  try { return String((await run(command, [target], { windowsHide: true }))?.stdout || ''); }
  catch { return ''; } // A failed helper has not supplied a complete ACL, even with stdout.
}

function readAclSync(target, run = execFileSync) {
  const command = run === execFileSync ? icaclsPath() : 'icacls';
  if (!command) return '';
  // Preserve the synchronous bridge's existing helper budget; this is not a request or hook timeout.
  try { return String(run(command, [target], { encoding: 'utf8', windowsHide: true, timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'] }) || ''); }
  catch { return ''; }
}

function regularFileProblem(stats) {
  if (!stats) return 'no file information';
  if (stats.isSymbolicLink()) return 'is a link rather than a regular file';
  if (!stats.isFile()) return 'is not a regular file';
  if (stats.size > MAX_CREDENTIAL_BYTES) return `is ${stats.size} bytes, over the ${MAX_CREDENTIAL_BYTES} limit`;
  return '';
}

export function fileSecurityProblem({ platform = process.platform, stats = null, aclText = '', owner = '', uid = -1, aclPath = '' } = {}) {
  const structural = regularFileProblem(stats);
  if (structural) return structural;
  if (platform === 'win32') return aclProblem(parseIcaclsAces(aclText, { path: aclPath }), { owner });
  if (stats.nlink > 1) return `has ${stats.nlink} hard links, so the same bytes are reachable under another name`;
  if (uid >= 0 && Number(stats.uid) !== uid) return `is owned by uid ${stats.uid}, not by this process`;
  const mode = Number(stats.mode) & 0o777;
  return mode & 0o077 ? `mode ${mode.toString(8).padStart(3, '0')} grants access beyond its owner` : '';
}

const FILE_FACTS = ['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'ctimeNs', 'mtimeNs'];
function sameFile(a, b) {
  return a.ino > 0n && b?.isFile() && FILE_FACTS.every(key => a[key] === b[key]);
}

function locationProblem(target, real, parent) {
  if (path.basename(real) !== path.basename(target)) return 'its resolved name differs only in case or is not the requested file';
  return path.dirname(real) === parent ? '' : 'resolves outside the directory it was looked up in';
}

const observations = { bigint: true };
function* inspect({ target, platform = process.platform, owner = '', uid, run, acl = null } = {}) {
  let initial;
  try { initial = yield ['lstat', target]; }
  catch (error) {
    return error?.code === 'ENOENT' ? fault(CREDENTIAL_MISSING, 'does not exist')
      : fault(CREDENTIAL_UNREADABLE, 'could not inspect the credential file');
  }
  const structural = regularFileProblem(initial);
  if (structural) return fault(CREDENTIAL_INSECURE, structural);
  let file;
  try {
    const real = yield ['realpath', target];
    const parent = yield ['realpath', path.dirname(target)];
    const location = locationProblem(target, real, parent);
    if (location) return fault(CREDENTIAL_INSECURE, location);
    const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0
      : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    file = yield ['open', target, flags];
    if (!sameFile(initial, yield ['stat', file])) return fault(CREDENTIAL_INSECURE, 'credential file changed while opening');

    const aclText = platform === 'win32' ? yield ['acl', target, run, acl, initial] : '';
    const problem = fileSecurityProblem({ platform, stats: initial, aclText, aclPath: target,
      owner: owner || currentWindowsOwner(), uid: uid ?? (process.getuid?.() ?? -1) });
    if (problem) return fault(CREDENTIAL_INSECURE, problem);
    if (!sameFile(initial, yield ['lstat', target])) return fault(CREDENTIAL_INSECURE, 'credential file changed during custody check');

    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = yield ['read', file, bytes, length];
      if (!read) break;
      length += read;
    }
    // Open once, read that descriptor, and recheck both the descriptor and the recorded name.
    if (!sameFile(initial, yield ['stat', file]) || !sameFile(initial, yield ['lstat', target])
      || real !== (yield ['realpath', target])) return fault(CREDENTIAL_INSECURE, 'credential file changed while reading');
    const decoded = decodeCredential(bytes.subarray(0, length));
    return { ...decoded, identity: `${initial.dev}:${initial.ino}:${initial.size}:${initial.mtimeNs}` };
  } catch {
    return fault(CREDENTIAL_UNREADABLE, 'could not read the checked credential file');
  } finally {
    if (file !== undefined) {
      try { yield ['close', file]; } catch { /* Closing does not authorize another read. */ }
    }
  }
}

const sync = {
  lstat: target => fs.lstatSync(target, observations), realpath: fs.realpathSync.native,
  open: (target, flags) => fs.openSync(target, flags), stat: fd => fs.fstatSync(fd, observations),
  read: (fd, bytes, n) => fs.readSync(fd, bytes, n, bytes.length - n, n), close: fs.closeSync,
  acl: (target, run) => readAclSync(target, run),
};
const asynchronous = {
  lstat: target => fsp.lstat(target, observations), realpath: promisify(fs.realpath.native),
  open: (target, flags) => fsp.open(target, flags), stat: file => file.stat(observations),
  read: async (file, bytes, n) => (await file.read(bytes, n, bytes.length - n, n)).bytesRead, close: file => file.close(),
  acl: (target, run, cache, stats) => cache
    ? cache.read(target, { dev: stats.dev, ino: stats.ino, ctimeMs: Number(stats.ctimeNs) / 1e6 }) : readAcl(target, run),
};

export function inspectCredentialFileSync(options) {
  const flow = inspect(options);
  let step = flow.next();
  while (!step.done) {
    const [op, ...args] = step.value;
    let result;
    try { result = sync[op](...args); }
    catch (error) { step = flow.throw(error); continue; }
    step = flow.next(result);
  }
  return step.value;
}

export async function inspectCredentialFile(options) {
  const flow = inspect(options);
  let step = flow.next();
  while (!step.done) {
    const [op, ...args] = step.value;
    let result;
    try { result = await asynchronous[op](...args); }
    catch (error) { step = flow.throw(error); continue; }
    step = flow.next(result);
  }
  return step.value;
}
