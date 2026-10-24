// Startup permission travels with one launcher lifetime; the lifecycle journal owns its consumption.
// ASYMMETRY: Hermes awaits the owned visible TUI acknowledgment; Codex is parked. Neither clears here.
export const RESIDENT_START_PRODUCERS = Object.freeze({ claude: 'SessionStart' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const counter = value => Number.isSafeInteger(value) && value > 0;
const supported = (harness, producer) => typeof harness === 'string' && typeof producer === 'string'
  && Object.hasOwn(RESIDENT_START_PRODUCERS, harness) && RESIDENT_START_PRODUCERS[harness] === producer;

/** Optional record extension. Invalid startup metadata never invalidates the process record itself. */
export function residentStartBinding(value) {
  if (!object(value) || value.intent !== 'replace' || !supported(value.harness, value.producer)
    || typeof value.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.agentId)
    || !text(value.storeId) || !counter(value.incarnation) || !counter(value.revision)
    || !Number.isSafeInteger(value.stopRevision) || value.stopRevision < 0
    || typeof value.stopReceipt !== 'string' || !/^[0-9a-f]{64}$/.test(value.stopReceipt)) return null;
  const { agentId, intent, harness, producer, storeId, incarnation, revision, stopRevision, stopReceipt } = value;
  return { agentId, intent, harness, producer, storeId, incarnation, revision, stopRevision, stopReceipt };
}
function definition(listing, agentId) {
  if (!listing || listing.conflict || listing.enumerationFailed || !Array.isArray(listing.unreadable)
    || listing.unreadable.length || !Array.isArray(listing.definitions)) return null;
  const row = listing.definitions.find(item => item.id === agentId);
  return row?.agent?.mode === 'resident' && row.problems?.length === 0 ? row : null;
}

export class ResidentStarts {
  #definitions;
  #journal;
  #residents;
  #identity;
  constructor({ definitions, journal, residents = null, identity = null }) {
    this.#definitions = definitions;
    this.#journal = journal;
    this.#residents = residents;
    this.#identity = identity;
  }
  /** Offline capture under the definition fence. This reserves and clears nothing. */
  async capture(agentId, harness, producer) {
    if (!supported(harness, producer)) return { refused: 'startup-producer-unavailable' };
    try {
      return await this.#definitions.withLifecycleDefinition(listing => {
        const row = definition(listing, agentId);
        if (!row || row.agent.harness !== harness) return { refused: 'definition-unresolved' };
        const binding = { agentId, intent: 'replace', harness, producer, storeId: listing.storeId,
          incarnation: row.incarnation, revision: row.revision };
        const stop = this.#journal.stopSnapshot(binding);
        return residentStartBinding({ ...binding, stopRevision: stop.revision, stopReceipt: stop.receipt })
          ?? { refused: 'resident-start-binding-unavailable' };
      });
    } catch { return { refused: 'resident-start-binding-unavailable' }; }
  }
  /** Native startup only. A normal turn event or record scan never reaches this effect. */
  async consume(agentId, body) {
    const answer = (status, reason, consumed = false) => ({ status, body: { agentId, consumed, reason } });
    if (!object(body) || body.instance !== 'residents' || !text(body.sessionId)
      || typeof body.lifetime !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.lifetime))
      return answer(400, 'malformed-startup');
    if (!supported(body.harness, body.producer)) return answer(409, 'startup-producer-unavailable');
    const admitted = this.#residents?.enter() ?? null;
    if (!admitted) return answer(409, 'not-owner');
    try {
      return await this.#definitions.withLifecycleDefinition(async listing => {
        if (!admitted.op.live()) return answer(409, 'not-owner');
        const raw = await this.#identity?.(agentId);
        const current = raw?.current;
        if (raw?.conflict !== false || raw?.unknown !== false || current?.instance !== 'residents'
          || current.agentId !== agentId || current.lifetime !== body.lifetime || current.harness !== body.harness
          || !Number.isSafeInteger(current.createdAtUs) || current.createdAtUs <= 0)
          return answer(409, 'identity-unresolved');
        const binding = residentStartBinding(current.operatorStart);
        if (!binding || binding.agentId !== agentId || binding.harness !== body.harness || binding.producer !== body.producer)
          return answer(409, 'startup-binding-unavailable');
        const row = definition(listing, agentId);
        if (!row || listing.storeId !== binding.storeId || row.incarnation !== binding.incarnation
          || row.revision !== binding.revision || row.agent.harness !== binding.harness)
          return answer(409, 'definition-moved');
        const consumed = this.#journal.consumeResidentStart(binding, { live: admitted.op.live });
        return answer(consumed.consumed ? 200 : 409, consumed.reason, consumed.consumed);
      });
    } catch (error) {
      return answer(error?.code === 'NOT_OWNER' ? 409 : 503,
        error?.code === 'NOT_OWNER' ? 'not-owner' : 'startup-unavailable');
    } finally { admitted.op.done(); }
  }
}
