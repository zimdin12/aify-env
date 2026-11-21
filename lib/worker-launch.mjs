// Host-side worker composition. A caller owns its launch facts; this module owns how they become a Runner spec.
import { rootsNow } from './workspace-roots.mjs';
import { spawnEnvFor } from './spawn-env.mjs';

// An overlay cannot unset CLAUDE_CODE_CHILD_SESSION, whose presence disables transcript saving.
// The service supplies the unset list; the host keeps no copy and matches without case because Windows does.
export function launchEnv(baseEnv = {}, launch = {}) {
  const unset = new Set((Array.isArray(launch?.unsetEnv) ? launch.unsetEnv : [])
    .filter(name => typeof name === 'string').map(name => name.toUpperCase()));
  const kept = Object.fromEntries(Object.entries(baseEnv || {}).filter(([name]) => !unset.has(name.toUpperCase())));
  return { ...kept, ...(launch?.env && typeof launch.env === 'object' ? launch.env : {}) };
}

// Start with the host environment, lay the service's values over it, then ask contributors for the bound definition.
// Reversing the first two steps lets inherited values override the launch's choices. Do this before taking the birth lock.
export function preparedEnv({ launch, baseEnv, spawnEnv = () => [], definitionFor = null, windows }) {
  return spawnEnvFor({ launch, env: launchEnv(baseEnv, launch), contributors: spawnEnv(), definitionFor, windows });
}

// The service names a program; the host finds the file. Every candidate goes through buildSpec, so the allowlist stays the sole judge.
// Keep each rejected file and its reason: an unreadable launcher and a disallowed one call for different fixes.
export function resolveWorkerSpec({ service, argv, cwd, env, label }, { buildSpec, resolveCandidates }) {
  const rejected = [];
  for (const launcher of resolveCandidates(argv[0])) {
    const attempt = buildSpec({ service, launcher, args: argv.slice(1), cwd, env, label });
    if (!attempt.error) return { built: attempt };
    rejected.push({ launcher, detail: attempt.error.detail });
  }
  return { rejected };
}

export const outsideRootsDetail = cwd => `Workspace "${cwd}" is outside this environment's advertised roots`;

// A definition-bound launch needs a plain env map: the builder's “no env means inherit” fallback would lose its definition's variables.
// Empty argv is a refusal, not permission to split the service's shell command into arguments.
export function prepareRemoteSpec({ service, launch, terminalId, cwdRoots, windows, withinRoots, buildSpec, resolveCandidates, env }) {
  if (launch?.definition && (env === null || typeof env !== 'object' || Array.isArray(env))) {
    return { detail: 'this launch binds a definition and carries no prepared environment, so it is not started' };
  }
  const argv = Array.isArray(launch.argv) ? launch.argv.filter(part => typeof part === 'string') : [];
  const cwd = String(launch.cwd || '');
  if (!withinRoots(cwd, cwdRoots, { windows })) return { detail: outsideRootsDetail(cwd), rootRefusal: true };
  if (!argv.length) {
    return { detail: `Terminal "${terminalId}" carries no argv, only a command string, so this host cannot run it without splitting a shell string` };
  }
  const attempt = resolveWorkerSpec({ service, argv, cwd, env, label: String(launch.agentId || terminalId) },
    { buildSpec, resolveCandidates });
  if (attempt.built) return attempt;
  if (!attempt.rejected.length) return { detail: `"${argv[0]}" does not resolve to a file on this host` };
  const reasons = attempt.rejected.map(({ launcher, detail }) => `${launcher}: ${detail}`).join('; ');
  return { detail: `no launcher for "${argv[0]}" could be run — ${reasons}`, launcherRefusal: true };
}

/** Remote unsetEnv remains authoritative; the local inherited-session exclusions do not apply here. */
export async function composeRemoteLaunch(options) {
  const added = await preparedEnv(options);
  if (added.refused) return added;
  return prepareRemoteSpec({ ...options, cwdRoots: await rootsNow(options.cwdRoots), env: added.env });
}
