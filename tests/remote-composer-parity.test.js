import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LifecycleLaunch } from '../lib/plugins/aify-comms/lifecycle-launch.mjs';
import { createHandleBook, runOneControl } from '../lib/plugins/aify-comms/terminal-controls.mjs';
import { buildStartSpec } from '../lib/start-spec.mjs';
import { workspaceWithinRoots } from '../lib/workspace-roots.mjs';
import { composeRemoteLaunch } from '../lib/worker-launch.mjs';

const definition = { storeId: 'fixture-store', incarnation: 3, revision: 7 };
const launcherText = '#!/bin/bash\nHARNESS_WRAPPER_VERSION="1"\n';
const photograph = spec => JSON.stringify({ argv: [spec.command, ...spec.args], cwd: spec.cwd, env: spec.env });
const launchers = { claude: 'CLAUDE_SESSION_ID', codex: 'CODEX_THREAD_ID', hermes: 'HERMES_SESSION_ID' };
const tripwire = () => assert.fail('fixture tried to start a real process');

function specimen(harness, route) {
  const runtime = harness === 'claude' ? 'claude-code' : harness;
  const fresh = route === 'restart';
  const handle = fresh ? '' : `${harness}-resume`;
  const launcher = `/fixture/bin/${harness}-aify`;
  const wire = { terminalId: 'term-1', agentId: 'lead', runtime, definition, cwd: '/fixture/project',
    argv: [`${harness}-aify`, '--aify-agent', 'lead', ...(handle ? ['--resume', handle] : [])],
    unsetEnv: ['CLAUDE_CODE_CHILD_SESSION', 'AIFY_AGENT_LEASE', 'AIFY_AGENT_ROLE', 'DROP_ME'],
    env: { AIFY_AGENT_ID: 'lead', AIFY_AGENT_ROLE: 'reviewer', AIFY_SESSION_HANDLE: handle,
      [launchers[harness]]: handle, AIFY_HERMES_FRESH_CONTEXT: fresh ? '1' : '', USER_VALUE: 'wire-value' },
  };
  const agent = { id: 'lead', harness, mode: 'managed', env: {}, secrets: { project: 'fixture', names: ['FIXTURE'] } };
  const deps = { machineId: 'machine', windows: false, cwdRoots: () => ['/fixture'], withinRoots: workspaceWithinRoots,
    baseEnv: { PATH: '/fixture/bin', AIFY_CHANNEL_ROUTE: 'kept-unless-service-unsets', drop_me: 'parent',
      CLAUDE_CODE_CHILD_SESSION: '1', AIFY_AGENT_LEASE: 'parent', aify_agent_role: 'parent', USER_VALUE: 'parent' },
    resolveCandidates: name => {
      assert.equal(name, `${harness}-aify`);
      return [`${launcher}.bad`, launcher];
    },
    buildSpec: input => buildStartSpec(input, { platform: 'linux', readFile: file => file === launcher ? launcherText : '# rejected' }),
    definitionFor: () => ({ agent }), spawnEnv: () => [{ field: 'secrets', contribute: () => ({ env: { FIXTURE: 'fixture-only' } }) }],
  };
  const request = { id: 'request', agentId: wire.agentId, machineId: deps.machineId, storeId: definition.storeId,
    expectedIncarnation: definition.incarnation, expectedRevision: definition.revision,
    action: fresh ? 'restart' : 'start', freshContext: fresh };
  // Independent of either composer: the old wire's retained environment, overlay order and interpreter argv.
  const golden = JSON.stringify({ argv: [launcher, '--aify-agent', 'lead', ...(handle ? ['--resume', handle] : [])],
    cwd: '/fixture/project', env: { PATH: '/fixture/bin', AIFY_CHANNEL_ROUTE: 'kept-unless-service-unsets', USER_VALUE: 'wire-value',
      AIFY_AGENT_ID: 'lead', AIFY_AGENT_ROLE: 'reviewer', AIFY_SESSION_HANDLE: handle,
      [launchers[harness]]: handle, AIFY_HERMES_FRESH_CONTEXT: fresh ? '1' : '', FIXTURE: 'fixture-only' } });
  return { wire, deps, agent, request, golden };
}

async function captureAdapter({ wire, deps, agent, request }, route) {
  if (route !== 'terminal') {
    const adapter = new LifecycleLaunch({ ...deps, processes: { start: tripwire },
      api: { prepareLifecycleLaunch: async () => ({ ok: true, launch: wire }) },
      definitions: { list: async () => ({ storeId: definition.storeId, definitions: [{ id: agent.id, agent,
        incarnation: definition.incarnation, revision: definition.revision, problems: [] }] }) },
    });
    return (await adapter.prepare('env-fixture', request, agent)).spec;
  }
  let captured;
  const handles = createHandleBook();
  const result = await runOneControl({ ...deps, handles,
    control: { id: 'control', action: 'start', terminalId: wire.terminalId },
    api: { launch: async () => ({ launch: wire }), reportControl: async () => ({}) },
    admitStart: async (_launch, produce, complete) => { const started = await produce(); await complete(started); return { produced: started }; },
    processes: { start: async spec => { captured = spec; return { id: 'fixture-worker', pid: 71 }; }, subscribe: () => () => {} },
  });
  assert.equal(result.outcome, 'started');
  handles.forget(wire.terminalId);
  return captured;
}

for (const harness of Object.keys(launchers)) for (const route of ['terminal', 'lifecycle', 'restart']) {
  test(`remote ${harness} ${route} preserves the captured argv, cwd and env`, async t => {
    const input = specimen(harness, route);
    const before = photograph(await captureAdapter(input, route));
    t.diagnostic(before);
    assert.equal(before, input.golden, 'remote adapter no longer emits the captured bytes');
    const core = await composeRemoteLaunch({ ...input.deps, service: 'aify-comms', launch: input.wire,
      terminalId: input.wire.terminalId });
    assert.ok(core?.built?.spec, core?.detail ?? core?.refused);
    assert.equal(photograph(core.built.spec), input.golden, 'core prepareRemoteSpec and resolveWorkerSpec differ from the captured wire launch');
  });
}
