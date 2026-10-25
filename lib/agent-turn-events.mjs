// The loopback hook receiver. A lifetime selects state; it is not authentication against local code.
// The daemon's browser-origin gate applies before this route. No keys or new policy live here.
//
// TWO ADDRESSES (B1). An event naming this daemon's own instance goes to its own host. An event naming `residents` goes
// to the residents host only while this process holds the role, and is refused `not-owner` otherwise, so a stale
// `residents.json` that reaches a non-holder changes nothing. The role is asked again at the save itself.
import { RESIDENTS } from "./residents-home.mjs";

const OWN_OPERATION = Object.freeze({ guard() {}, done() {} });

export class AgentTurnEvents {
  #host;
  #instance;
  #residents;
  #report;
  #onApplied;
  #refusals = new Map();

  /** `onApplied` is told after an event applied, so the turn it opened or closed is published then, not on a timer. */
  constructor({ host, instance, residents = null, report = () => {}, onApplied = () => {} }) {
    this.#host = host;
    this.#instance = instance;
    this.#residents = residents;
    this.#report = report;
    this.#onApplied = onApplied;
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
    let target;
    if (body.instance === this.#instance) target = { host: this.#host, op: OWN_OPERATION };
    else if (body.instance === RESIDENTS) {
      target = this.#residents?.enter() ?? null;
      if (!target) return this.#refuse(409, agentId, "not-owner");
    } else return this.#refuse(409, agentId, "wrong-instance");
    try {
      // Re-observe before admission, not just at boot. C3 must see an exit, reused pid or new conflict.
      try { target.host.refresh(); }
      catch { return this.#refuse(503, agentId, "state-unavailable"); }
      let result;
      try {
        result = target.host.applyEvent({ agentId, lifetime: body.lifetime, kind: body.kind, firedAtUs: body.firedAtUs },
          { guard: target.op.guard });
      } catch (error) {
        if (error?.code === "NOT_OWNER") return this.#refuse(409, agentId, "not-owner");
        // The host commits memory only after its durable write. A write refusal is never applied:true.
        return this.#refuse(503, agentId, "persistence-failed");
      }
      if (!result.applied) return this.#refuse(409, agentId, result.reason);
      try { this.#onApplied(); } catch { /* a notice never fails an applied event */ }
      return { status: 200, body: { agentId, applied: true, reason: result.reason } };
    } finally { target.op.done(); }
  }
}
