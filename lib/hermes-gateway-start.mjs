// Starting one agent's hermes gateway host and proving it serves (0.9.10: moved here from the comms bridge's
// mcp/stdio/hermes-gateway.mjs `ensureGatewayHost`, whose incident history the comments below keep).
//
// A gateway is `hermes dashboard` on the agent's port. It serves an index page carrying its session token and a
// `/api/ws` WebSocket that the agent's visible TUI and comms' delivery loop both attach to. It is READY only when that
// socket opens: on 2026-06-04 a gateway served its index while `/api/ws` closed (4403), and an index-only check called it
// ready.
//
// THE GATEWAY BELONGS TO ITS AGENT, NOT TO THIS PROCESS. It is spawned detached with `HERMES_PARENT_PID` set to the
// agent's launcher, so hermes' own parent-death watchdog ends it with the agent and an aify-env restart leaves it
// alone (hermes_cli/web_server_lifecycle.py `_start_parent_death_watchdog`). `hermes update` also records that pid as
// the spawner, so it no longer stops and relaunches a gateway whose agent lives (2026-09-15, elevated). PID ONLY:
// hermes treats a start-marker mismatch as conclusive, so an inherited marker or nonce is blanked.
//
// EXPLICIT INPUTS: spawn, fetch and WebSocket are injected, so the tests drive a fake hermes. Nothing here records,
// reaps or picks a port: that is lib/hermes-gateway-book.mjs and lib/hermes-gateway-ports.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_VERIFY_MS = 5000;
// Readiness follows the child while its exit can be seen, with a ceiling for a child that hangs; a first boot can
// install hermes' TUI dependencies, which takes minutes.
const READY_OBSERVED_MS = 10 * 60 * 1000;

/** PURE. `text` with every `token=` value replaced: any gateway text quoted out of here can carry its token. */
function redactTokens(text) {
  return String(text || '').replace(/token=[^&\s]*/g, 'token=<redacted>');
}

/** PURE. The last line a gateway wrote to its stderr log, redacted: why it never served, when it says so. */
function lastLogLine(text) {
  return redactTokens(String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '');
}

/**
 * PURE. A boot that can never serve: hermes' "Installing TUI dependencies" npm step runs outside `--skip-build` and,
 * on upstream drift, dies `npm error Missing script: "build"` (2026-07-03). Seen, the start fails at once with this
 * reason instead of at its deadline.
 */
export function bootFailure(text) {
  const s = String(text || '');
  const failed = /Missing script:\s*["']build["']/i.test(s) || /TUI build failed/i.test(s)
    || (/Installing TUI dependencies/i.test(s) && /npm (?:error|ERR!)/i.test(s));
  return failed ? `hermes' TUI dependency build failed at boot (npm: Missing script "build"); repair or pin the hermes TUI build, then relaunch: ${lastLogLine(s)}` : '';
}

/** PURE. What makes the gateway end with its agent: see the header. Nothing without a launcher pid. */
export function ownerEnv(ownerPid) {
  const pid = Number(ownerPid);
  if (!Number.isInteger(pid) || pid <= 0) return {};
  return { HERMES_PARENT_PID: String(pid), HERMES_PARENT_START_MARKER: '', HERMES_PARENT_NONCE: '' };
}

const wsUrlFor = (port, token) => `ws://127.0.0.1:${port}/api/ws?token=${token}`;

/** The token a live gateway's index carries, or a thrown reason. */
async function scrapeToken(port, fetchImpl, signal) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/`, { method: 'GET', ...(signal ? { signal } : {}) });
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
 * A gateway already serving on `port`, proven by its socket, or null. Used before starting one and when re-adopting
 * a recorded gateway after this process restarts.
 * @returns {Promise<{port: number, token: string, wsUrl: string}|null>}
 */
export async function probeGateway({ port, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket }) {
  let token;
  try { token = await scrapeToken(port, fetchImpl); } catch { return null; }
  try { await verifySocket(port, token, WebSocketImpl); } catch { return null; }
  return { port, token, wsUrl: wsUrlFor(port, token) };
}

/**
 * Start the agent's gateway on `port` and wait until its socket opens. Refuses, with the gateway's own last words,
 * when it exits first, cannot spawn, hits the known boot failure, or passes its deadline.
 * @param {{port: number, ownerPid: number, logDir: string, hermesCmd?: string, env?: object, spawn?: Function,
 *          fetchImpl?: Function, WebSocketImpl?: Function, readyTimeoutMs?: number, intervalMs?: number}} input
 * @returns {Promise<{port: number, token: string, wsUrl: string, pid: number}>}
 */
export async function startGateway({ port, ownerPid, logDir, hermesCmd = 'hermes', env = process.env, spawn = nodeSpawn,
  fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, readyTimeoutMs = READY_OBSERVED_MS, intervalMs = 250 }) {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `hermes-gateway-${port}.log`);
  // A fresh log per start: the boot-failure check reads its tail, and a previous boot's failure must not end this one.
  const logFd = fs.openSync(logPath, 'w');
  let child;
  try {
    child = spawn(hermesCmd, ['dashboard', '--port', String(port), '--host', '127.0.0.1', '--no-open', '--skip-build'], {
      stdio: ['ignore', 'ignore', logFd], detached: true, windowsHide: true,
      // Unattended turns need no approval prompts (hermes freezes YOLO at import from this variable), and on hermes
      // builds before cae6b5486 `/api/ws` is served only with HERMES_DASHBOARD_TUI.
      env: { ...env, HERMES_YOLO_MODE: '1', HERMES_DASHBOARD_TUI: '1', ...ownerEnv(ownerPid) },
    });
  } finally { fs.closeSync(logFd); }
  child.unref?.();
  const tail = () => { try { return fs.readFileSync(logPath, 'utf8').slice(-8192); } catch { return ''; } };
  const abort = new AbortController();
  const stop = (message) => { if (!abort.signal.aborted) abort.abort(new Error(message)); };
  // A detached spawn reports a missing binary asynchronously; unheard, it would end this process.
  child.on?.('error', (error) => stop(`hermes could not start for port ${port}: ${error?.code || 'spawn error'}`));
  child.on?.('exit', (code, signal) => stop(`the gateway on port ${port} exited before it served: exit ${code ?? signal ?? 'unknown'}`
    + (lastLogLine(tail()) ? `; it last wrote: ${lastLogLine(tail())}` : '')));
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = null;
  while (!abort.signal.aborted) {
    try {
      const token = await scrapeToken(port, fetchImpl, abort.signal);
      await verifySocket(port, token, WebSocketImpl);
      if (abort.signal.aborted) break;
      return { port, token, wsUrl: wsUrlFor(port, token), pid: child.pid };
    } catch (error) { lastError = error; }
    const failed = bootFailure(tail());
    if (failed) stop(failed);
    else if (Date.now() > deadline) {
      stop(`the gateway on port ${port} did not serve within ${readyTimeoutMs} ms: ${lastLogLine(tail()) || redactTokens(lastError?.message || '')}`);
    } else await sleep(intervalMs).catch(() => {});
  }
  throw abort.signal.reason;
}
