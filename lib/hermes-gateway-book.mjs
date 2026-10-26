// Which hermes gateway each agent has, which port it gets, and ending one a newer lifetime replaces (0.9.10: the comms
// bridge's gateway markers and kill-prior moved here).
//
// THE LAUNCHER STARTS THE GATEWAY; THIS BOOK DECIDES AROUND IT. The gateway carries the agent's own environment and
// folder (hermes runs the agent's tools in it, and its MCP children read the agent's id from it), so only the launcher
// can start it. The launcher asks `prepare` for its port, starts the gateway there, and `register`s the pid.
//
// ONE RECORD PER AGENT, `<aify home>/hermes-gateways/<agent>.json`: {port, pid, lifetime}. Per agent and in
// the home, not per instance, because a resident's gateway is asked for by whichever aify-env holds the residents
// role, and that can change while the gateway lives on.
//
// A LIFETIME OWNS ITS GATEWAY. Prepared for the lifetime it records, a live gateway is handed back for reuse. Prepared
// for a newer lifetime, the older one's gateway is ended first: the launcher's old kill-prior step. The port is kept
// unless another agent's record holds it (lib/hermes-gateway-ports.mjs).
//
// IT NEVER KILLS WHAT IT HAS NOT CONFIRMED. A recorded pid is ended only when the OS says it is alive and its command
// line is `hermes dashboard` on that record's port: a pid outlives its process and the OS hands it on (the reason
// comms' daemon cross-checked command lines). An unconfirmed record is dropped, and its process left alone. Hermes'
// own watchdog already ends a gateway whose launcher died, so this is the second line, not the first; on Linux, where
// lib/process-probe.mjs answers nothing yet, it is the only one.
//
// One agent's requests are served one at a time: the launcher and the delivery loop can ask together.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { writeFileDurably } from './durable-file.mjs';
import { killTree } from './kill-tree.mjs';
import { probeProcessesAsync } from './process-probe.mjs';
import { choosePort } from './hermes-gateway-ports.mjs';
import { probeGateway } from './hermes-gateway-probe.mjs';

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The queue every agent's port choice joins. */
const ANY_AGENT = Symbol('port choice');
export const NOT_ENDED = 'GATEWAY_NOT_ENDED';

/**
 * PURE. Whether an OS answer PROVES the record's gateway is gone: no such process, or the pid now runs something else.
 * An unanswered probe (`alive: null`) or an unread command line proves nothing (review of ca24737).
 */
export function isProvenEnded(record, answer) {
  if (answer?.alive === false) return true;
  return answer?.alive === true && typeof answer.commandLine === 'string' && !isRecordedGateway(record, answer);
}

/** PURE. Whether an OS process answer is this record's gateway: alive, and `hermes dashboard` on its port. */
export function isRecordedGateway(record, answer) {
  if (!answer || answer.alive !== true) return false;
  const line = String(answer.commandLine || '');
  return /\bhermes\b/i.test(line) && /\bdashboard\b/.test(line) && new RegExp(`--port[ =]${record.port}\\b`).test(line);
}

/**
 * Is this local TCP port free now? Free means this host can bind it on loopback AND nothing answers a connect to it.
 *
 * THE CONNECT HALF IS WHAT WINDOWS NEEDS (carried over from comms' bridge with the port choice, 0.9.10). There a
 * loopback bind succeeds while another process holds the same port on 0.0.0.0: the bind alone called Docker's
 * published 8811 (Dashboard Next) free, a gateway was placed on it, and its readiness probe got that dashboard's 401
 * (sc-tester-gpt, 2026-10-05). A connect reaches a wildcard listener too and starts no listener of our own.
 */
export async function portIsFree(port, { answers = somethingAnswers } = {}) {
  return (await canBind(port)) && !(await answers(port));
}

/** Does anything accept a TCP connection on loopback:port? A timeout counts as an answer: unproven is not empty. */
export function somethingAnswers(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answered) => { socket.destroy(); resolve(answered); };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => done(error?.code !== 'ECONNREFUSED'));
  });
}

/** Can this host listen on loopback:port? The options form: `listen(string)` would bind a pipe of that name. */
function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    try { server.listen({ port, host: '127.0.0.1' }); } catch { resolve(false); }
  });
}

export class HermesGatewayBook {
  #dir;
  #probe;
  #isFree;
  #processes;
  #kill;
  #queues = new Map();

  constructor({ aifyHome, probe = probeGateway, isFree = portIsFree, processes = probeProcessesAsync, kill = killTree }) {
    this.#dir = path.join(aifyHome, 'hermes-gateways');
    this.#probe = probe;
    this.#isFree = isFree;
    this.#processes = processes;
    this.#kill = kill;
  }

