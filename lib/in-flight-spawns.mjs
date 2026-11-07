// Private shutdown custody, not a public process registry or a successful spawn record.
import { RunnerStop } from './runner-stop.mjs';

export class InFlightSpawns {
  #entries = new Map();
  #sequence = 0;
  #io;
  constructor(io) { this.#io = io; }

  capture(child) {
    const key = `in-flight-${++this.#sequence}`;
    let settle;
    const handoff = new Promise(resolve => { settle = resolve; });
    this.#entries.set(key, { child, settle, admitted: null,
      stop: new RunnerStop({ child, io: this.#io, handoff }) });
    return key;
  }

  failed(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.settle(null);
    this.#entries.delete(key);
  }

  handoff(key, id, stop) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.admitted = id;
    entry.settle(stop);
    // Retain the alias until admitted custody ends: a shutdown snapshot may already hold it.
  }

  release(id) {
    for (const [key, entry] of this.#entries) {
      if (entry.admitted === id) this.#entries.delete(key);
    }
  }

  list() {
    return [...this.#entries].filter(([, entry]) => entry.admitted === null)
      .map(([id, entry]) => ({ id, pid: entry.child.pid }));
  }

  stop(id, options) { return this.#entries.get(id)?.stop.run(options); }
}
