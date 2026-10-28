// Host effects and receipts only. Services own submission and claims.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileDurably } from './durable-file.mjs';
import { HARNESS_RUNTIME } from './agent-definition-requests.mjs';

const keyFor = (r) => `${r.storeId}:${r.expectedIncarnation}:${r.agentId}`;
const intent = (r) => JSON.stringify([r.id, r.agentId, r.machineId, r.storeId, r.expectedIncarnation,
  r.expectedRevision, r.expectedLifetime, r.action, r.requestedBy, r.freshContext ?? false]);
const result = (status, outcome, resultLifetime = null, finishedAt = new Date().toISOString()) =>
  ({ status, outcome, resultLifetime, finishedAt });
/** Every action this host's lifecycle runs, and so every action it claims: aify-comms refuses the rest at the claim. */
export const LIFECYCLE_ACTIONS = Object.freeze(['start', 'spawn', 'restart', 'stop', 'kill', 'delete', 'release']);
const actions = new Set(LIFECYCLE_ACTIONS);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.length > 0;
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const counter = v => Number.isSafeInteger(v) && v > 0;
function residentStopKey(binding) {
  if (!object(binding) || !identifier(binding.agentId) || !text(binding.storeId) || !counter(binding.incarnation))
    throw new TypeError('invalid resident stop binding');
  return `${binding.storeId}:${binding.incarnation}:${binding.agentId}`;
}
function stopReceipt(state, key, agentId) {
  // Legacy writers cannot bump the counter. Their existing receipts still fence a later Stop.
  // ponytail: any receipt for this agent invalidates the capture; narrow only if benign churn blocks hand starts.
  const rows = Object.entries(state.records).filter(([, row]) => row.agentId === agentId)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash('sha256').update(JSON.stringify([key, state.stops[key] ?? false, rows])).digest('hex');
}
const validOwner = v => object(v) && ['scope', 'generation', 'pid', 'createdAtUs'].every(k => Object.hasOwn(v, k))
  && text(v.scope) && counter(v.generation) && counter(v.pid)
  && (v.createdAtUs === null || counter(v.createdAtUs));
function obsoleteOwner(saved, reading) {
  if (!saved) return false;
  return reading?.alive === false || (reading?.alive === true && counter(saved.createdAtUs)
    && counter(reading.createdAtUs) && saved.createdAtUs !== reading.createdAtUs);
}
/** Whether this host can run `r` at all: its shape, and an action in LIFECYCLE_ACTIONS. Asked before any effect. */
export function validRequest(r) {
  return object(r) && identifier(r.id) && identifier(r.agentId) && text(r.machineId)
    && text(r.storeId) && counter(r.expectedIncarnation) && counter(r.expectedRevision)
    && Object.hasOwn(r, 'expectedLifetime') && (r.expectedLifetime === null || text(r.expectedLifetime))
    && actions.has(r.action) && text(r.requestedBy)
    && (r.freshContext === undefined || typeof r.freshContext === 'boolean');
}
function validResult(v) {
  return object(v) && ['status', 'outcome', 'resultLifetime', 'finishedAt'].every(key => Object.hasOwn(v, key))
    && ['done', 'failed', 'refused'].includes(v.status)
    && typeof v.outcome === 'string' && (v.resultLifetime === null || text(v.resultLifetime))
    && text(v.finishedAt) && ((!Object.hasOwn(v, 'resultIncarnation') && !Object.hasOwn(v, 'resultRevision'))
      || (counter(v.resultIncarnation) && counter(v.resultRevision)));
}
function validRow(id, row) {
  if (!object(row) || typeof row.intent !== 'string') return false;
  if (Object.hasOwn(row, 'owner') && !validOwner(row.owner)) return false;
  let tuple;
  try { tuple = JSON.parse(row.intent); } catch { return false; }
  if (!Array.isArray(tuple) || tuple.length !== 10 || typeof tuple[9] !== 'boolean') return false;
  const [requestId, agentId, machineId, storeId, expectedIncarnation, expectedRevision,
    expectedLifetime, action, requestedBy, freshContext] = tuple;
  const request = { id: requestId, agentId, machineId, storeId, expectedIncarnation, expectedRevision,
    expectedLifetime, action, requestedBy, freshContext };
  if (!validRequest(request) || intent(request) !== row.intent || id !== requestId || row.agentId !== agentId
    || !validResult(row.unknown) || row.unknown.status !== 'failed'
    || row.unknown.outcome !== 'execution-unknown' || row.unknown.resultLifetime !== null) return false;
  if (row.phase === 'pending') return !Object.hasOwn(row, 'result');
  return row.phase === 'terminal' && validResult(row.result)
    && (action !== 'delete' || row.result.status !== 'done'
      || (counter(row.result.resultIncarnation) && counter(row.result.resultRevision)));
}
function validateJournal(s) {
  const held = new Set();
  if (!object(s) || s.version !== 1 || !object(s.records) || !object(s.stops)
    || Object.values(s.stops).some(v => typeof v !== 'boolean')
    || (s.stopRevisions !== undefined && (!object(s.stopRevisions)
      || Object.values(s.stopRevisions).some(v => !Number.isSafeInteger(v) || v < 0)))
    || Object.entries(s.records).some(([id, row]) => {
      if (!validRow(id, row)) return true;
      if (row.phase !== 'pending') return false;
      if (held.has(row.agentId)) return true;
      held.add(row.agentId); return false;
    })) throw new Error('lifecycle-journal-malformed');
  return s;
}

