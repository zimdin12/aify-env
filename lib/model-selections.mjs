// Explicit launch/transcript choices write only the model; runtime control and selector mapping stay outside env.
import { RESIDENTS } from './residents-home.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN_OPERATION = Object.freeze({ guard() {}, done() {} });
const FIELDS = Object.freeze({
  instance: value => typeof value === 'string' && value.length > 0,
  lifetime: value => typeof value === 'string' && UUID.test(value),
  harness: value => value === 'claude',
  source: value => value === 'launch' || value === 'model-command',
  session: value => typeof value === 'string',
  transcriptIdentity: value => value === null || typeof value === 'string',
  endOffset: value => value === null || (Number.isSafeInteger(value) && value > 0),
  recordUuid: value => value === null || (typeof value === 'string' && UUID.test(value)),
  value: value => value === null || typeof value === 'string',
});

function malformed(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !Object.hasOwn(FIELDS, key))
    || Object.entries(FIELDS).some(([key, valid]) => !Object.hasOwn(body, key) || !valid(body[key]))) return true;
  return body.source === 'launch'
    ? body.session !== '' || body.transcriptIdentity !== null || body.endOffset !== null || body.recordUuid !== null
    : !UUID.test(body.session) || !body.transcriptIdentity || body.endOffset === null || body.recordUuid === null;
}

class SelectionRefused extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}
class SupersededSelection extends Error {}

/** One agent's last admitted lifetime/domain, not a history or retry queue. */
class SelectionFence {
  #instance; #lifetime; #launch = false; #session = null; #file = null; #offset = 0; #record = null;
  constructor({ instance, lifetime }) { this.#instance = instance; this.#lifetime = lifetime; }
  belongsTo(body) { return body.instance === this.#instance && body.lifetime === this.#lifetime; }
  admit(body) {
    if (body.source === 'launch') {
      if (this.#session !== null) return { eligible: false, reason: 'completion-already-admitted' };
      if (this.#launch) return { eligible: false, reason: 'duplicate-launch' };
      this.#launch = true;
      return { eligible: true };
    }
    if (this.#session !== null && (this.#session !== body.session || this.#file !== body.transcriptIdentity)) {
      throw new SelectionRefused(409, 'wrong-transcript');
    }
    if (body.endOffset < this.#offset) return { eligible: false, reason: 'older-position' };
    if (body.endOffset === this.#offset) {
      if (body.recordUuid !== this.#record) throw new SelectionRefused(409, 'conflicting-record');
      return { eligible: false, reason: 'duplicate-position' };
    }
    this.#session = body.session;
    this.#file = body.transcriptIdentity;
    // Admission precedes every await/write, including unresolved and subsequently failed selections.
    this.#offset = body.endOffset;
    this.#record = body.recordUuid;
    return { eligible: true };
  }
  stillAdmitted(body) {
    return body.source === 'launch' ? this.#session === null && this.#launch
      : this.#session === body.session && this.#file === body.transcriptIdentity
        && this.#offset === body.endOffset && this.#record === body.recordUuid;
  }
}

export class ModelSelections {
  #host; #instance; #residents; #definitions; #installed; #report;
  #fences = new Map();
  constructor({ host, instance, residents = null, definitions, installed, report = () => {} }) {
    this.#host = host; this.#instance = instance; this.#residents = residents;
    this.#definitions = definitions; this.#installed = installed; this.#report = report;
  }
  #log(line) { try { this.#report(line); } catch { /* a logging failure cannot undo a committed definition */ } }
  #answer(agentId, applied, reason, changed = false) {
    return { status: 200, body: { agentId, applied, changed, reason } };
  }
  #target(instance) {
    if (instance === this.#instance) return { host: this.#host, op: OWN_OPERATION };
    if (instance !== RESIDENTS) throw new SelectionRefused(409, 'wrong-instance');
    const target = this.#residents?.enter();
    if (!target) throw new SelectionRefused(409, 'not-owner');
    return target;
  }
  #guard(agentId, body, target, fence = null) {
    target.op.guard();
    let identity;
    try { identity = target.host.rawIdentity(agentId); }
    catch { throw new SelectionRefused(503, 'state-unavailable'); }
    if (!identity || identity.unknown || identity.conflict || identity.current?.lifetime !== body.lifetime) {
      throw new SelectionRefused(409, 'not-current');
    }
    if (fence && (this.#fences.get(agentId) !== fence || !fence.stillAdmitted(body))) throw new SupersededSelection();
  }
  #fence(agentId, body) {
    let fence = this.#fences.get(agentId);
    if (!fence?.belongsTo(body)) {
      fence = new SelectionFence(body);
      this.#fences.set(agentId, fence);
    }
    return fence;
  }
  async receive(agentId, body) {
    let target;
    try {
      if (malformed(body)) throw new SelectionRefused(400, 'malformed-model-selection');
      target = this.#target(body.instance);
      this.#guard(agentId, body, target);
      const fence = this.#fence(agentId, body);
      const admitted = fence.admit(body);
      if (!admitted.eligible) return this.#answer(agentId, false, admitted.reason);
      if (body.value === null) return this.#answer(agentId, false,
        body.source === 'launch' ? 'no-explicit-model' : 'unresolved-selection');
      return await this.#persist(agentId, body, target, fence);
    } catch (error) {
      if (error instanceof SupersededSelection) return this.#answer(agentId, false, 'superseded-position');
      const status = error?.code === 'NOT_OWNER' ? 409 : error instanceof SelectionRefused ? error.status : 503;
      const reason = error?.code === 'NOT_OWNER' ? 'not-owner' : error instanceof SelectionRefused ? error.reason : 'model-write-failed';
      this.#log(`model selection refused: ${reason}`);
      return { status, body: { agentId, applied: false, reason } };
    } finally { target?.op.done(); }
  }
  async #persist(agentId, body, target, fence) {
    const listed = await this.#definitions.list();
    this.#guard(agentId, body, target, fence);
    const current = listed.definitions?.find(entry => entry.id === agentId);
    if (listed.conflict || listed.enumerationFailed || !current || current.problems?.length) {
      throw new SelectionRefused(503, 'definition-unavailable');
    }
    if (current.agent.harness !== body.harness) throw new SelectionRefused(409, 'wrong-harness');
    if (current.agent.model === body.value) return this.#answer(agentId, true, 'unchanged');
    const installed = typeof this.#installed === 'function' ? await this.#installed() : this.#installed;
    this.#guard(agentId, body, target, fence);
    await this.#definitions.set(agentId, { ...current.agent, model: body.value }, {
      expect: { incarnation: current.incarnation, revision: current.revision }, installed,
      live: () => { this.#guard(agentId, body, target, fence); return true; },
    });
    // Quote values so even a literal newline/escape in an explicit argument stays one warning line.
    this.#log(`model changed: ${JSON.stringify(agentId)} ${JSON.stringify(current.agent.model)} -> ${JSON.stringify(body.value)} (${body.source === 'launch' ? 'launch --model' : '/model'})`);
    return this.#answer(agentId, true, 'model-updated', true);
  }
}
