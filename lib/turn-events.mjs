// A turn event, admitted to one lifetime's turn and then ordered within it (0.9 plan P0 C3).
//
// PURE. Two questions, asked in this order and kept apart, because each protects a different thing:
//   admitTurnEvent  WHOSE turn may this event touch? Decided by the lifetime it names and C4's verdicts, never by its
//                   time. An event that names no lifetime, or cannot be ordered, touches nothing.
//   orderTurnEvent  WHEN, within that one lifetime: the timestamp rules of aify-comms `accept_hook_event`, against
//                   that lifetime's own last event. No event of another lifetime reaches it, so the port has no
//                   owner-change branch. That branch let an unbound end at 100 replace a bound turn's last event at
//                   200 as "first of a new owner", and close it (review of 591d172f, R1).
//   applyTurnEvent  both, then the event's effect on that lifetime's turn, as aify-comms `status_engine.apply_event`
//                   has it. A turn's run id stays in aify-comms with the delivery it belongs to.
//
// TIME UNITS: microseconds, as the hooks stamp `firedAtUs`.

/** Each kind's effect on a turn. The keys are the vocabulary: a kind not here is refused, never ordered. */
const EFFECTS = {
  "turn-start": (turn, at) => ({ open: true, startedAtUs: turn.open ? turn.startedAtUs : at, awaitingInput: false }),
  "turn-end": () => ({ open: false, startedAtUs: 0, awaitingInput: false }),
  "blocked": (turn) => ({ ...turn, awaitingInput: true }),
  "unblocked": (turn) => ({ ...turn, awaitingInput: false }),
};

const CLOSED = { open: false, startedAtUs: 0, awaitingInput: false, lastEventAtUs: 0 };

/**
 * May this event touch a turn, and whose? `lifetimes` is one agent's entry from `currentLifetimes` (C4), or
 * undefined when the agent has no record at all.
 *
 * @param {{firedAtUs?: number, lifetime?: string, kind?: string}} event
 * @param {{current: {lifetime: string}|null, conflict: object[]|null, unknown: {lifetime: string}[]}|undefined} lifetimes
 * @returns {{admit: true, lifetime: string, reason: string} | {admit: false, reason: string}}
 */
function admitTurnEvent(event, lifetimes) {
  if (!Object.hasOwn(EFFECTS, event?.kind)) return { admit: false, reason: "unknown-kind" };
  // A 0.9 launcher and bridge always stamp the time. An end that cannot be ordered could close a newer turn.
  if (!Number.isSafeInteger(event.firedAtUs) || event.firedAtUs <= 0) return { admit: false, reason: "no-timestamp" };
  // C4 adopts a resident only from its lifetime record, so an event naming none (a launcher from before 0.9) has no
  // turn here to belong to. It is counted by the caller, and never applied.
  const lifetime = typeof event.lifetime === "string" ? event.lifetime : "";
  if (!lifetime) return { admit: false, reason: "unbound" };
  if (lifetimes?.conflict) return { admit: false, reason: "conflict" };
  if (lifetimes?.current?.lifetime === lifetime) return { admit: true, lifetime, reason: "current" };
  if ((lifetimes?.unknown ?? []).some((record) => record.lifetime === lifetime)) {
    // C3's retained turn: closed by its own end, and never renewed or re-anchored by anything else.
    return event.kind === "turn-end"
      ? { admit: true, lifetime, reason: "retained-end" }
      : { admit: false, reason: "identity-unknown" };
  }
  return { admit: false, reason: "not-current" };
}

/**
 * Within one lifetime: does this event come after the last one applied? `lastAtUs` is 0 before the first.
 *
 * @returns {{accept: boolean, reason: string}}
 */
export function orderTurnEvent(lastAtUs, event) {
  const at = event.firedAtUs;
  if (!lastAtUs) return { accept: true, reason: "first" };
  if (at > lastAtUs) return { accept: true, reason: "later" };
  if (at === lastAtUs && event.kind === "turn-end") return { accept: true, reason: "end-wins-tie" };
  return { accept: false, reason: "out-of-order" };
}

/**
 * One agent's turns, keyed by lifetime, after this event. A refused event returns the same object. A lifetime's
 * record outlives its turn, because its last event is what orders the next one.
 *
 * @param {Record<string, {open: boolean, startedAtUs: number, awaitingInput: boolean, lastEventAtUs: number}>} turns
 * @returns {{turns: object, applied: boolean, reason: string, lifetime?: string}}
 */
export function applyTurnEvent(turns, event, lifetimes) {
  const admission = admitTurnEvent(event, lifetimes);
  if (!admission.admit) return { turns, applied: false, reason: admission.reason };
  const { lifetime } = admission;
  const turn = turns[lifetime] ?? CLOSED;
  const order = orderTurnEvent(turn.lastEventAtUs, event);
  if (!order.accept) return { turns, applied: false, reason: order.reason, lifetime };
  const next = { ...EFFECTS[event.kind](turn, event.firedAtUs), lastEventAtUs: event.firedAtUs };
  return { turns: { ...turns, [lifetime]: next }, applied: true, reason: `${admission.reason}:${order.reason}`, lifetime };
}
