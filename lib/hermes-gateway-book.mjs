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

/** PURE. Whether an OS process answer is this record's gateway: alive, and `hermes dashboard` on its port. */
export function isRecordedGateway(record, answer) {
  if (!answer || answer.alive !== true) return false;
  const line = String(answer.commandLine || '');
  return /\bhermes\b/i.test(line) && /\bdashboard\b/.test(line) && new RegExp(`--port[ =]${record.port}\\b`).test(line);
}

/** Whether nothing listens on `port` on the loopback. */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
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
  prepare({ agentId, lifetime }) {
    this.#file(agentId); // an agent id is never a path: refused before anything is decided
    return this.#serially(agentId, async () => {
      const record = this.#read(agentId);
      if (record?.lifetime === lifetime) {
        const live = await this.#probe({ port: record.port });
        if (live) return { port: record.port, live };
      }
      if (record && record.lifetime !== lifetime) await this.#endRecorded(agentId, record);
      const port = await choosePort({ agentId, previous: record?.port ?? null, others: this.#othersPorts(agentId), isFree: this.#isFree });
      this.#write(agentId, { port, pid: 0, lifetime });
      return { port, live: null };
    });
  }

  /** The launcher started the gateway `prepare` gave it a port for: record its pid. Refused for any other lifetime or port. */
  register({ agentId, lifetime, port, pid }) {
    this.#file(agentId);
    return this.#serially(agentId, async () => {
      const record = this.#read(agentId);
      if (!record || record.lifetime !== lifetime || record.port !== port || !Number.isInteger(pid) || pid <= 0) return { registered: false };
      this.#write(agentId, { ...record, pid });
      return { registered: true };
    });
  }

  /** The live gateway `lifetime` owns, or null: what comms' delivery loop asks for. Starts nothing. */
  current({ agentId, lifetime }) {
    this.#file(agentId);
    return this.#serially(agentId, async () => {
      const record = this.#read(agentId);
      if (!record || record.lifetime !== lifetime) return null;
      return this.#probe({ port: record.port });
    });
  }

  /** The lifetime ended: its gateway is ended if confirmed, and its record dropped. A newer lifetime's is left. */
  end({ agentId, lifetime }) {
    this.#file(agentId);
    return this.#serially(agentId, async () => {
      const record = this.#read(agentId);
      if (!record || record.lifetime !== lifetime) return { ended: false };
      return { ended: await this.#endRecorded(agentId, record) };
    });
  }

  /** Every record, for the doctor and for reaping the ones whose lifetime is over. */
  records() {
    let names;
    try { names = fs.readdirSync(this.#dir); } catch { return []; }
    return names.filter((name) => name.endsWith('.json'))
      .map((name) => ({ agentId: name.slice(0, -'.json'.length), record: this.#read(name.slice(0, -'.json'.length)) }))
      .filter(({ record }) => record);
  }

  async #endRecorded(agentId, record) {
    let confirmed = false;
    if (record.pid > 0) { // 0: prepared, never registered; nothing was started that this book knows of
      try {
        const answers = await this.#processes([record.pid]);
        confirmed = isRecordedGateway(record, answers.get(record.pid));
      } catch { confirmed = false; }
    }
    if (confirmed) await this.#kill(record.pid);
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
