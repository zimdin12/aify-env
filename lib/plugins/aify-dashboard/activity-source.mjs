// The explicit wrapper grant supplies the approved record validator, never a consumer queue API.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function activityGrant(config) {
  const activity = config?.activity;
  if (activity === undefined || activity?.enabled === false) return null;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity) || activity.enabled !== true) throw new Error('configuration');
  for (const key of ['leaseDirectory', 'wrapperCheckout']) {
    if (typeof activity[key] !== 'string' || !path.isAbsolute(activity[key])) throw new Error('configuration');
  }
  return activity;
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
  if (!existingDirectory(grant.wrapperCheckout)) throw new Error('wrapper-checkout');
  const load = async name => {
    const file = path.join(grant.wrapperCheckout, 'lib', name);
    if (!existingDirectory(path.dirname(file))) throw new Error('wrapper-checkout');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('wrapper-checkout');
    return import(pathToFileURL(file).href);
  };
  const adapter = await load('file-activity.mjs');

  const env = { AIFY_FILE_ACTIVITY: '1' };
  for (const [field, key] of Object.entries({ sessionBytes: 'AIFY_ACTIVITY_SESSION_BYTES', maxSessions: 'AIFY_ACTIVITY_MAX_SESSIONS', maxAgeMs: 'AIFY_ACTIVITY_MAX_AGE_MS' })) {
    if (grant[field] !== undefined) env[key] = String(grant[field]);
  }
  const { enabled: _enabled, ...policy } = adapter.activityConfiguration(env);
  if (typeof adapter.validActivityRecord !== 'function' || typeof adapter.safeAgentId !== 'function') throw new Error('wrapper-validator');
  return { validRecord: adapter.validActivityRecord, safeAgentId: adapter.safeAgentId, policy };
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
