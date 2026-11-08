// The installed wrapper or an explicit grant supplies record validators, never a consumer queue API.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { globalNpmRoot } from '../../install-chain-host.mjs';

export function activityGrant(config) {
  const activity = config?.activity;
  if (activity === undefined) return {};
  if (activity?.enabled === false) return null;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity) || activity.enabled !== true) throw new Error('configuration');
  for (const key of ['leaseDirectory', 'wrapperCheckout']) {
    if (typeof activity[key] !== 'string' || !path.isAbsolute(activity[key])) throw new Error('configuration');
  }
  return activity;
}

/**
 * Optional producer bounds from a grant. Enablement stays with the wrapper, never this contribution. PURE.
 */
export function activityLaunchEnv(grant) {
  const env = {};
  for (const [field, key] of Object.entries({ sessionBytes: 'AIFY_ACTIVITY_SESSION_BYTES', maxSessions: 'AIFY_ACTIVITY_MAX_SESSIONS', maxAgeMs: 'AIFY_ACTIVITY_MAX_AGE_MS' })) {
    if (grant[field] !== undefined) env[key] = String(grant[field]);
  }
  return env;
}

// Admission is for cooperating local writers, not hostile concurrent ancestor replacement.
export function existingDirectory(directory) {
  let current = directory;
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe-directory');
    const parent = path.dirname(current); if (parent === current) return true; current = parent;
  }
}

export async function wrapperActivity(grant) {
  let checkout = grant.wrapperCheckout;
  if (!checkout) {
    const root = globalNpmRoot();
    if (!path.isAbsolute(root)) throw new Error('wrapper-checkout');
    checkout = fs.realpathSync(path.join(root, 'aify-wrapper'));
  }
  if (!existingDirectory(checkout)) throw new Error('wrapper-checkout');
  const load = async name => {
    const file = path.join(checkout, 'lib', name);
    if (!existingDirectory(path.dirname(file))) throw new Error('wrapper-checkout');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('wrapper-checkout');
    return import(pathToFileURL(file).href);
  };
  const adapter = await load('file-activity.mjs');

  const { enabled: _enabled, ...policy } = adapter.activityConfiguration({ ...process.env, ...activityLaunchEnv(grant) });
  if (typeof adapter.validActivityRecord !== 'function' || typeof adapter.safeAgentId !== 'function') throw new Error('wrapper-validator');
  const leaseDirectory = grant.leaseDirectory ?? (await load('agent-lease.mjs')).leaseDirectory();
  if (typeof leaseDirectory !== 'string' || !path.isAbsolute(leaseDirectory)) throw new Error('lease-directory');
  return { validRecord: adapter.validActivityRecord, safeAgentId: adapter.safeAgentId, policy, leaseDirectory };
}

export function activityDirectories(leaseDirectory, safeAgentId) {
  if (!existingDirectory(leaseDirectory)) return [];
  const roots = [];
  for (const entry of fs.readdirSync(leaseDirectory, { withFileTypes: true })) {
    if (!safeAgentId(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('unsafe-directory');
    // Lease records are regular files beside the agent folders. Never open them.
    if (entry.isFile()) continue;
    const agent = path.join(leaseDirectory, entry.name);
    if (!existingDirectory(agent)) continue;
    const directory = path.join(agent, 'activity-v2');
    if (!existingDirectory(directory)) continue;

    roots.push({ directory, agentId: entry.name });
  }
  return roots.sort((a, b) => a.agentId.localeCompare(b.agentId));
}
