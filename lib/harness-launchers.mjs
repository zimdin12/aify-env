// Launcher inventory is a transform of already-read file facts. Never execute a launcher to identify it.
import { HARNESS_FACTS } from './agent-definition-schema.mjs';
import { markerOf } from './allowlist.mjs';
const SUFFIX = '-aify';

/** Known canonical installations and unknown marked names remain distinct observations. */
export function harnessLauncherInventory(entries = [], { manifestStatus = () => ({ state: 'unknown', reason: 'manifest not observed' }) } = {}) {
  const known = new Map(), unknown = new Map();
  for (const entry of entries ?? []) {
    const file = String(entry?.file ?? ''), base = file.split(/[\\/]/).pop() ?? '';
    const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base;
    if (!stem.endsWith(SUFFIX) || markerOf(entry?.text) === null) continue;
    const client = stem.slice(0, -SUFFIX.length);
    if (!client) continue;
    const matched = Object.entries(HARNESS_FACTS).find(([name, facts]) => name === client || facts.aliases.includes(client));
    if (!matched) {
      if (!unknown.has(client)) unknown.set(client, { client, command: stem, found: true, path: file,
        reason: "installed but not in this aify-env's harness table" });
      continue;
    }
    const [name, capabilities] = matched;
    if (!known.has(name)) {
      const observation = manifestStatus(name);
      known.set(name, { client: name, command: stem, found: true, path: file, capabilities,
        screen: observation?.state === 'loaded' ? { state: 'loaded', reason: '' }
          : { state: 'unknown', reason: String(observation?.reason || 'manifest not observed') } });
    }
  }
  const ordered = map => [...map.values()].sort((a, b) => a.client.localeCompare(b.client));
  return { known: ordered(known), unknown: ordered(unknown) };
}

/** Compatibility array of known marked launchers; screen capability remains a separate inventory fact. */
export function installedHarnesses(entries = []) {
  return harnessLauncherInventory(entries).known.map(({ screen, capabilities, ...launcher }) => launcher);
}
