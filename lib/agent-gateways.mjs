// The loopback route that hands an agent its hermes gateway (0.9.10). The launcher asks with `ensure` before its TUI
// attaches; comms' delivery loop asks without it, and is told the gateway or that there is none.
//
// ADMISSION IS turn-event's (lib/agent-turn-events.mjs): the daemon's browser-origin gate first, then the request's
// instance picks the host (this daemon's own, or `residents` only while this process holds the role), and the lifetime
// it names must be that agent's CURRENT lifetime there. A superseded launch asking for a gateway is refused, never
// given its successor's.
//
// THE OWNER IS OUR RECORD'S, NOT THE CALLER'S. The gateway is tied to the pid aify-env recorded for that lifetime (the
// launcher), so a request cannot name some other process as the gateway's parent.

import { RESIDENTS } from './residents-home.mjs';

const OWN_OPERATION = Object.freeze({ done() {} });

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

  #refuse(status, agentId, reason, detail = '') {
    this.#report(`agent gateway refused: ${reason}`);
    return { status, body: { agentId, ok: false, reason, ...(detail ? { detail } : {}) } };
  }

  async receive(agentId, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.lifetime !== 'string') {
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
      const current = identity.current;
      if (!current || identity.conflict || current.lifetime !== body.lifetime) return this.#refuse(409, agentId, 'not-current');
      try {
        const gateway = body.ensure === true
          ? await this.#book.ensure({ agentId, lifetime: current.lifetime, ownerPid: current.pid })
          : await this.#book.current({ agentId, lifetime: current.lifetime });
        if (!gateway) return this.#refuse(404, agentId, 'no-gateway');
        return { status: 200, body: { agentId, ok: true, port: gateway.port, wsUrl: gateway.wsUrl, token: gateway.token } };
      } catch (error) {
        // The start's own reason, already redacted there: what the operator needs to repair hermes.
        return this.#refuse(502, agentId, 'gateway-failed', String(error?.message || error));
      }
    } finally { target.op.done(); }
  }
}
