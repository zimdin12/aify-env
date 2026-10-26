// The loopback route around an agent's hermes gateway (0.9.10). The launcher `prepare`s (a port, or the live gateway
// its lifetime already has), starts the gateway itself, and `register`s its pid; comms' delivery loop asks `current`.
// The launcher starts it because the gateway carries the agent's environment and folder (lib/hermes-gateway-book.mjs).
//
// ADMISSION IS turn-event's (lib/agent-turn-events.mjs): the daemon's browser-origin gate first, then the request's
// instance picks the host (this daemon's own, or `residents` only while this process holds the role), and the lifetime
// it names must be that agent's CURRENT lifetime there. A superseded launch is refused, never handed its successor's
// gateway or port.

import { RESIDENTS } from './residents-home.mjs';

const OWN_OPERATION = Object.freeze({ done() {} });
const ACTIONS = new Set(['prepare', 'register', 'current']);

export class AgentGateways {
  #host;
  #instance;
  #residents;
  #book;
  #report;

  constructor({ host, instance, residents = null, book, report = () => {} }) {
    this.#host = host;
    this.#instance = instance;
    this.#residents = residents;
    this.#book = book;
    this.#report = report;
  }

  #refuse(status, agentId, reason) {
    this.#report(`agent gateway refused: ${reason}`);
    return { status, body: { agentId, ok: false, reason } };
  }

  async receive(agentId, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.lifetime !== 'string'
      || !ACTIONS.has(body.action)) {
      return this.#refuse(400, agentId, 'malformed-request');
    }
    let target;
    if (body.instance === this.#instance) target = { host: this.#host, op: OWN_OPERATION };
    else if (body.instance === RESIDENTS) {
      target = this.#residents?.enter() ?? null;
      if (!target) return this.#refuse(409, agentId, 'not-owner');
    } else return this.#refuse(409, agentId, 'wrong-instance');
    try {
      let identity;
      try { identity = target.host.rawIdentity(agentId); }
      catch { return this.#refuse(503, agentId, 'state-unavailable'); }
      const lifetime = identity.current?.lifetime;
      if (!lifetime || identity.conflict || lifetime !== body.lifetime) return this.#refuse(409, agentId, 'not-current');
      return await this.#act(agentId, lifetime, body);
    } finally { target.op.done(); }
  }

  async #act(agentId, lifetime, body) {
    if (body.action === 'prepare') {
      const { port, live } = await this.#book.prepare({ agentId, lifetime });
      return { status: 200, body: { agentId, ok: true, port, ...(live ? { live: true, wsUrl: live.wsUrl, token: live.token } : { live: false }) } };
    }
    if (body.action === 'register') {
      const { registered } = await this.#book.register({ agentId, lifetime, port: body.port, pid: body.pid });
      return registered ? { status: 200, body: { agentId, ok: true } } : this.#refuse(409, agentId, 'not-prepared');
    }
    const live = await this.#book.current({ agentId, lifetime });
    return live
      ? { status: 200, body: { agentId, ok: true, port: live.port, wsUrl: live.wsUrl, token: live.token } }
      : this.#refuse(404, agentId, 'no-gateway');
  }
}
