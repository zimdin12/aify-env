// Host effects and receipts only. Services own submission and claims.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileDurably } from './durable-file.mjs';
import { HARNESS_RUNTIME } from './agent-definition-requests.mjs';

const keyFor = (r) => `${r.storeId}:${r.expectedIncarnation}:${r.agentId}`;
const intent = (r) => JSON.stringify([r.id, r.agentId, r.machineId, r.storeId, r.expectedIncarnation,
  r.expectedRevision, r.expectedLifetime, r.action, r.requestedBy, r.freshContext ?? false]);
const result = (status, outcome, resultLifetime = null, finishedAt = new Date().toISOString()) =>
  ({ status, outcome, resultLifetime, finishedAt });
const actions = new Set(['start', 'spawn', 'restart', 'stop', 'kill', 'delete']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.length > 0;
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const counter = v => Number.isSafeInteger(v) && v > 0;
function validRequest(r) {
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
  constructor({ file }) { this.#file = file; }
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
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd);
      return fn();
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
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
      if (stopFact !== undefined) s.stops[keyFor(request)] = stopFact;
      return row.result;
    });
  }
  markStopped(request) {
    this.#change(s => {
      if (s.records[request.id]?.intent !== intent(request)) throw new Error('receipt-intent-moved');
      s.stops[keyFor(request)] = true;
    });
  }
  stopFacts() { return new Map(Object.entries(this.#read().stops)); }
  open() { return Object.entries(this.#read().records).filter(([, r]) => r.phase === 'pending').map(([id, r]) => ({ id, ...r })); }
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
      if (reading.agent.mode === 'resident' && ['start', 'spawn', 'restart'].includes(action)) {
        return refuse('a resident runs in its own terminal: start it there');
      }
      if (action === 'delete' || action === 'spawn') return refuse('action-unavailable-in-d9a');
      if (raw.current && ['start', 'spawn'].includes(action)) {
        return d.journal.finish(request, result('done', 'already-running', raw.current.lifetime));
      }
      if (invocation && ['start', 'spawn', 'restart'].includes(action)
        && (typeof invocation.buildSpec !== 'function' || typeof invocation.start !== 'function')) {
        return refuse('lifecycle-launch-composition-unavailable');
      }
      if (['stop', 'kill', 'restart'].includes(action)) {
        const stopped = await this.#stop(request, raw.current);
        if (stopped.refused) return refuse(stopped.refused);
        if (stopped.unknown) return admission.unknown;
        if (action !== 'restart') return d.journal.finish(request, result('done', action));
      }
      const spec = await (invocation?.buildSpec ?? d.buildSpec)(reading.agent, request);
      const launch = { agentId: request.agentId, runtime: HARNESS_RUNTIME[reading.agent.harness],
        definition: { storeId: request.storeId, incarnation: request.expectedIncarnation, revision: request.expectedRevision } };
      const started = invocation ? await this.#startInvocation(request, launch, spec, invocation)
        : await d.definitions.admitStart(launch, async () => {
        const current = await d.identity(request.agentId);
        if (!current || !['current', 'conflict', 'unknown'].every(key => Object.hasOwn(current, key)) || current.conflict !== false || current.unknown !== false || current.current !== null) return { refused: 'identity-moved' };
        await d.start({ ...spec, agentId: request.agentId });
        const after = await d.identity(request.agentId);
        return after?.current?.lifetime && !after.conflict && !after.unknown ? { lifetime: after.current.lifetime } : { unknown: true };
      });
      if (started.refused || started.produced?.refused) return refuse(started.refused ?? started.produced.refused);
      if (!started.produced?.lifetime) return admission.unknown;
      return d.journal.finish(request, result('done', action, started.produced.lifetime), false);
    } catch (error) {
      // An exception may follow an effect. Return the immutable receipt already durably reserved.
      return admission.unknown;
    }
  }
  async #stop(request, expected) {
    const d = this.#deps;
    return d.definitions.withLifecycleDefinition(async listing => {
      const reading = listing.definitions?.find(r => r.id === request.agentId);
      const fresh = await d.identity(request.agentId);
      const why = this.#refusal(request, listing, reading, fresh);
      if (why) return { refused: why };
      if (JSON.stringify(fresh.current) !== JSON.stringify(expected)) return { refused: 'lifetime-moved' };
      if (fresh.current && await d.stop(structuredClone(fresh.current), reading.agent.mode) !== true) return { unknown: true };
      if (request.action !== 'kill') d.journal.markStopped(request);
      return { stopped: true };
    });
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
