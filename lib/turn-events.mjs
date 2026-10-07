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
//   turnIsBusy      the turn law on one turn record: only an OPEN turn can be busy
//
// TIME UNITS: microseconds, as the hooks stamp `firedAtUs`. turnIsBusy is the one place they become the turn law's
// milliseconds.

import { turnIsStillLive } from "./agent-state.mjs";

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
function orderTurnEvent(lastAtUs, event) {
  const at = event.firedAtUs;
  // A stored record without a usable last event (a damaged turns file) orders nothing, rather than reading as new.
  if (!Number.isSafeInteger(lastAtUs) || lastAtUs < 0) return { accept: false, reason: "unordered-record" };
  if (lastAtUs === 0) return { accept: true, reason: "first" };
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
  const turn = Object.hasOwn(turns, lifetime) ? turns[lifetime] : CLOSED;
  const order = orderTurnEvent(turn.lastEventAtUs, event);
  if (!order.accept) return { turns, applied: false, reason: order.reason, lifetime };
  const next = { ...EFFECTS[event.kind](turn, event.firedAtUs), lastEventAtUs: event.firedAtUs };
  return { turns: { ...turns, [lifetime]: next }, applied: true, reason: `${admission.reason}:${order.reason}`, lifetime };
}

/**
 * P-1: an accepted open turn holds while its lifetime is verified, without hook-age expiry. The existing
 * `renewable` flag now means current lifetime verification, not a periodic renewal. Unverified turns use the
 * strict legacy timer only. Closed turns keep ordering evidence but never count as busy.
 *
 * @param {{open: boolean, startedAtUs: number, lastEventAtUs: number}|undefined} turn
 * @param {{nowUs: number, renewable: boolean}} context
 */
export function turnIsBusy(turn, { nowUs, renewable }) {
  if (turn?.open !== true) return false;
  if (renewable === true) return true;
  const ms = (us) => Math.floor(us / 1000);
  return turnIsStillLive({ startedAt: ms(turn.startedAtUs), touchedAt: ms(turn.lastEventAtUs), renewable: false, now: ms(nowUs) });
}

/**
 * A turn stored before a restart, by what its lifetime is now (C3's table): restored and renewable for `yes`, closed
 * for `no`, and kept under the strict law only for `unknown`.
 *
 * @param {"yes"|"no"|"unknown"} verified
 * @returns {{keep: boolean, renewable: boolean, cause: string}}
 */
export function restoreTurn(verified) {
  if (verified === "yes") return { keep: true, renewable: true, cause: "restored" };
  if (verified === "no") return { keep: false, renewable: false, cause: "lifetime-ended" };
  return { keep: true, renewable: false, cause: "identity-unknown" };
}

/**
 * Every stored turn after a restart, by its lifetime's verdict now (`restoreTurn` per record). A lifetime that is
 * `no` loses its record; one the verdicts do not name is unknown, kept and not renewed, like any unknown.
 *
 * @param {Record<string, object>} turns   as read from the turns file
 * @param {(lifetime: string) => "yes"|"no"|"unknown"} verdictOf
 * @returns {{turns: Record<string, object>, renewable: Set<string>, ended: string[]}}
 */
export function restoreTurns(turns, verdictOf) {
  const kept = {};
  const renewable = new Set();
  const ended = [];
  for (const [lifetime, turn] of Object.entries(turns)) {
    const restored = restoreTurn(verdictOf(lifetime));
    if (!restored.keep) { ended.push(lifetime); continue; }
    kept[lifetime] = turn;
    if (restored.renewable) renewable.add(lifetime);
  }
  return { turns: kept, renewable, ended };
}
