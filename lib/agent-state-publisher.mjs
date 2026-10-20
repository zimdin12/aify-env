// The order agent-state publications go out in (0.9 plan P0 C5).
//
// ONE PUBLISHER PER INSTANCE, so it is an object: it holds the incarnation (a durable generation and a random id)
// and the one publication counter every body takes a number from. It does no I/O, and it keeps no memory of what a
// destination has: that is the destination's VIEW, which each body comes with and which its sender keeps only once
// the destination has acknowledged the body. A body that was lost, refused or held back therefore changes nothing,
// and the next one is computed against what that destination really has. A sender with no view sends a snapshot.
//
//   nextGeneration(persisted, nowMs)        max(persisted + 1, nowMs): strictly increasing across restarts whatever
//                                           the clock does, and recovering a lost file on a host whose clock is sane
//   publisher.snapshot(enumeration)        a complete snapshot, or `unavailable` when the enumeration is not whole
//   publisher.changes(enumeration, view)   what changed since `view`, a snapshot when there is no view, or null
//
// EVERY BODY CARRIES what the receiver needs to bind it to code and time (B6): `build`, the code this process
// LOADED, only when it is known and well formed (never the code on disk now); and on each open turn `ageMs`, the
// turn's age on this clock at the moment the body is built. An age that cannot be stated (a closed turn, no start,
// a start in the future) is omitted, never guessed: the receiver reads a missing age as unknown.
// Every body but `retired` also carries `reportEveryMs`, how often this aify-env reports in full (decision 2), when it
// is whole milliseconds within aify-comms' bounds; outside them it is omitted, never null.
//
// RETIREMENT (B5): `published` is every lifetime a numbered body named, in `agents` or `removed`, taken AT NUMBERING,
// so a body aborted in flight, unacknowledged or never sent is in it too: any of them may have committed.
// `retire()` numbers one `retired` body after every other and refuses every body after it, so nothing this instance
// numbers can arrive later than its retirement.

import { createHash } from "node:crypto";

/** What aify-comms admits as a build: printable ASCII with no space, 1-200 characters. */
const BUILD = /^[\x21-\x7e]{1,200}$/;
/** What aify-comms admits as `reportEveryMs`: whole milliseconds from 1 s to 1 h. */
const reportsWithin = (ms) => Number.isSafeInteger(ms) && ms >= 1_000 && ms <= 3_600_000;

export function nextGeneration(persisted, nowMs) {
  // EXHAUSTED IS NOT LOST. A saved number at or past the safe-integer limit has no successor, and reading it as no
  // file would restart from the clock, below generations already used (review of a80dbc7, G1). It throws, before
  // any caller can save or publish under it.
  if (typeof persisted === "number" && persisted >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`the generation is exhausted at ${persisted}: no safe integer is above it`);
  }
  const last = Number.isSafeInteger(persisted) && persisted > 0 ? persisted : 0;
  const next = Math.max(last + 1, Math.floor(nowMs));
  if (!Number.isSafeInteger(next)) throw new RangeError(`no safe generation from a clock of ${nowMs}`);
  return next;
}

/** Fields that move on every publication without the agent changing. Everything else in a record is its meaning. */
const VOLATILE = new Set(["ageMs", "observedAt"]);

