// HTTP contract decisions are pure. Only an exact commit receipt authorizes storage ACK.
import { FILE_ACTIVITY_PATH } from './dashboard-api.mjs';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const subset = (ids, population) => Array.isArray(ids) && new Set(ids).size === ids.length
  && ids.every(id => population.includes(id));
const REFUSALS = new Set(['location_unresolved', 'no_containing_project', 'event_purged']);

export function activityDeclared(spec) {
  return exact(spec?.fixed?.fileActivity, ['path']) && spec.fixed.fileActivity.path === FILE_ACTIVITY_PATH;
}

export function activityBatch(read, batchId) {
  const batch = { version: 1, batchId, source: read.source,
    coverage: { generation: read.generation, producer: read.coverage, reportEveryMs: null, gaps: read.gaps },
    events: read.records.map(entry => entry.record.event) };
  if (batch.events.length > 128 || batch.coverage.gaps.length > 32 || Buffer.byteLength(JSON.stringify(batch)) > 256 * 1024) {
    throw new Error('batch-limit');
  }
  return batch;
}

export function activityDecision({ status, body }, batch) {
  const eventIds = batch.events.map(event => event.eventId);
  const gapIds = batch.coverage.gaps.map(gap => gap.id);
  if (status === 409) {
    if (!exact(body, ['version', 'batchId', 'error']) || body.version !== 1 || body.batchId !== batch.batchId
      || !exact(body.error, ['code', 'eventIds', 'gapIds'])) return null;
    const error = body.error;
    if (!subset(error.eventIds, eventIds) || !subset(error.gapIds, gapIds)) return null;
    if (error.code === 'event_conflict' ? error.eventIds.length === 0
      : error.code === 'gap_conflict' ? error.eventIds.length !== 0 || error.gapIds.length === 0 : true) return null;
    return { kind: 'resolve', eventIds: error.eventIds, gapIds: error.gapIds, reason: error.code };
  }
  if (status !== 200 || !exact(body, ['version', 'batchId', 'results', 'coverage'])
    || body.version !== 1 || body.batchId !== batch.batchId || !Array.isArray(body.results)
    || body.results.length !== eventIds.length || !exact(body.coverage, ['generation', 'acknowledgedGapIds'])
    || body.coverage.generation !== batch.coverage.generation
    || !subset(body.coverage.acknowledgedGapIds, gapIds)
    || body.coverage.acknowledgedGapIds.length !== gapIds.length) return null;
  const refused = [];
  for (const [index, result] of body.results.entries()) {
    if (!exact(result, ['eventId', 'disposition', 'code']) || result.eventId !== eventIds[index]) return null;
    if (result.disposition === 'refused') {
      if (!REFUSALS.has(result.code)) return null;
      refused.push(result.eventId);
    } else if (!['stored', 'duplicate'].includes(result.disposition) || result.code !== null) return null;
  }
  return refused.length ? { kind: 'resolve', eventIds: refused, gapIds: [], reason: 'refused' }
    : { kind: 'ack' };
}
