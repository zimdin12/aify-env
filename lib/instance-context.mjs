// Inert instance policy. Reading a context performs no writes, networking or process operations.
import fs from 'node:fs';
import path from 'node:path';
import { daemonArgs } from './usage.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = ['version', 'invocation', 'scope', 'root', 'processRecord', 'serviceRegistry',
  'ownerEndpoint', 'readinessEndpoint', 'herdrApiEndpoint', 'profileRef', 'takeover', 'recovery'];
export function contextError(reason) { return new Error(`instance_context: ${reason}`); }

/** A dedicated invocation is a daemon option, never a subcommand or forwarded child option. */
export function instanceContextArgument(args) {
  args = daemonArgs(args);
  const flags = args.filter(arg => arg.startsWith('--instance-context'));
  if (!flags.length) return null;
  const at = args.indexOf('--instance-context');
  if (flags.length !== 1 || at < 0 || args.includes('--force') || !args[0].startsWith('-')) {
    throw contextError('invalid option combination');
  }
  const file = args[at + 1];
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw contextError('absolute context path required');
  return file;
}

/** Reject links at every existing component, including junctions and multiply-linked files. */
function checkedPath(file, io) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')
      || file.split(/[\\/]/).includes('..')) throw contextError('invalid path');
  let current = path.resolve(file);
  while (true) {
    let stat;
    try { stat = io.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw contextError('path unreadable');
    }
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink !== 1)) throw contextError('linked path');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return path.resolve(file);
}

/** The launcher creates this exact private layout. Old records are never recovery inputs. */
export function readInstanceContext(file, { io = fs, platform = process.platform } = {}) {
  try {
    const contextFile = checkedPath(file, io);
    const c = JSON.parse(io.readFileSync(contextFile, 'utf8'));
    if (!c || Array.isArray(c) || Object.keys(c).length !== FIELDS.length
        || FIELDS.some(key => !Object.hasOwn(c, key))) throw contextError('unsupported fields');
    if (c.version !== 1 || !UUID.test(c.invocation) || c.scope !== `herdr-${c.invocation}`
        || c.takeover !== 'refuse' || c.recovery !== 'none'
        || typeof c.profileRef !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c.profileRef)) {
      throw contextError('invalid identity or policy');
    }
    const root = checkedPath(c.root, io);
    if (path.basename(root) !== c.invocation || path.basename(path.dirname(root)) !== 'invocations'
        || contextFile !== path.join(root, 'instance.json') || !io.statSync(root).isDirectory()) {
      throw contextError('private invocation root required');
    }
    for (const [key, name] of Object.entries({ processRecord: 'owned-processes.json', serviceRegistry: 'services.json', readinessEndpoint: 'ready.json' })) {
      if (checkedPath(c[key], io) !== path.join(root, name)) throw contextError(`private ${key} required`);
    }
    for (const [key, name] of Object.entries({ ownerEndpoint: 'owner', herdrApiEndpoint: 'api' })) {
      const expected = platform === 'win32' ? `\\\\.\\pipe\\aify-herdr-${name}-${c.invocation}`
        : path.join(root, name === 'api' ? 'herdr.sock' : 'owner.sock');
      if (c[key] !== expected) throw contextError(`unknown ${key}`);
      if (platform !== 'win32') checkedPath(c[key], io);
    }
    for (const target of [c.processRecord, c.readinessEndpoint, path.join(root, 'claimed.json')]) {
      checkedPath(target, io);
      if (io.existsSync(target)) throw contextError('invocation already used');
    }
    return Object.freeze(c);
  } catch (error) {
    if (error.message.startsWith('instance_context:')) throw error;
    throw contextError('cannot read valid context');
  }
}

/** Facts only. Service-connected advertisement remains blocked until its scoped contract exists. */
export function instanceAdvertisement(base, context) {
  return { ...base, metadata: { ...base.metadata, scope: context.scope, invocation: context.invocation } };
}
