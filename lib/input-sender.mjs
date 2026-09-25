// Keystrokes reach a process in the order they were typed.
//
// THE BUG THIS EXISTS FOR, reported by the operator on 2026-09-19: "when i write and it catches up
// then text is scrambled (letters in wrong place)", under load, with subagents running, and never
// when the machine is quiet. `aify-env attach` sent every stdin chunk as its own fire-and-forget
// POST. Independent HTTP requests carry NO ordering guarantee -- they can take different pooled
// connections and be handled in any order -- so two keystrokes in flight at once can arrive
// reversed. On an idle host each request finished before the next key was pressed, which is why the
// defect hid: the order was luck, and load is what took the luck away.
//
// ONE REQUEST IN FLIGHT, and everything typed while it is out is COALESCED into the next one. Order
// is then a property of the code rather than of timing, and fast typing or a paste costs one request
// instead of dozens -- which also takes latency off the path the operator feels, because a busy
// daemon is answering one call per round trip rather than a queue of them.
//
// BEST-EFFORT IS KEPT. A send that fails is dropped rather than retried: the bytes are keystrokes,
// a retry would land them after whatever came next (the very defect this fixes), and the output
// stream is what tells an operator the connection died. Failures are counted so a caller can say so.
//
// SENDING IS INJECTED, so every rule here is tested by calling it -- no socket, no daemon, no PTY.

/**
 * POST one JSON body, and THROW when it did not land: a network error or a non-2xx answer.
 *
 * An `InputSender` counts a send as failed only when it throws, so a send that swallows its errors
 * makes `failed` a counter that can never count. Redirects are refused like every other request here.
 */
export async function postJson(url, body, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok) throw new Error(`${url} answered ${response?.status ?? "nothing"}`);
  return response;
}

export class InputSender {
  /**
   * @param {(data: string) => Promise<unknown>} send one call carrying the concatenated bytes.
   */
  constructor(send) {
    this._send = send;
    this._pending = "";
    this._inFlight = false;
    this.sent = 0;      // requests actually made
    this.failed = 0;    // requests that threw
    this._idle = null;  // resolvers waiting for the queue to drain
  }

  /** Queue bytes. Returns immediately: a keystroke never waits for the wire. */
  write(data) {
    if (!data) return;
    this._pending += data;
    if (!this._inFlight) void this._drain();
  }

  /** True while bytes are queued or a request is out. */
  get busy() {
    return this._inFlight || this._pending.length > 0;
  }

  /** Resolves when everything queued has been sent. For tests and for a clean detach. */
  drained() {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => { (this._idle ??= []).push(resolve); });
  }

  async _drain() {
    this._inFlight = true;
    try {
      while (this._pending) {
        const data = this._pending;
        this._pending = "";
        this.sent += 1;
        try {
          await this._send(data);
        } catch {
          this.failed += 1;
        }
      }
    } finally {
      this._inFlight = false;
      const waiting = this._idle;
      this._idle = null;
      for (const resolve of waiting ?? []) resolve();
    }
  }
}
