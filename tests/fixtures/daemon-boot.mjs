import { BootSession } from '../../lib/daemon-boot-session.mjs';
import { startDaemonBoot } from '../../lib/daemon-boot.mjs';
import { createShutdown } from '../../lib/shutdown.mjs';
import { daemonShutdownHooks } from '../../lib/shutdown-hooks.mjs';

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const tick = () => new Promise(resolve => setImmediate(resolve));

// Fake effect ports around the real ordered boot, BootSession and shutdown owners. No host IO.
export class BootFixture {
  events = [];
  captured = {};
  session = new BootSession();
  facts = { roots: ['/workspace'], installed: new Set(['fixture']), registry: 'registry-one', credential: 'fixture-one', disk: 1 };
  identityCalls = 0;
  output = [];
  constructor() {
    const note = name => this.events.push(name);
    this.socket = { address: 'fixture-socket', stop: async () => note('stop:socket') };
    this.view = { ownsScreen: true, stop: () => note('stop:view') };
    this.sender = { tick: async () => {}, stop: () => note('stop:sender'), retire: async () => note('retire') };
    this.timer = { unref: () => note('unref') };
    this.plugins = { capabilities: () => [], capability: () => null, stopAll: async () => note('stop:plugins') };
    this.state = { host: {}, instance: 'fixture', generation: 1, processes: () => new Map(), lifecycleOwner: {},
      residents: { attachSender: sendFor => { note('attach'); this.captured.sendFor = sendFor; },
        tick: async () => {}, release: async () => note('release:residents') } };
    this.factories = {
      support: () => { note('support'); return { available: false, reason: 'fixture pipes' }; },
      state: options => { note('state'); this.captured.state = options; return this.state; },
      turns: options => { note('turns'); this.captured.turns = options; return {}; },
      selections: options => { note('selections'); this.captured.selections = options; return {}; },
      lifecycle: options => { note('lifecycle'); this.captured.lifecycle = options; return { rawIdentity: () => ({}) }; },
      folders: options => { note('folders'); this.captured.folders = options; return { reconcile: async () => { note('reconcile'); }, notice() {} }; },
      sender: options => { note('sender'); this.captured.sender = options; return this.sender; },
      socket: options => { note('socket'); this.captured.socket = options; return this.socket; },
      pane: options => { note('pane'); this.captured.pane = options; return null; },
      plugins: options => { note('plugins'); this.captured.plugins = options; this.captured.shared = options.makeShared(); return () => {}; },
      view: options => { note('view'); this.captured.view = options; return this.view; },
      ready: (context, ready) => { note('ready'); this.captured.ready = { context, ready }; },
    };
    this.runner = { instance: () => 'runner-instance', list: () => [], stop: async () => ({ stopped: true }), subscribe() {} };
    this.options = {
      session: this.session, bound: { address: '127.0.0.1', port: 18802 }, host: '127.0.0.1', home: '/fixture-home', instanceContext: null,
      runner: this.runner, definitions: { list: async () => ({ definitions: [] }) }, plugins: this.plugins,
      version: 'fixture-version', build: 'fixture-build', pid: 424242, env: {}, node: 'fixture-node', script: 'fixture-entry', windows: false,
      identity: () => { note('identity'); this.identityCalls++; return { hostname: 'fixture-host', machineId: 'fixture-machine', kind: 'native', os: 'fixture-os' }; },
      roots: () => this.facts.roots, installed: () => this.facts.installed,
      readRegistry: () => this.facts.registry, readServices: () => [], buildPlugins: () => [],
      credential: async () => this.facts.credential, credentialReading: () => ({ revision: this.facts.credential }),
      advertisement: () => ({ disk: this.facts.disk }), readGrantedRoots: async () => this.facts.roots,
      servedElsewhere: async () => true, localSocket: true, handleRequest() {}, registryPath: 'fixture-registry',
      noDashboard: false, notices: {}, shutdown: () => {},
      recover: async () => { note('recover'); return { ready: true }; }, evaluate: () => note('evaluate'), viewOnly: () => false,
      advertiser: { start: () => { note('advertising'); return () => note('stop:advertising'); } }, advertising: true,
      log: line => { note('log'); this.output.push(line); }, report: line => this.output.push(line),
      write: line => { note('banner'); this.output.push(line); },
      timers: { set: (callback, everyMs) => { note('interval'); this.captured.interval = { callback, everyMs }; return this.timer; }, clear: () => note('clear:interval') },
      factories: this.factories,
    };
  }
  boot() { return startDaemonBoot(this.options); }
  shutdown() {
    return createShutdown(daemonShutdownHooks({
      runner: this.runner,
      stopView: () => {
        this.session.cancel(); this.session.sendingStopped = true;
        if (this.session.evaluationTimer) this.options.timers.clear(this.session.evaluationTimer);
        this.session.sender?.stop();
        void this.session.stop('advertising').catch(() => {});
        void this.session.stop('view').catch(() => {});
      },
      releaseResidents: () => this.session.agentState?.residents?.release(),
      inputSocket: () => ({ stop: () => this.session.stop('socket') }),
      servicePlugins: { stopAll: () => this.session.finishBootAndStopPlugins(this.plugins) },
      closeHttpServer: () => this.events.push('close:http'),
      clearOwned: () => this.events.push('clear:owned'), exit: code => this.events.push(`exit:${code}`), write: () => {},
    }))('fixture');
  }
}
