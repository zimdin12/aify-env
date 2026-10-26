// Whether an agent's hermes gateway is live, asked of the gateway itself (0.9.10).
//
// A gateway is `hermes dashboard` on the agent's port. It serves an index page carrying its session token and a
// `/api/ws` WebSocket that the agent's visible TUI and comms' delivery loop both attach to. It is LIVE only when that
// socket opens: on 2026-06-04 a gateway served its index while `/api/ws` closed (4403), and an index-only check called
// it ready.
//
// The launcher starts the gateway, because the gateway carries the agent's own environment and folder (hermes runs the
// agent's tools in it); aify-env only asks it. Fetch and WebSocket are injected, so tests drive a fake hermes.

const WS_VERIFY_MS = 5000;

const wsUrlFor = (port, token) => `ws://127.0.0.1:${port}/api/ws?token=${token}`;

/** The token a live gateway's index carries, or a thrown reason. */
async function scrapeToken(port, fetchImpl, timeoutMs) {
  // BOUNDED: a gateway that accepts and never answers held the agent's book queue for undici's default (review of
  // a76e7da, F3: unanswered after 20 s, while the launcher's request gives up at 15 s).
  const response = await fetchImpl(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  if (!response || response.ok === false) throw new Error(`the gateway index on port ${port} answered ${response?.status ?? '?'}`);
  const match = String(await response.text()).match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  if (!match) throw new Error(`the gateway index on port ${port} carries no session token`);
  return match[1];
}

/** Resolves when `/api/ws` opens; the probe socket is closed at once, so it never lingers as a session. */
function verifySocket(port, token, WebSocketImpl, timeoutMs = WS_VERIFY_MS) {
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => { try { socket?.close(); } catch {} reject(new Error(`the gateway socket on port ${port} did not open within ${timeoutMs} ms`)); }, timeoutMs);
    try { socket = new WebSocketImpl(wsUrlFor(port, token)); }
    catch (error) { clearTimeout(timer); reject(error); return; }
    socket.addEventListener('open', () => { clearTimeout(timer); try { socket.close(); } catch {} resolve(); });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`the gateway on port ${port} served its index but refused /api/ws`)); });
  });
}

/**
 * The gateway serving on `port`, proven by its socket, or null.
 * @returns {Promise<{port: number, token: string, wsUrl: string}|null>}
 */
export async function probeGateway({ port, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = WS_VERIFY_MS }) {
  let token;
  try { token = await scrapeToken(port, fetchImpl, timeoutMs); } catch { return null; }
  try { await verifySocket(port, token, WebSocketImpl); } catch { return null; }
  return { port, token, wsUrl: wsUrlFor(port, token) };
}
