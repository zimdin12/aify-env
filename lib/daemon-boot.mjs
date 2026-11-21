// Ordered post-bind boot only. Importing this module creates no daemon, listener or timer.
import { join } from 'node:path';
import { bootDaemonAgentState } from './daemon-agent-state.mjs';
import { AgentTurnEvents } from './agent-turn-events.mjs';
import { ModelSelections } from './model-selections.mjs';
import { createAgentLifecyclePorts } from './daemon-agent-lifecycle.mjs';
import { agentStartPort } from './local-agent-starts.mjs';
import { SessionFolders, sessionsRoot } from './session-folders.mjs';
import { AgentStateSender, REPORT_EVERY_MS } from './agent-state-sender.mjs';
import { startInputSocket } from './input-socket-start.mjs';
import { paneOpenerFor } from './herdr-pane-opener.mjs';
import { startDaemonPlugins } from './daemon-plugin-bootstrap.mjs';
import { startDaemonView } from './daemon-view.mjs';
import { publishInstanceReady } from './instance-bootstrap.mjs';
import { terminalSupport } from './runner.mjs';
import { outsideRootsWarning } from './definition-checks.mjs';

const factories = {
  state: bootDaemonAgentState,
  turns: options => new AgentTurnEvents(options),
  selections: options => new ModelSelections(options),
  lifecycle: createAgentLifecyclePorts,
  folders: options => new SessionFolders(options),
  sender: options => new AgentStateSender(options),
  socket: startInputSocket,
  pane: paneOpenerFor,
  plugins: startDaemonPlugins,
  view: startDaemonView,
  ready: publishInstanceReady,
  support: terminalSupport,
};

class BootFailure extends Error {
  constructor(message, cause, exitCode) {
    super(message, { cause });
    this.name = 'BootFailure';
    this.exitCode = exitCode;
  }
}

function context(options) {
  const { bound, host, home, session } = options;
  session.assertOpen();
  if (typeof host !== 'string' || !host || bound?.address !== host
    || !Number.isSafeInteger(bound?.port) || bound.port <= 0) {
    throw new TypeError('daemon boot needs its successfully bound endpoint');
  }
  if (typeof home !== 'string' || !home || typeof options.identity !== 'function') {
    throw new TypeError('daemon boot needs an explicit home and identity reader');
  }
  return { ...options, endpoint: `http://${host}:${bound.port}`, aifyHome: join(home, '.aify'),
    f: { ...factories, ...options.factories }, timers: options.timers ?? { set: setInterval, clear: clearInterval } };
}

function openAgentState(c) {
  const { session, f, runner, definitions, log, evaluate, instanceContext } = c;
  let state;
  try {
    state = f.state({ aifyHome: c.aifyHome, context: instanceContext, url: c.endpoint,
      report: log, onAgentEnded: id => session.agentState?.sessionFolders?.notice(id) });
    if (state && typeof state.then === 'function') {
      Promise.resolve(state).catch(() => {});
      throw new TypeError('agent state boot must be synchronous');
    }
    session.agentState = state;
    state.turnEvents = f.turns({ ...state, report: log, onApplied: evaluate });
    state.modelSelections = f.selections({ host: state.host, instance: state.instance, residents: state.residents,
      definitions, installed: c.installed, report: log });
    state.lifecycle = f.lifecycle({ aifyHome: c.aifyHome, owner: state.lifecycleOwner,
      machineId: session.identity.machineId, stateHost: state.host, residents: state.residents, runner, definitions,
      onStopChange: evaluate, processes: state.processes, cwdRoots: c.roots, windows: c.windows,
      installed: async () => c.installed(), spawnEnv: () => c.plugins.capabilities('spawnEnv'),
      paneOpener: () => session.paneOpener });
  } catch (cause) { throw new BootFailure(`[aify-env] agent state boot failed: ${cause?.message || cause}`, cause, 2); }
  state.sessionFolders = f.folders({ root: sessionsRoot(c.home), definitions,
    identity: state.lifecycle.rawIdentity, report: log });
  void state.sessionFolders.reconcile().catch(error => log(`session folders: ${error?.message || error}`));
  return { definitions, lifecycle: state.lifecycle, cwdRoots: c.roots,
    screens: () => runner.screenSightings(), observedHarnesses: c.installed };
}

function startPublication(c, observation) {
  const { session, f } = c;
  if (c.viewOnly() || session.sendingStopped) return;
  const sendFor = ({ instance, generation, ...population }) => f.sender({
    identity: { machineId: session.identity.machineId, instance, generation, build: c.build },
    ...observation, readRegistry: c.readRegistry, credentialOptions: c.credentialReading, report: c.log, ...population,
  });
  const state = session.agentState;
  session.sender = sendFor({ instance: state.instance, generation: state.generation, stateHost: state.host });
  state.residents.attachSender(sendFor);
  c.evaluate();
  session.evaluationTimer = c.timers.set(c.evaluate, REPORT_EVERY_MS);
  session.evaluationTimer.unref?.();
}

