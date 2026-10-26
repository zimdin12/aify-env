// The loopback route around an agent's hermes gateway (0.9.10). The launcher `prepare`s (a port, or the live gateway
// its lifetime already has), starts the gateway itself, and `register`s its pid. comms' delivery loop runs the launcher's
// own command for its gateway, so it asks through `prepare` too.
// The launcher starts it because the gateway carries the agent's environment and folder (lib/hermes-gateway-book.mjs).
//
// ADMISSION IS turn-event's (lib/agent-turn-events.mjs): the daemon's browser-origin gate first, then the request's
// instance picks the host (this daemon's own, or `residents` only while this process holds the role), and the lifetime
// it names must be that agent's CURRENT lifetime there. A superseded launch is refused, never handed its successor's
// gateway or port.

import { RESIDENTS } from './residents-home.mjs';

const OWN_OPERATION = Object.freeze({ guard() {}, done() {} });
const NOT_CURRENT = 'NOT_CURRENT';
const ACTIONS = new Set(['prepare', 'register']);

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
      // THE BOOK AWAITS (a probe, the OS) between admission and its effects, and the role or the lifetime can move in
      // that time: a released owner wrote over its successor's record (review of 85cbd1a, A2). So admission is asked
      // again at each effect, as turn-event's guard is.
      const fence = () => {
        target.op.guard();
        let now;
        try { now = target.host.rawIdentity(agentId); } catch { now = null; }
        if (!now || now.conflict || now.current?.lifetime !== lifetime) throw Object.assign(new Error('not-current'), { code: NOT_CURRENT });
      };
      return await this.#act(agentId, lifetime, body, fence);
    } catch (error) {
      if (error?.code === 'NOT_OWNER') return this.#refuse(409, agentId, 'not-owner');
      if (error?.code === NOT_CURRENT) return this.#refuse(409, agentId, 'not-current');
      throw error;
    } finally { target.op.done(); }
  }

  async #act(agentId, lifetime, body, fence) {
    if (body.action === 'prepare') {
      const { port, live } = await this.#book.prepare({ agentId, lifetime, fence });
      return { status: 200, body: { agentId, ok: true, port, ...(live ? { live: true, wsUrl: live.wsUrl, token: live.token } : { live: false }) } };
    }
    const { registered } = await this.#book.register({ agentId, lifetime, port: body.port, pid: body.pid, fence });
    return registered ? { status: 200, body: { agentId, ok: true } } : this.#refuse(409, agentId, 'not-prepared');
  }
}
