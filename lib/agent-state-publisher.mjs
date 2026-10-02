// The order agent-state publications go out in (0.9 plan P0 C5).
//
// ONE PUBLISHER PER INSTANCE, so it is an object: it holds the incarnation (a durable generation and a random id),
// the one publication counter every body takes a number from, and what the last body said about each agent. It does
// no I/O. The host gives it what it enumerated; it answers with the body to send, or nothing when nothing changed.
// Sending (one push in flight per destination) and persisting the generation are the caller's.
//
//   nextGeneration(persisted, nowMs)   max(persisted + 1, nowMs): strictly increasing across restarts whatever the
//                                      clock does, and recovering a lost file on a host whose clock is sane
//   publisher.snapshot(enumeration)   a complete snapshot, or `unavailable` when the enumeration was not complete
//   publisher.changes(enumeration)    the agents that changed and the lifetimes that ended, or null

import { createHash } from "node:crypto";

export function nextGeneration(persisted, nowMs) {
  const last = Number.isSafeInteger(persisted) && persisted > 0 ? persisted : 0;
  return Math.max(last + 1, Math.floor(nowMs));
}

/**
 * What a reader acts on, so a change to it is a change worth a push. The ages and observation times move on every
 * publication and are published, but are not part of this: otherwise every agent would change on every push.
 */
function meaning(record) {
  const { state, stateCause, busy, lifetime, mode, harness, lifecycle, runsWith } = record;
  const turn = record.turn ?? {};
  return JSON.stringify([state, stateCause, busy, lifetime, mode, harness, lifecycle ?? null, runsWith ?? null,
    record.process?.state ?? null, record.process?.verified ?? null, record.process?.pid ?? null,
    turn.open ?? null, turn.startedAt ?? null, turn.lastEventAt ?? null, turn.awaitingInput ?? null, turn.busyIf ?? null,
    record.screen?.state ?? null, record.background?.shells ?? null]);
}

function digest(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export class AgentStatePublisher {
  #identity;
  #publication = 0;
  /** agentId -> {lifetime, meaning} as the last body left it */
  #sent = new Map();

  constructor({ machineId, instance, generation, incarnationId }) {
    if (!machineId || !instance) throw new TypeError("a publisher needs its machineId and instance");
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError("a publisher needs a positive integer generation");
    if (!incarnationId) throw new TypeError("a publisher needs an incarnationId");
    this.#identity = { machineId, instance, generation, incarnationId };
  }

  get identity() { return { ...this.#identity, publication: this.#publication }; }

  #body(kind, fields) {
    this.#publication += 1;
    const body = { kind, ...this.#identity, publication: this.#publication, ...fields };
    return { body, digest: digest(body) };
  }

  /**
   * Everything this instance publishes, or `unavailable` when the enumeration was not complete. A partial
   * enumeration is never a snapshot, because a receiver reads absence from a snapshot as gone.
   *
   * @param {{complete: boolean, agents?: object[], reason?: string}} enumeration
   */
  snapshot(enumeration) {
    if (!enumeration?.complete) {
      return this.#body("unavailable", { reason: String(enumeration?.reason || "enumeration incomplete") });
    }
    const agents = [...(enumeration.agents ?? [])];
    this.#sent = new Map(agents.map((record) => [record.agentId, { lifetime: record.lifetime, meaning: meaning(record) }]));
    return this.#body("snapshot", { complete: true, agents, removed: [] });
  }

  /**
   * The agents whose meaning changed since the last body, and the lifetimes that ended. Null when there is nothing,
   * so a quiet host spends no publication number between snapshots. An incomplete enumeration sends no changes: what
   * is missing from it may be missing only from it.
   */
  changes(enumeration) {
    if (!enumeration?.complete) return null;
    const now = new Map((enumeration.agents ?? []).map((record) => [record.agentId, record]));
    const changed = [];
    const removed = [];
    for (const [agentId, record] of now) {
      const before = this.#sent.get(agentId);
      if (!before || before.lifetime !== record.lifetime || before.meaning !== meaning(record)) changed.push(record);
      if (before && before.lifetime !== record.lifetime) removed.push({ agentId, lifetime: before.lifetime });
    }
    for (const [agentId, before] of this.#sent) {
      if (!now.has(agentId)) removed.push({ agentId, lifetime: before.lifetime });
    }
    if (!changed.length && !removed.length) return null;
    for (const { agentId } of removed) if (!now.has(agentId)) this.#sent.delete(agentId);
    for (const record of changed) this.#sent.set(record.agentId, { lifetime: record.lifetime, meaning: meaning(record) });
    return this.#body("changes", { agents: changed, removed });
  }
}
