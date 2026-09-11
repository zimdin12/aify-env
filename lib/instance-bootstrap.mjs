// Dedicated bootstrap I/O, separate from the inert context parser and the standalone daemon.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { contextError, readInstanceContext } from './instance-context.mjs';

export async function prepareInstance(file, env) {
  const context = readInstanceContext(file);
  if (env.AIFY_ADVERTISE !== '0') throw contextError('advertisement must be explicitly disabled');
  requireEmptyRegistry(context);
  await authorizeOwner(context);
  // Synchronous admission boundary after the last bootstrap I/O await: recheck
  // context and registry before returning to the caller's Runner construction.
  // This is not an atomic filesystem transaction against later external edits.
  const current = readInstanceContext(file);
  if (Object.keys(context).some(key => context[key] !== current[key])) throw contextError('context changed');
  requireEmptyRegistry(current);
  return current;
}

function requireEmptyRegistry(context) {
  let registry;
  try { registry = JSON.parse(fs.readFileSync(context.serviceRegistry, 'utf8')); }
  catch { throw contextError('explicit empty registry required'); }
  if (registry?.version !== 1 || !registry.services || typeof registry.services !== 'object'
      || Array.isArray(registry.services)) throw contextError('explicit empty registry required');
  if (Object.keys(registry.services).length) throw new Error('scoped_service_contract_required');
}

/** A health response cannot authorize ownership. The private owner must echo this fresh challenge. */
async function authorizeOwner(context) {
  const challenge = { version: 1, operation: 'authorize-env', invocation: context.invocation,
    scope: context.scope, nonce: randomUUID() };
  await new Promise((resolve, reject) => {
    const socket = net.connect(context.ownerEndpoint); let text = ''; let done = false;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      error ? reject(contextError('owner authorization refused')) : resolve();
    };
    const timer = setTimeout(() => finish(true), 2000);
    socket.on('error', () => finish(true)); socket.on('end', () => finish(true));
    socket.on('connect', () => socket.write(JSON.stringify(challenge) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 4096) return finish(true);
      if (!text.includes('\n')) return;
      try {
        const reply = JSON.parse(text.split('\n')[0]);
        finish(reply.accepted !== true || Object.keys(challenge).some(key => reply[key] !== challenge[key]));
      } catch { finish(true); }
    });
  });
}

/** Synchronous exclusive creation after bind, before requests or readiness can be served. */
export function publishInstanceReady(context, { pid, envInstance, port, build }) {
  const receipt = { version: 1, invocation: context.invocation, scope: context.scope,
    pid, envInstance, build, endpoint: `http://127.0.0.1:${port}`,
    state: 'transport-ready', serviceConnected: false };
  try {
    fs.writeFileSync(path.join(context.root, 'claimed.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(context.processRecord, '[]\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(context.readinessEndpoint, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { throw contextError('invocation already used or private receipt unavailable'); }
  return receipt;
}