async function openSocket(c) {
  const socket = await c.session.acquire('socket', () => c.f.socket({
    enabled: c.localSocket, port: c.bound.port, handleRequest: c.handleRequest,
    deps: () => ({ runner: c.runner }), log: c.log,
  }), value => value?.stop());
  c.session.inputSocket = socket;
}

function openPane(c, observation) {
  return c.f.pane({ env: c.env, dedicatedRoot: c.instanceContext?.root, base: c.endpoint,
    node: c.node, script: c.script, log: c.log,
    watchExit: (id, on) => c.runner.subscribe(id, () => {}, on),
    observation: { stateHost: c.session.agentState.host, ...observation } });
}

async function openPlugins(c) {
  const { session } = c;
  try {
    session.followServices = await session.acquire('plugins', () => c.f.plugins({
      registry: c.plugins, runner: c.runner, paneOpener: session.paneOpener,
      cwdRoots: c.roots, windows: c.windows, credential: c.credential, log: c.log,
      spawnEnv: () => c.plugins.capabilities('spawnEnv'),
      makeShared: () => ({
        version: c.version, machineId: session.identity.machineId,
        advertisement: async () => c.advertisement(), carryAdvertisement: target => c.advertiser?.forPlugin?.(target),
        cwdRoots: async () => c.roots(),
        windows: c.windows, definitions: c.definitions, agents: session.agentState.lifecycle,
        installedHarnesses: async () => c.installed(),
        servedElsewhere: c.instanceContext === null ? async () => false : c.servedElsewhere,
        watchRoots: async () => c.readGrantedRoots({ definitions: c.definitions }),
      }),
      readServices: c.readServices, build: c.buildPlugins, report: c.report,
    }), () => c.plugins.stopAll());
  } catch (error) {
    session.assertOpen();
    c.log(`service plugins not started: ${error?.message || error}`);
  }
}

function banner(c, support) {
  c.write(`aify-env ${c.version} listening on ${c.endpoint}\n`
    + (support.available
      ? `terminals: available${support.conptyDll ? ' (conpty DLL backend, AIFY_ENV_CONPTY_DLL=1)' : ''}\n`
      : `terminals: UNAVAILABLE (${support.reason}) — processes will run with piped stdio\n`));
}

async function openView(c) {
  const { session } = c;
  const view = await session.acquire('view', () => c.f.view({
    endpoint: c.endpoint, registryPath: c.registryPath, runner: c.runner, shutdown: c.shutdown,
    agents: () => agentStartPort(c.plugins.capability('agents'), session.agentState?.lifecycle?.localStarts),
    herdrSpaces: Boolean(session.paneOpener), notices: c.notices,
    enabled: !c.noDashboard, intervalMs: Number(c.env.AIFY_TUI_REFRESH_MS || 2000),
    paneRepaintMs: Number(c.env.AIFY_PANE_REPAINT_MS || 80), color: !c.env.NO_COLOR,
  }), value => value?.stop());
  session.view = view;
  session.ownsScreen = view.ownsScreen;
}

/** Acquires only after an actual bind; HELD recovery continues, while a thrown failure stops this sequence. */
export async function startDaemonBoot(options) {
  const c = context(options), { session } = c;
  if (c.viewOnly()) return { state: null, inputSocket: null, paneOpener: null, followServices: null, ownsScreen: false };
  const support = c.f.support();
  session.identity = c.identity();
  if (session.identity && typeof session.identity.then === 'function') {
    Promise.resolve(session.identity).catch(() => {});
    throw new TypeError('host identity must be synchronous');
  }
  const observation = openAgentState(c);
  if (c.instanceContext) {
    try { c.f.ready(c.instanceContext, { pid: c.pid, envInstance: c.runner.instance(), port: c.bound.port, build: c.build }); }
    catch (cause) { throw new BootFailure(cause?.message || String(cause), cause, 2); }
  } else await c.recover();
  session.assertOpen();
  startPublication(c, observation);
  await openSocket(c);
  session.assertOpen();
  session.paneOpener = openPane(c, observation);
  await openPlugins(c);
  session.assertOpen();
  banner(c, support);
  await openView(c);
  session.assertOpen();
  // Intentional correction: no immediate beat/timer before successful bind and nonthrowing boot.
  if (c.advertising && !c.viewOnly()) session.capture('advertising', () => c.advertiser.start({ log: c.log }), stop => stop?.());
  c.definitions.list()
    .then(listed => outsideRootsWarning(listed.definitions, c.roots(), { windows: c.windows }))
    .then(warning => { if (warning) c.log(warning); }, () => {});
  return { state: session.agentState, inputSocket: session.inputSocket, paneOpener: session.paneOpener,
    followServices: session.followServices, ownsScreen: session.ownsScreen };
}
