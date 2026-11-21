import { readFileSync } from 'node:fs';
import { HARNESS_FACTS } from './agent-definition-schema.mjs';
import { launcherCandidates } from './launcher-resolve.mjs';
import { buildStartSpec } from './start-spec.mjs';
import { preparedEnv, resolveWorkerSpec } from './worker-launch.mjs';

// The local composer owns this boundary. It clears the wrapper's session markers,
// so the wrapper no longer knows to strip the other parent-session fields itself.
// The cross-repo coverage test holds this list to both peers' contracts.
export const LOCAL_START_NEVER_INHERITED = Object.freeze([
  'AIFY_AGENT_LEASE', 'AIFY_TERMINAL_ID', 'AIFY_SESSION_HANDLE', 'AIFY_HERMES_FRESH_CONTEXT',
  'AIFY_MANAGED_MODEL', 'AIFY_MANAGED_EFFORT', 'AIFY_MANAGED_VIA_WRAPPER',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'HERMES_SESSION', 'HERMES_SESSION_ID',
  'AIFY_DEFINITION_INCARNATION', 'AIFY_DEFINITION_REVISION', 'AIFY_CHANNEL_ROUTE',
  'PI_SESSION_ID', 'OMP_SESSION_ID', 'AIFY_PI_SESSION_ID', 'HARNESS_IDENTITY', 'HARNESS_EXTRA_ENV',
]);

function localOverlay(agent, runtime) {
  return { ...agent.env, AIFY_AGENT_ID: agent.id, AIFY_COMMS_AGENT_ID: agent.id,
    AIFY_AGENT_ROLE: agent.role, AIFY_COMMS_AGENT_ROLE: agent.role, AIFY_AGENT_CWD: agent.workspace,
    AIFY_RUNTIME: runtime, AIFY_SESSION_MODE: 'managed', AIFY_START_INTENT: 'start',
    AIFY_ENVIRONMENT_BRIDGE: '0', AIFY_MANAGED_DISPATCH: '0' };
}

/** Prepare a host-defined local launch, without acquiring the definition lock or starting anything. */
export async function composeDefinedLaunch(agent, request, {
  definitions, contributors = () => [], checkCwd, windows, platform = process.platform, baseEnv = process.env,
  resolve = launcherCandidates, readFile = file => readFileSync(file, 'utf8'),
}) {
  const facts = Object.hasOwn(HARNESS_FACTS, agent.harness) ? HARNESS_FACTS[agent.harness] : null;
  if (!facts?.definition || !facts.managed || agent.mode !== 'managed' || agent.id !== request.agentId) {
    throw Error('local defined launch is not available for this agent');
  }
  await checkCwd(agent.workspace);
  const env = localOverlay(agent, facts.runtime);
  const launch = { agentId: agent.id, runtime: facts.runtime, env,
    unsetEnv: [...LOCAL_START_NEVER_INHERITED, ...Object.keys(env)],
    definition: { storeId: request.storeId, incarnation: request.expectedIncarnation, revision: request.expectedRevision } };
  const merged = await preparedEnv({ launch, baseEnv, spawnEnv: contributors,
    definitionFor: candidate => definitions.boundReading(candidate), windows });
  if (merged.refused) throw Error(merged.refused);
  const name = `${agent.harness}-aify`;
  const attempt = resolveWorkerSpec({ service: 'aify-env', argv: [name, '--aify-agent', agent.id],
    cwd: agent.workspace, label: agent.id, env: merged.env }, {
    resolveCandidates: command => resolve(command, { env: baseEnv, platform }),
    buildSpec: input => buildStartSpec(input, { readFile, platform, baseEnv }),
  });
  if (attempt.built) return { ...attempt.built.spec, space: agent.herdrSpace !== false };
  throw Error(attempt.rejected.at(-1)?.detail ?? `${name} does not resolve to a file on this host`);
}