/** A record's meaning as one string: its fields in a stable order, with the volatile ones left out at any depth. */
function meaning(value) {
  if (Array.isArray(value)) return `[${value.map(meaning).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => !VOLATILE.has(key)).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${meaning(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** The enumeration's records by agent, or the reason it cannot be published as a whole. */
function recordsOf(enumeration) {
  if (!enumeration?.complete) return { problem: String(enumeration?.reason || "enumeration incomplete") };
  const byAgent = new Map();
  for (const record of enumeration.agents ?? []) {
    if (typeof record?.agentId !== "string" || !record.agentId
      || !(record.lifetime === null || (typeof record.lifetime === "string" && record.lifetime))) {
      return { problem: "a record without its agentId and lifetime" };
    }
    if (byAgent.has(record.agentId)) return { problem: `${record.agentId} enumerated twice` };
    byAgent.set(record.agentId, record);
  }
  return { byAgent };
}

/** What a destination has once it acknowledges a body: per agent, the lifetime and the meaning. */
function viewOf(byAgent) {
  return new Map([...byAgent].map(([agentId, record]) => [agentId, { lifetime: record.lifetime, meaning: meaning(record) }]));
}

/** An open turn's age in whole milliseconds at `nowMs`, or undefined when it cannot be stated. */
function turnAgeMs(turn, nowMs) {
  if (!turn?.open || !Number.isSafeInteger(turn.startedAtUs) || turn.startedAtUs <= 0) return undefined;
  const age = Math.floor(nowMs - turn.startedAtUs / 1000);
  return Number.isSafeInteger(age) && age >= 0 ? age : undefined;
}

export class AgentStatePublisher {
  #identity;
  #build;
  #reportEveryMs;
  #nowMs;
  #publication = 0;
  #published = new Set();
  #retired = false;

  /**
   * @param {object} options
   * @param {string|null} [options.build]  the build this process loaded; omitted from every body unless well formed
   * @param {() => number} [options.nowMs] the clock each body's turn ages are taken on
   * @param {number|null} [options.reportEveryMs] how often the sender reports in full; omitted unless within bounds
   */
  constructor({ machineId, instance, generation, incarnationId, build = null, reportEveryMs = null, nowMs = Date.now }) {
    if (!machineId || !instance) throw new TypeError("a publisher needs its machineId and instance");
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new TypeError("a publisher needs a positive integer generation");
    if (!incarnationId) throw new TypeError("a publisher needs an incarnationId");
    this.#identity = { machineId, instance, generation, incarnationId };
    this.#build = typeof build === "string" && BUILD.test(build) ? build : null;
    this.#reportEveryMs = reportsWithin(reportEveryMs) ? reportEveryMs : null;
    this.#nowMs = nowMs;
  }

  get identity() { return { ...this.#identity, publication: this.#publication }; }

  /** Every lifetime a numbered body named, whether or not any destination acknowledged it. */
  get published() { return new Set(this.#published); }

  #body(kind, fields, view) {
    if (this.#retired) throw new Error("this publisher retired its key: no body is numbered after the retirement");
    this.#publication += 1;
    const build = this.#build === null ? {} : { build: this.#build };
    // A retirement announces no interval: after it, this key reports nothing.
    const cadence = this.#reportEveryMs === null || kind === "retired" ? {} : { reportEveryMs: this.#reportEveryMs };
    const body = structuredClone({ kind, ...this.#identity, publication: this.#publication, ...build, ...cadence, ...fields });
    const now = this.#nowMs();
    for (const record of body.agents ?? []) {
      if (!record.turn) continue;
      const age = turnAgeMs(record.turn, now);
      if (age === undefined) delete record.turn.ageMs;
      else record.turn.ageMs = age;
    }
    for (const row of [...(body.agents ?? []), ...(body.removed ?? [])]) {
      if (typeof row?.lifetime === "string" && row.lifetime) this.#published.add(row.lifetime);
    }
    return { body, digest: digest(body), view };
  }

  /**
   * The `retired` body: numbered after every body this instance numbered, carrying no agents and no removals. From
   * here on every body is refused, so no later publication of this key can exist. Proving that the key holds nothing
   * is the caller's (AgentStateHost.retirementProof); this only numbers.
   */
  retire() {
    const publication = this.#body("retired", { reason: "shutdown", inputs: {} }, null);
    this.#retired = true;
    return publication;
  }

  /**
   * Everything this instance publishes, or `unavailable` when the enumeration is not whole. A partial enumeration
   * is never a snapshot, because a receiver reads absence from a snapshot as gone; `unavailable` carries no view,
   * so the sender keeps the one it had.
   *
   * @param {{complete: boolean, agents?: object[], reason?: string}} enumeration
   */
  snapshot(enumeration) {
    const { byAgent, problem } = recordsOf(enumeration);
    const inputs = enumeration?.inputs === undefined ? {} : { inputs: enumeration.inputs };
    if (problem) return this.#body("unavailable", { reason: problem, ...inputs }, null);
    return this.#body("snapshot", { complete: true, agents: [...byAgent.values()], removed: [], ...inputs }, viewOf(byAgent));
  }

  /**
   * The agents whose meaning changed since `view` and the lifetimes that ended, as a body with the view the
   * destination will have once it takes it. Null when nothing changed, so a quiet host spends no publication number
   * between snapshots, and null for an enumeration that is not whole: what is missing from it may be missing only
   * from it. With no view, a snapshot; and a snapshot when a row with no lifetime left, which no removal can name.
   *
   * @param {{complete: boolean, agents?: object[]}} enumeration
   * @param {Map<string, {lifetime: string, meaning: string}>|null} view
   */
  changes(enumeration, view) {
    if (!view) return this.snapshot(enumeration);
    const { byAgent, problem } = recordsOf(enumeration);
    if (problem) return null;
    const changed = [];
    const removed = [];
    for (const [agentId, record] of byAgent) {
      const before = view.get(agentId);
      if (!before || before.lifetime !== record.lifetime || before.meaning !== meaning(record)) changed.push(record);
      if (before && before.lifetime !== record.lifetime && typeof before.lifetime === "string" && before.lifetime) {
        removed.push({ agentId, lifetime: before.lifetime });
      }
    }
    for (const [agentId, before] of view) {
      if (byAgent.has(agentId)) continue;
      // A ROW THAT LEFT WITH NO LIFETIME CAN BE WITHDRAWN ONLY BY A SNAPSHOT: a removal names a lifetime, and the
      // receiver takes no other. A cold managed row whose agent became a live resident left this way (review of 462022e).
      if (typeof before.lifetime !== "string" || !before.lifetime) return this.snapshot(enumeration);
      removed.push({ agentId, lifetime: before.lifetime });
    }
    if (!changed.length && !removed.length) return null;
    const inputs = enumeration?.inputs === undefined ? {} : { inputs: enumeration.inputs };
    return this.#body("changes", { agents: changed, removed, ...inputs }, viewOf(byAgent));
  }
}