  /**
   * Before the launcher starts a gateway for `lifetime`: the live one this lifetime already has (`live`, start nothing),
   * or the port to start one on, with an older lifetime's gateway ended first.
   * @returns {Promise<{port: number, live: {port: number, token: string, wsUrl: string}|null}>}
   */
  // `fence()` throws when the caller's admission no longer holds (the residents role released, the lifetime replaced).
  // It is asked immediately before every effect and before credentials are returned, never only at the start: each
  // await here is a window in which a successor can write this agent's record (review of 85cbd1a, A2).
  prepare({ agentId, lifetime, fence = () => {} }) {
    this.#file(agentId); // an agent id is never a path: refused before anything is decided
    return this.#serially(agentId, async () => {
      fence();
      const record = this.#read(agentId);
      // ADOPTED ONLY WHEN THE OS CONFIRMS the recorded pid is the gateway on that port: whatever answers there may be
      // another agent's gateway, and its token would be handed out as this one's (review of 85cbd1a, inherited).
      if (record?.lifetime === lifetime && await this.#isRunning(record)) {
        const live = await this.#probe({ port: record.port });
        fence();
        if (live) return { port: record.port, live };
      }
      // Any recorded gateway that is not this lifetime's live one is ended, once the OS confirms the pid: an older
      // lifetime's, and this lifetime's own that no longer answers (the loop asks again only when it cannot reach it).
      // Rewriting the record without ending it would drop the pid of a gateway still running (review of a76e7da, F2).
      if (record) await this.#endRecorded(agentId, record, fence);
      // ONE CHOICE AT A TIME ACROSS AGENTS: each reads the others' records, so two agents whose ids hash together and
      // chose at once got one port (review of 85cbd1a, inherited).
      return this.#serially(ANY_AGENT, async () => {
        const port = await choosePort({ agentId, previous: record?.port ?? null, others: this.#othersPorts(agentId), isFree: this.#isFree });
        fence();
        this.#write(agentId, { port, pid: 0, lifetime });
        return { port, live: null };
      });
    });
  }

  /** The launcher started the gateway `prepare` gave it a port for: record its pid. Refused for any other lifetime or port. */
  register({ agentId, lifetime, port, pid, fence = () => {} }) {
    this.#file(agentId);
    return this.#serially(agentId, async () => {
      fence();
      const record = this.#read(agentId);
      if (!record || record.lifetime !== lifetime || record.port !== port || !Number.isInteger(pid) || pid <= 0) return { registered: false };
      this.#write(agentId, { ...record, pid });
      return { registered: true };
    });
  }

  /** Every record, for the doctor's `gateway-orphans` row. */
  records() {
    let names;
    try { names = fs.readdirSync(this.#dir); } catch { return []; }
    return names.filter((name) => name.endsWith('.json'))
      .map((name) => ({ agentId: name.slice(0, -'.json'.length), record: this.#read(name.slice(0, -'.json'.length)) }))
      .filter(({ record }) => record);
  }

  /** Whether the OS confirms the record's pid is its gateway. 0: prepared, never registered; nothing this book knows of. */
  async #isRunning(record) {
    if (!(record.pid > 0)) return false;
    try {
      const answers = await this.#processes([record.pid]);
      return isRecordedGateway(record, answers.get(record.pid));
    } catch { return false; }
  }

  async #isProvenEnded(record) {
    try {
      const answers = await this.#processes([record.pid]);
      return isProvenEnded(record, answers.get(record.pid));
    } catch { return false; }
  }

  async #endRecorded(agentId, record, fence = () => {}) {
    const confirmed = await this.#isRunning(record);
    fence();
    // A gateway that could not be ended keeps its record: dropped, its pid would be known to nothing (review of 85cbd1a).
    // The OS is asked again rather than the kill's answer read: killTree reports an attempt, and taskkill can exit
    // unsuccessfully with the gateway still running (review of e7e0956).
    if (confirmed) {
      await this.#kill(record.pid);
      if (!(await this.#isProvenEnded(record))) {
        throw Object.assign(new Error(`gateway pid ${record.pid} could not be ended`), { code: NOT_ENDED });
      }
    }
    fence();
    fs.rmSync(this.#file(agentId), { force: true });
    return confirmed;
  }

  #othersPorts(agentId) {
    return this.records().filter((entry) => entry.agentId !== agentId).map(({ record }) => record.port);
  }

  #file(agentId) {
    if (!AGENT_ID.test(String(agentId))) throw new Error('not an agent id');
    return path.join(this.#dir, `${agentId}.json`);
  }

  #read(agentId) {
    try {
      const record = JSON.parse(fs.readFileSync(this.#file(agentId), 'utf8'));
      return Number.isInteger(record?.port) && Number.isInteger(record?.pid) && record.pid >= 0 && typeof record?.lifetime === 'string' ? record : null;
    } catch { return null; }
  }

  #write(agentId, record) {
    fs.mkdirSync(this.#dir, { recursive: true });
    writeFileDurably(this.#file(agentId), `${JSON.stringify(record)}\n`);
  }

  #serially(agentId, work) {
    const previous = this.#queues.get(agentId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => {});
    this.#queues.set(agentId, settled);
    settled.then(() => { if (this.#queues.get(agentId) === settled) this.#queues.delete(agentId); });
    return next;
  }
}