/** Short filesystem transactions protect reservations across executor instances. A stranded lock
 * fails closed; it is never broken by age or by a service retry. */
export class LifecycleJournal {
  #file;
  #owner;
  #onStopChange;
  #stopMoved = false;
  /** `onStopChange` is told after a durable write moved a stop fact, so the agent's new word is published then. */
  constructor({ file, owner = null, onStopChange = () => {} }) {
    if (owner !== null && !validOwner(owner)) throw new TypeError('invalid lifecycle owner');
    this.#file = file; this.#owner = structuredClone(owner); this.#onStopChange = onStopChange;
  }
  #read() {
    let s;
    try { s = JSON.parse(fs.readFileSync(this.#file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') throw Object.assign(new Error('lifecycle journal missing'), { code: 'LIFECYCLE_JOURNAL_MISSING' });
      throw e;
    }
    return validateJournal(s);
  }
  #locked(fn) {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const lock = `${this.#file}.lock`;
    const fd = fs.openSync(lock, 'wx');
    let answer, moved;
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd);
      answer = fn();
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); moved = this.#stopMoved; this.#stopMoved = false; }
    // Only after the write landed and the lock is released: a refused write moved nothing anyone can read.
    if (moved) { try { this.#onStopChange(); } catch { /* a notice never fails a durable change */ } }
    return answer;
  }
  /** Only the daemon boot owner may initialize an absent journal, before its first generation. */
  initialize({ priorBoot } = {}) {
    if (typeof priorBoot !== 'boolean') throw new TypeError('priorBoot must be boolean');
    this.#locked(() => {
      try { this.#read(); return; }
      catch (error) { if (error.code !== 'LIFECYCLE_JOURNAL_MISSING' || priorBoot) throw error; }
      const state = validateJournal({ version: 1, records: {}, stops: {} });
      writeFileDurably(this.#file, JSON.stringify(state));
    });
  }
  #change(fn) {
    return this.#locked(() => {
      const state = this.#read(); const answer = fn(state);
      validateJournal(state);
      writeFileDurably(this.#file, JSON.stringify(state));
      return structuredClone(answer);
    });
  }
  #writeStop(state, key, stopped) {
    const revision = state.stopRevisions?.[key] ?? 0;
    if (revision === Number.MAX_SAFE_INTEGER) throw new Error('lifecycle-stop-revision-exhausted');
    state.stops[key] = stopped;
    (state.stopRevisions ??= {})[key] = revision + 1;
    this.#stopMoved = true;
  }
  /** Read one atomic journal image. Legacy booleans begin at revision zero; no reservation or write. */
  stopSnapshot(binding) {
    const key = residentStopKey(binding), state = this.#read();
    return { stopped: state.stops[key] === true, revision: state.stopRevisions?.[key] ?? 0,
      receipt: stopReceipt(state, key, binding.agentId) };
  }
  /** The definition/identity owner admits the launch. This transaction consumes its stop revision once. */
  consumeResidentStart(binding, { live } = {}) {
    const key = residentStopKey(binding);
    if (!Number.isSafeInteger(binding.stopRevision) || binding.stopRevision < 0
      || typeof binding.stopReceipt !== 'string' || !/^[0-9a-f]{64}$/.test(binding.stopReceipt) || typeof live !== 'function')
      throw new TypeError('invalid resident stop consumption');
    return this.#locked(() => {
      const state = this.#read();
      if (!live()) return { consumed: false, reason: 'not-owner' };
      if (Object.values(state.records).some(row => row.agentId === binding.agentId && row.phase === 'pending'))
        return { consumed: false, reason: 'agent-reserved' };
      if ((state.stopRevisions?.[key] ?? 0) !== binding.stopRevision
        || stopReceipt(state, key, binding.agentId) !== binding.stopReceipt) return { consumed: false, reason: 'stop-moved' };
      this.#writeStop(state, key, false);
      validateJournal(state);
      writeFileDurably(this.#file, JSON.stringify(state), { guard: () => {
        if (!live()) throw Object.assign(new Error('not-owner'), { code: 'NOT_OWNER' });
      } });
      return { consumed: true, reason: 'resident-start' };
    });
  }
  reserveAutomaticStart(request) { return this.reserve(request, { automatic: true }); }
  reserve(request, { automatic = false } = {}) {
    if (!validRequest(request)) throw new TypeError('invalid lifecycle request');
    return this.#change(s => {
      const digest = intent(request); const old = Object.hasOwn(s.records, request.id) ? s.records[request.id] : null;
      if (old) return { fresh: false, result: old.intent === digest
        ? (old.result ?? old.unknown) : result('refused', 'idempotency-conflict') };
      const held = Object.values(s.records).some(r => r.agentId === request.agentId && r.phase === 'pending');
      const refusal = automatic && s.stops[keyFor(request)] === true ? 'stopped-by-operator'
        : held ? 'agent-reserved' : null;
      const unknown = result('failed', 'execution-unknown');
      const row = { intent: digest, agentId: request.agentId, phase: refusal ? 'terminal' : 'pending', unknown };
      if (this.#owner !== null) row.owner = structuredClone(this.#owner);
      if (refusal) row.result = result('refused', refusal);
      s.records[request.id] = row;
      return refusal ? { fresh: false, result: row.result } : { fresh: true, unknown };
    });
  }
  finish(request, answer, stopFact) {
    return this.#change(s => {
      const row = s.records[request.id];
      if (!row || row.intent !== intent(request)) throw new Error('receipt-intent-moved');
      if (row.phase === 'terminal') return row.result;
      row.result = answer; row.phase = 'terminal';
      if (stopFact !== undefined) this.#writeStop(s, keyFor(request), stopFact);
      return row.result;
    });
  }
  markStopped(request) {
    this.#change(s => {
      if (s.records[request.id]?.intent !== intent(request)) throw new Error('receipt-intent-moved');
      this.#writeStop(s, keyFor(request), true);
    });
  }
  stopFacts() { return new Map(Object.entries(this.#read().stops)); }
  open() { return Object.entries(this.#read().records).filter(([, r]) => r.phase === 'pending').map(([id, r]) => ({ id, ...r })); }
  /** Boot only. Compare the observed custody again under the journal lock; preserve its original receipt. */
  settleObsolete({ owner, observed, readings }) {
    if (!validOwner(owner) || !Array.isArray(observed) || !(readings instanceof Map))
      throw new TypeError('invalid lifecycle recovery');
    if (observed.length === 0) return 0;
    return this.#change(s => {
      let settled = 0;
      for (const before of observed) {
        const row = Object.hasOwn(s.records, before.id) ? s.records[before.id] : null;
        if (row?.phase !== 'pending' || row.intent !== before.intent
          || JSON.stringify(row.owner) !== JSON.stringify(before.owner)
          || !obsoleteOwner(row.owner, readings.get(row.owner?.pid))) continue;
        row.phase = 'terminal'; row.result = row.unknown; settled++;
      }
      return settled;
    });
  }
}

/** Effects are injected. The identity reader returns raw facts, never the displayed state word. */
export class AgentLifecycle {
  #deps;
  constructor(deps) { this.#deps = deps; }
  async execute(request, invocation = null) {
    if (!validRequest(request)) throw new TypeError('invalid lifecycle request');
    const d = this.#deps;
    let admission;
    try { admission = d.journal.reserve(request); }
    catch (error) {
      // No effect has begun and no durable custody exists when the authority file is absent.
      if (error.code === 'LIFECYCLE_JOURNAL_MISSING') return result('refused', 'lifecycle journal missing');
      throw error;
    }
    if (!admission.fresh) return admission.result;
    const refuse = (why) => d.journal.finish(request, result('refused', why));
    try {
      const listing = await d.definitions.list();
      const reading = listing.definitions?.find(r => r.id === request.agentId);
      const raw = await d.identity(request.agentId);
      const why = this.#refusal(request, listing, reading, raw);
      if (why) return refuse(why);
      const action = request.action;
      if (action === 'release') return await this.#release(request, reading.agent.mode);
      if (reading.agent.mode === 'resident' && ['start', 'spawn', 'restart'].includes(action)) {
        return refuse('a resident runs in its own terminal: start it there');
      }
      if (raw.current && ['start', 'spawn'].includes(action)) {
        // Clearing a stop is an effect even when no new worker is needed.
        return await d.definitions.withLifecycleDefinition(async currentListing => {
          const currentReading = currentListing.definitions?.find(r => r.id === request.agentId);
          const current = await d.identity(request.agentId);
          const moved = this.#refusal(request, currentListing, currentReading, current);
          if (moved) return refuse(moved);
          if (JSON.stringify(current.current) !== JSON.stringify(raw.current)) return refuse('lifetime-moved');
          return d.journal.finish(request, result('done', 'already-running', current.current.lifetime), false);
        });
      }
      if (invocation && ['start', 'spawn', 'restart'].includes(action)
        && (typeof invocation.buildSpec !== 'function' || typeof invocation.start !== 'function')) {
        return refuse('lifecycle-launch-composition-unavailable');
      }
      if (['stop', 'kill', 'restart', 'delete'].includes(action)) {
        // RESIDENT LIFECYCLE REQUIRES THE ROLE (B1 contract item 7) for every effect it has, not only the kill: the
        // operator-stop fact and a delete's definition removal too, with or without a running lifetime. `admitResident`
        // returns an operation whose `live()` is asked again at each effect, or null; absent, nothing is admitted.
        const role = reading.agent.mode === 'resident' ? (d.admitResident?.() ?? null) : null;
        if (reading.agent.mode === 'resident' && !role) return refuse('not-owner');
        try {
          const stopped = await this.#stop(request, raw.current, role);
          if (stopped.refused) return refuse(stopped.refused);
          if (stopped.unknown) return admission.unknown;
          if (action === 'delete') return await this.#remove(request, refuse, role);
          if (action !== 'restart') return d.journal.finish(request, result('done', action));
        } finally { role?.done(); }
      }
      // A restart has already stopped the agent by here. Its launch is still refused (the service closes the terminal it
      // prepared for it on a refusal), and the outcome says the stop happened, as a delete's does (whole-diff review of
      // 0.9.2: a bare refusal read as "left untouched").
      const cannotStart = (why) => refuse(action === 'restart' ? `stopped; not restarted: ${why}` : why);
      let spec;
      // A builder that throws (a workspace outside this host's roots, a launch the service would not prepare) has
      // started nothing, so for a start it is a refusal naming why, not an unknown execution that reads as a start.
      try { spec = await (invocation?.buildSpec ?? d.buildSpec)(reading.agent, request); }
      catch (error) { return cannotStart(String(error?.message || error)); }
      const launch = { agentId: request.agentId, runtime: HARNESS_RUNTIME[reading.agent.harness],
        definition: { storeId: request.storeId, incarnation: request.expectedIncarnation, revision: request.expectedRevision } };
      const started = invocation ? await this.#startInvocation(request, launch, spec, invocation)
        : await d.definitions.admitStart(launch, async () => {
        const current = await d.identity(request.agentId);
        if (!current || !['current', 'conflict', 'unknown'].every(key => Object.hasOwn(current, key)) || current.conflict !== false || current.unknown !== false || current.current !== null) return { refused: 'identity-moved' };
        // THE BINDING JUST ADMITTED rides on the spec, as on every other defined start, so the child is told it
        // (managed-lifetimes.mjs, BINDING_CARRIERS) and its record names it.
        await d.start({ ...spec, agentId: request.agentId, definition: launch.definition });
        const after = await d.identity(request.agentId);
        return after?.current?.lifetime && !after.conflict && !after.unknown ? { lifetime: after.current.lifetime } : { unknown: true };
      });
      if (started.refused || started.produced?.refused) return cannotStart(started.refused ?? started.produced.refused);
      if (!started.produced?.lifetime) return admission.unknown;
      return d.journal.finish(request, result('done', action, started.produced.lifetime), false);
    } catch (error) {
      // An exception may follow an effect. Return the immutable receipt already durably reserved.
      return admission.unknown;
    }
  }
  async #stop(request, expected, role) {
    const d = this.#deps;
    return d.definitions.withLifecycleDefinition(async listing => {
      const reading = listing.definitions?.find(r => r.id === request.agentId);
      const fresh = await d.identity(request.agentId);
      const why = this.#refusal(request, listing, reading, fresh);
      if (why) return { refused: why };
      if (JSON.stringify(fresh.current) !== JSON.stringify(expected)) return { refused: 'lifetime-moved' };
      if (fresh.current && await d.stop(structuredClone(fresh.current), reading.agent.mode, role) !== true) return { unknown: true };
      // The stop fact is the role's effect too, asked here: after the lock wait, and after any kill's await.
      if (role && !role.live()) return fresh.current ? { unknown: true } : { refused: 'not-owner' };
      if (request.action !== 'kill') d.journal.markStopped(request);
      return { stopped: true };
    });
  }
  /**
   * Release an operator's hold WITHOUT STARTING ANYTHING: the stop fact a `stop` wrote goes back to false, so the
   * agent reads available again and a message cold-starts it as before (2026-10-28: sixteen held agents could leave
   * the hold only by being started). Under the same definition and identity checks as a stop, with no process effect.
   * An agent that is not held is answered `not-held`, done: releasing twice is not a fault. A resident's stop fact is
   * the residents role's to change, as its stop is (B1 contract item 7).
   */
  async #release(request, mode) {
    const d = this.#deps;
    const role = mode === 'resident' ? (d.admitResident?.() ?? null) : null;
    if (mode === 'resident' && !role) return d.journal.finish(request, result('refused', 'not-owner'));
    try {
      return await d.definitions.withLifecycleDefinition(async listing => {
        const reading = listing.definitions?.find(r => r.id === request.agentId);
        // Asked again under the lock (its lifetime check included): no process is touched, so no witness is compared.
        const fresh = await d.identity(request.agentId);
        const why = this.#refusal(request, listing, reading, fresh) || (role && !role.live() ? 'not-owner' : '');
        if (why) return d.journal.finish(request, result('refused', why));
        if (d.journal.stopFacts().get(keyFor(request)) !== true) return d.journal.finish(request, result('done', 'not-held'));
        return d.journal.finish(request, result('done', 'release'), false);
      });
    } finally { role?.done(); }
  }
  /** Delete, after its stop: remove the definition under this request's id, so a replay reads "already applied". */
  async #remove(request, refuse, role) {
    const d = this.#deps;
    const installed = await d.installed();
    if (role && !role.live()) return refuse('stopped; the definition was not removed: not-owner');
    const removed = await d.definitions.applyRequest({ id: request.id, agentId: request.agentId,
      storeId: request.storeId, expectedIncarnation: request.expectedIncarnation,
      expectedRevision: request.expectedRevision, patch: { remove: true } }, { installed, ...(role ? { live: role.live } : {}) });
    if (removed?.status !== 'done') return refuse(`stopped; the definition was not removed: ${removed?.outcome || 'no answer'}`);
    return d.journal.finish(request, { ...result('done', 'delete'),
      resultIncarnation: removed.resultIncarnation, resultRevision: removed.resultRevision });
  }
  async #startInvocation(request, launch, prepared, invocation) {
    const d = this.#deps;
    let active = true, used = false, admitted = null;
    const runLocked = async produce => {
      if (!active || used || typeof produce !== 'function') throw Error('lifecycle-admission-closed');
      used = true;
      admitted = await d.definitions.admitStart(launch, async () => {
        if (!active) return { refused: 'lifecycle-admission-closed' };
        const raw = await d.identity(request.agentId);
        if (raw?.conflict !== false || raw?.unknown !== false || raw?.current !== null) return { refused: 'identity-moved' };
        return await produce();
      });
      return admitted.produced?.refused ? { refused: admitted.produced.refused } : admitted;
    };
    try { await invocation.start(prepared, runLocked); }
    finally { active = false; }
    if (admitted?.refused || admitted?.produced?.refused) return admitted;
    if (!admitted) return { produced: { unknown: true } };
    const after = await d.identity(request.agentId);
    return { produced: after?.current?.lifetime && !after.conflict && !after.unknown
      ? { lifetime: after.current.lifetime } : { unknown: true } };
  }
  #refusal(r, listing, reading, raw) {
    if (r.machineId !== this.#deps.machineId) return 'machine-moved';
    if (!listing || listing.conflict || listing.enumerationFailed || listing.unreadable?.length) return 'definition-unresolved';
    if (listing.storeId !== r.storeId) return 'store-moved';
    if (!reading?.agent || reading.problems?.length !== 0) return 'definition-unresolved';
    if (reading.incarnation !== r.expectedIncarnation) return 'incarnation-moved';
    if (reading.revision !== r.expectedRevision) return 'revision-moved';
    if (!raw || typeof raw.conflict !== 'boolean' || typeof raw.unknown !== 'boolean'
      || !['current', 'conflict', 'unknown'].every(key => Object.hasOwn(raw, key)) || !(raw.current === null || (object(raw.current) && text(raw.current.lifetime)))) return 'identity-unknown';
    if (raw.conflict) return 'conflict';
    if (raw.unknown) return 'identity-unknown';
    if ((raw.current?.lifetime ?? null) !== r.expectedLifetime) return 'lifetime-moved';
    return '';
  }
}
