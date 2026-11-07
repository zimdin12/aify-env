// Acquisitions made by one bound daemon boot. Existing shutdown slots remain the teardown owner.
import { StartAdmissionRefusal } from './start-admission-refusal.mjs';

export class BootCancelled extends StartAdmissionRefusal {
  constructor() {
    super('daemon boot was cancelled');
    this.name = 'BootCancelled';
    this.code = 'BOOT_CANCELLED';
  }
}

export class BootSession {
  #cancelled = false;
  #resources = new Map();
  identity = null;
  agentState = null;
  sender = null;
  evaluationTimer = null;
  sendingStopped = false;
  paneOpener = null;
  inputSocket = null;
  followServices = null;
  view = null;
  ownsScreen = false;
  failureExitCode = null;

  get cancelled() { return this.#cancelled; }
  assertOpen = () => { if (this.#cancelled) throw new BootCancelled(); };
  cancel() { this.#cancelled = true; }

  #begin(name, create, dispose) {
    this.assertOpen();
    if (typeof name !== 'string' || !name || typeof create !== 'function' || typeof dispose !== 'function') {
      throw new TypeError('a named boot acquisition needs creation and disposal functions');
    }
    if (this.#resources.has(name)) throw new Error(`boot acquisition already entered: ${name}`);
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = { pending, dispose, value: undefined, ready: false, failed: false, error: undefined, stopping: null };
    this.#resources.set(name, entry);
    const acquired = value => { entry.value = value; entry.ready = true; resolve(value); };
    const refused = error => { entry.ready = true; entry.failed = true; entry.error = error; reject(error); };
    try {
      const value = create();
      if (value && typeof value.then === 'function') Promise.resolve(value).then(acquired, refused);
      else acquired(value);
    } catch (error) { refused(error); }
    return entry;
  }

  async acquire(name, create, dispose) {
    const entry = this.#begin(name, create, dispose);
    let value;
    try { value = await entry.pending; }
    catch (error) {
      if (!this.#cancelled) throw error;
      await this.stop(name);
      throw new BootCancelled();
    }
    if (this.#cancelled) {
      await this.stop(name);
      throw new BootCancelled();
    }
    return value;
  }

  capture(name, create, dispose) {
    const entry = this.#begin(name, create, dispose);
    if (!entry.ready) {
      // A malformed synchronous factory still leaves its eventual resource in this owner's custody.
      void entry.pending.then(() => this.stop(name), () => this.stop(name)).catch(() => {});
      throw new TypeError('this boot acquisition must complete synchronously');
    }
    // Observe a rejected synchronous factory without allowing it to escape as an unhandled promise.
    entry.pending.catch(() => {});
    if (entry.failed) throw entry.error;
    if (this.#cancelled) {
      void this.stop(name).catch(() => {});
      throw new BootCancelled();
    }
    return entry.value;
  }

  stop(name, fallback = null) {
    const entry = this.#resources.get(name);
    if (!entry) return fallback ? Promise.resolve().then(fallback) : Promise.resolve();
    if (entry.stopping) return entry.stopping;
    let resolve, reject;
    entry.stopping = new Promise((yes, no) => { resolve = yes; reject = no; });
    const dispose = () => {
      try { Promise.resolve(entry.dispose(entry.value)).then(resolve, reject); }
      catch (error) { reject(error); }
    };
    // An acquired view releases its terminal synchronously; pending acquisitions join their real outcome.
    if (entry.ready) dispose();
    else entry.pending.then(dispose, dispose);
    return entry.stopping;
  }

  async finishBootAndStopPlugins(registry) {
    // A pending screen must not acquire a terminal after its shutdown slot has already passed.
    await this.stop('view');
    return this.stop('plugins', () => registry.stopAll());
  }
}
