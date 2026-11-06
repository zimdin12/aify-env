// A piped child's admission boundary. Early events wait for bookkeeping, not for runtime readiness.
export class SpawnFailure extends Error {
  constructor(cause) {
    const code = typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) ? cause.code : 'UNKNOWN';
    super(`spawn failed: ${code}`, { cause });
    this.name = 'SpawnFailure';
    this.code = code;
  }
}

export class PipedSpawn {
  #ready;
  #spawned = false;
  #failed = false;
  #pending = [];
  #sink = null;

  constructor(child) {
    this.#ready = new Promise((resolve, reject) => {
      const refuse = error => {
        if (this.#failed) return;
        this.#failed = true;
        this.#pending = [];
        reject(new SpawnFailure(error));
      };
      child.stdout?.on('data', chunk => this.#forward(sink => sink.out(chunk)));
      child.stderr?.on('data', chunk => this.#forward(sink => sink.err(chunk)));
      child.stdout?.on('end', () => this.#forward(sink => sink.out.end()));
      child.stderr?.on('end', () => this.#forward(sink => sink.err.end()));
      child.on('spawn', () => {
        if (this.#failed || this.#spawned) return;
        this.#spawned = true;
        resolve();
      });
      child.on('error', error => {
        if (!this.#spawned) refuse(error);
        else this.#forward(sink => sink.finish(-1, '', false));
      });
      child.on('close', (code, signal) => {
        if (!this.#spawned) refuse();
        else this.#forward(sink => sink.finish(code, signal));
      });
    });
  }

  ready() { return this.#ready; }

  #forward(event) {
    if (this.#failed) return;
    if (this.#sink) event(this.#sink);
    else this.#pending.push(event);
  }

  /** Connect only after registry, managed lifetime and owned record are installed, then drain in arrival order. */
  connect({ makeEmit, finish }) {
    this.#sink = { out: makeEmit(), err: makeEmit(), finish };
    const pending = this.#pending;
    this.#pending = [];
    for (const event of pending) event(this.#sink);
  }
}
