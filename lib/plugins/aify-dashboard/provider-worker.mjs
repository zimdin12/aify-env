// Serial JSON-line exchange over runChild's existing owned lifetime. No service credential reaches this worker.
import { runChild } from './provider-child.mjs';

const ANSWER_TIMEOUT_MS = 90_000;
export class ProviderWorker {
  #child; #cancel = new AbortController(); #pending; #buffer = ''; #protocol = ''; #ended = false;
  constructor(options) {
    this.dropped = 0;
    this.done = (options.run ?? runChild)({ ...options, args: ['provide'], timeoutMs: null,
      stdio: ['pipe', 'pipe', 'pipe'], signal: this.#cancel.signal,
      onChild: child => {
        this.#child = child;
        child.stdin.on('error', () => this.#end('protocol'));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', text => this.#read(text));
      },
    }).then(result => {
      this.#ended = true;
      const answer = this.#protocol ? { ...result, stopped: false, protocolError: true, error: this.#protocol } : result;
      this.#pending?.reject(Object.assign(new Error(answer.error || 'the provider worker ended'), { result: answer }));
      return answer;
    });
  }
  #read(text) {
    this.#buffer += text;
    if (Buffer.byteLength(this.#buffer) > 2 * 1024 * 1024) return this.#end('protocol');
    for (let at; (at = this.#buffer.indexOf('\n')) >= 0;) {
      const line = this.#buffer.slice(0, at); this.#buffer = this.#buffer.slice(at + 1);
      let answer;
      try { answer = JSON.parse(line); } catch { this.#end('protocol'); return; }
      if (!this.#pending || answer?.id !== this.#pending.id) { this.dropped += 1; continue; }
      if (typeof answer.ok !== 'boolean' || (!answer.ok && typeof answer.problem !== 'string')) { this.#end('protocol'); return; }
      this.#pending.resolve(answer);
      this.#pending = null;
    }
  }
  #end(reason) {
    if (reason === 'protocol') this.#protocol = 'the provider worker returned an invalid frame';
    this.#child?.stdin.end();
    this.#cancel.abort(reason);
  }
  async ask(request, timeoutMs = ANSWER_TIMEOUT_MS) {
    if (this.#pending || this.#ended) throw new Error('the provider worker is not ready for a request');
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.#pending = { id: request.id, resolve, reject };
        timer = setTimeout(() => this.#end('timeout'), timeoutMs);
        this.#child.stdin.write(JSON.stringify(request) + '\n');
      });
    } finally { clearTimeout(timer); this.#pending = null; }
  }
  async close() {
    this.#child?.stdin.end();
    const timer = setTimeout(() => this.#end('stop'), 1000);
    try { return await this.done; } finally { clearTimeout(timer); }
  }
}
