// The loopback hook receiver. A lifetime selects state; it is not authentication against local code.
// The daemon's browser-origin gate applies before this route. No keys or new policy live here.
export class AgentTurnEvents {
  #host;
  #instance;
  #report;
  #refusals = new Map();

  constructor({ host, instance, report = () => {} }) {
    this.#host = host;
    this.#instance = instance;
    this.#report = report;
  }

  refusals() { return Object.fromEntries(this.#refusals); }

  #refuse(status, agentId, reason) {
    this.#refusals.set(reason, (this.#refusals.get(reason) ?? 0) + 1);
    // Fixed reasons only. No payload, lifetime, process command line or write-error path in the log.
    this.#report(`agent turn event refused: ${reason}`);
    return { status, body: { agentId, applied: false, reason } };
  }

  receive(agentId, body) {
    if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.kind !== "string") {
      return this.#refuse(400, agentId, "malformed-event");
    }
    if (body.instance !== this.#instance) return this.#refuse(409, agentId, "wrong-instance");
    // Re-observe before admission, not just at boot. C3 must see an exit, reused pid or new conflict.
    try { this.#host.refresh(); }
    catch { return this.#refuse(503, agentId, "state-unavailable"); }
    let result;
    try {
      result = this.#host.applyEvent({ agentId, lifetime: body.lifetime, kind: body.kind, firedAtUs: body.firedAtUs });
    } catch {
      // The host commits memory only after its durable write. A write refusal is never applied:true.
      return this.#refuse(503, agentId, "persistence-failed");
    }
    if (!result.applied) return this.#refuse(409, agentId, result.reason);
    return { status: 200, body: { agentId, applied: true, reason: result.reason } };
  }
}
