// Keystrokes over a local socket: a named pipe on Windows, a unix socket elsewhere.
//
// WHY. `aify-env attach` and this daemon are always on the same host -- the daemon opens the pane
// itself -- and an HTTP request per keystroke is the slowest thing on that path. Measured on this
// host, 2026-09-20, both ends counted: 0.024 ms per keystroke over a pipe against 0.33 ms over
// `fetch`, and 0.17 ms over keep-alive HTTP. Ordering also stops being something the client has to
// arrange, because a stream delivers what was written in the order it was written.
//
// IT IS AN OPTIMISATION, NEVER A REQUIREMENT. HTTP stays, and the client falls back to it whenever
// the socket cannot be opened: a WSL client cannot open a Windows pipe, another PC cannot open
// either, and a daemon from an older version advertises no address at all. A transport that only
// sometimes exists must never be the only way in.
//
// ONE ROUTER, TWO TRANSPORTS. A frame is turned into the same request object the HTTP server builds
// and handed to the same `handleRequest`, so a route cannot behave differently depending on how it
// was reached, and a new route needs no work here. The frames are newline-delimited JSON: input is
// small and infrequent by machine standards, and a text frame is debuggable with a pipe client.
//
// REPLIES ONLY WHEN SOMETHING IS WRONG. A keystroke that landed needs no answer, and waiting for one
// would put the round trip back into the path this exists to shorten. A non-2xx status is sent back
// so the client can say "that process is gone" instead of typing into a void.

import net from "node:net";
import os from "node:os";
import path from "node:path";

const NEWLINE = 10;
/** A frame longer than this is a bug or an attack, never a keystroke. */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * Where the socket lives for a daemon on this host.
 *
 * KEYED BY PORT, because that is what already identifies one daemon among several on a host: a
 * dedicated instance listens on its own port, and the client already knows the port it is talking to.
 */
export function localSocketAddress({ platform = process.platform, port, dir } = {}) {
  const name = `aify-env-${String(port || 0)}`;
  if (platform === "win32") return `${String.fromCharCode(92, 92, 46, 92)}pipe${String.fromCharCode(92)}${name}`;
  return path.join(dir || os.tmpdir(), `${name}.sock`);
}

/** Split a byte stream into newline-delimited JSON frames. Stateful, one per connection. */
export class FrameReader {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    this._buffer = Buffer.alloc(0);
    this._maxBytes = maxBytes;
    this.overflowed = false;
  }

  /** @returns {object[]} the frames completed by this chunk; malformed ones are skipped. */
  push(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    let start = 0;
    for (let i = 0; i < this._buffer.length; i++) {
      if (this._buffer[i] !== NEWLINE) continue;
      const line = this._buffer.subarray(start, i).toString("utf8");
      start = i + 1;
      if (!line.trim()) continue;
      try { frames.push(JSON.parse(line)); } catch { /* a malformed frame is dropped, never fatal */ }
    }
    this._buffer = this._buffer.subarray(start);
    // A sender that never sends a newline must not grow this buffer without limit.
    if (this._buffer.length > this._maxBytes) {
      this._buffer = Buffer.alloc(0);
      this.overflowed = true;
    }
    return frames;
  }
}

export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/** A frame as a request for the HTTP router: same shape, same handler, same rules. */
export function requestFromFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  const path = typeof frame.path === "string" ? frame.path : "";
  if (!path.startsWith("/")) return null;
  return { method: typeof frame.method === "string" ? frame.method : "POST", path, body: frame.body ?? null };
}

/**
 * The daemon side. Listens, and hands every frame to the router it was given.
 */
export class InputSocketServer {
  /**
   * @param {{address: string, handleRequest: Function, deps: object, onError?: Function}} options
   */
  /** `deps` may be an object or a function called per frame, as the HTTP server does per request. */
  constructor({ address, handleRequest, deps, onError }) {
    this.address = address;
    this._handleRequest = handleRequest;
    this._deps = deps;
    this._onError = onError || (() => {});
    this._server = null;
    // EVERY LIVE CONNECTION, because `server.close()` is documented to wait for them: a daemon
    // shutting down while a pane is attached would wait for the operator to close that pane.
    // MEASURED on Windows named pipes, 2026-09-20: close() resolves there even with a client
    // attached, so this is load-bearing on POSIX and belt-and-braces on Windows.
    this._open = new Set();
    this.connections = 0;
    this.frames = 0;
  }

  async start() {
    const server = net.createServer((socket) => {
      this.connections += 1;
      this._open.add(socket);
      socket.on("close", () => this._open.delete(socket));
      socket.on("error", () => socket.destroy());       // a client that vanished is not an incident
      const reader = new FrameReader();
      socket.on("data", async (chunk) => {
        for (const frame of reader.push(chunk)) {
          this.frames += 1;
          const request = requestFromFrame(frame);
          if (!request) continue;
          try {
            const deps = typeof this._deps === "function" ? await this._deps() : this._deps;
            const result = await this._handleRequest(request, deps);
            const status = result?.status ?? 204;
            // Only a refusal travels back; see the header.
            if (status >= 300) socket.write(encodeFrame({ status, body: result?.body ?? null, ref: frame.ref ?? null }));
          } catch (error) {
            this._onError(error);
          }
        }
      });
    });
    server.on("error", (error) => this._onError(error));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.address, () => { server.removeListener("error", reject); resolve(); });
    });
    this._server = server;
    return this;
  }

  async stop() {
    if (!this._server) return;
    const server = this._server;
    this._server = null;
    // The sockets go FIRST: close() stops accepting and then waits for what is already connected.
    for (const socket of this._open) { try { socket.destroy(); } catch { /* already gone */ } }
    this._open.clear();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * The client side. Resolves to a connected sender, or to null when the socket is not usable here.
 *
 * NULL IS A NORMAL ANSWER, not an error: on WSL, against another host, or against an older daemon
 * there is nothing to connect to, and the caller uses HTTP.
 */
export async function connectInputSocket({ address, timeoutMs = 400, onRefusal, onClose } = {}) {
  if (!address) return null;
  const socket = net.connect(address);
  socket.setNoDelay?.(true);
  const connected = await new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  if (!connected) { socket.destroy(); return null; }

  const reader = new FrameReader();
  socket.on("data", (chunk) => {
    for (const frame of reader.push(chunk)) if (onRefusal) onRefusal(frame);
  });
  let live = true;
  const end = () => { if (live) { live = false; onClose?.(); } };
  socket.on("error", end);
  socket.on("close", end);

  return {
    address,
    get live() { return live; },
    /** @returns {boolean} false when the socket has gone and the caller should fall back. */
    send(path, body) {
      if (!live) return false;
      try { socket.write(encodeFrame({ path, body })); return true; } catch { end(); return false; }
    },
    close() { live = false; socket.end(); },
  };
}
