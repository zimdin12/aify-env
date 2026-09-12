// Dedicated bootstrap I/O, separate from the inert context parser and the standalone daemon.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { contextError, readInstanceContext } from './instance-context.mjs';

export async function prepareInstance(file, env) {
  const context = readInstanceContext(file);
  // ADVERTISING IS NO LONGER REFUSED HERE. This required `AIFY_ADVERTISE=0`, which made a dedicated
  // instance invisible to the service: it described no runtimes, so the host it was running on looked
  // like it had none, and nothing it started could be reached. The operator's ruling, 2026-09-12: "it
  // should act same way as outside of herdr, but in this case it knows it is inside herdr and can
  // control herdr". So an instance context now means exactly two things -- this daemon's lifetime is
  // bound to a Herdr it can drive, and its invocation is single-use -- and NOT that it is a lesser
  // environment. Supersession still arbitrates two environments for one host, exactly as it does for
  // two ordinary aify-envs: starting this reaps the predecessor's managed workers, which is the same
  // cost as starting aify-env by hand and is the operator's to spend.
  requireReadableRegistry(context);
  await authorizeOwner(context);
  // Synchronous admission boundary after the last bootstrap I/O await: recheck
  // context and registry before returning to the caller's Runner construction.
  // This is not an atomic filesystem transaction against later external edits.
  const current = readInstanceContext(file);
  if (Object.keys(context).some(key => context[key] !== current[key])) throw contextError('context changed');
  requireReadableRegistry(current);
  return current;
}

/**
 * The registry a dedicated instance may run with.
 *
 * IT USED TO REFUSE ANY SERVICE AT ALL (`scoped_service_contract_required`), and that refusal was
 * load-bearing for a real reason: an instance that could reach a service could present itself as
 * THIS MACHINE'S environment, and supersession is arbitrated on that -- so a throwaway Herdr would
 * displace the aify-env actually serving the host and reap its managed workers.
 *
 * WHAT REPLACES IT IS AN ENFORCEMENT RATHER THAN AN ABSENCE. The operator's ruling, 2026-09-12: "it
 * is same env. just herdr is management helper basically" -- so a dedicated instance reads the
 * host's registry and offers its capabilities locally, while `claimsHostWork` (bin/aify-env.mjs,
 * keyed on this very instance context) keeps its plugins from heartbeating, claiming or running the
 * host's work. An empty registry was never the property that mattered; not taking the host's work
 * is, and that one is now checked where it happens instead of being approximated here.
 *
 * THE SHAPE IS STILL REFUSED, because a registry this daemon cannot read is a registry whose
 * contents it would be guessing at.
 */
function requireReadableRegistry(context) {
  let registry;
  try { registry = JSON.parse(fs.readFileSync(context.serviceRegistry, 'utf8')); }
  catch { throw contextError('readable service registry required'); }
  if (registry?.version !== 1 || !registry.services || typeof registry.services !== 'object'
      || Array.isArray(registry.services)) throw contextError('readable service registry required');
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
