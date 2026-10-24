// Raw STORAGEv2 calculations. No producer code, cursor or filesystem effects here.
import { createHash } from 'node:crypto';
export const LIMITS = Object.freeze({ sessionBytes: 8388608, maxSessions: 16, maxAgeMs: 86400000 });
export const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const integer = v => Number.isSafeInteger(v) && v >= 0;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function sourceName(s) {
  return `session-${digest(JSON.stringify([s.machineId, s.instanceId, s.agentId, s.incarnation, s.runtime, s.sessionId]))}.jsonl`;
}
export function validPolicy(p) {
  return exact(p, Object.keys(LIMITS)) && Object.entries(LIMITS).every(([k, max]) => integer(p[k]) && p[k] > 0 && p[k] <= max);
}
export const validClock = c => exact(c, ['wallMs', 'uptimeMs']) && integer(c.wallMs) && integer(c.uptimeMs);
export function continuousClock(before, after) {
  if (!validClock(before) || !validClock(after)) return false;
  const wall = after.wallMs - before.wallMs, up = after.uptimeMs - before.uptimeMs;
  return wall >= 0 && up >= 0 && Math.abs(wall - up) <= 2000;
}
export function ageReason(envelope, clock, maxAgeMs) {
  if (!continuousClock(envelope.appendedAt, clock)) return 'clock';
  return Math.max(clock.wallMs - envelope.appendedAt.wallMs, clock.uptimeMs - envelope.appendedAt.uptimeMs)
    >= Math.min(envelope.policy.maxAgeMs, maxAgeMs) ? 'expired' : null;
}
export function decodeEnvelope(bytes, { name, validRecord }) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const v = JSON.parse(text);
    if (!exact(v, ['storageVersion', 'appendedAt', 'policy', 'record']) || v.storageVersion !== 2
      || !validClock(v.appendedAt) || !validPolicy(v.policy) || !validRecord(v.record)
      || sourceName(v.record.source) !== name) return null;
    return v;
  } catch { return null; }
}
// A failed O_APPEND may leave a torn prefix immediately before a later complete envelope.
// Only a complete LF frame with a fully validated suffix and source hash can recover it.
export function decodeFrames(bytes, context) {
  const frames = []; let start = 0;
  const append = frame => {
    const previous = frames.at(-1);
    if (!frame.envelope && previous && !previous.envelope && previous.end === frame.start) previous.end = frame.end;
    else frames.push(frame);
  };
  while (start < bytes.length) {
    if (bytes[start] === 10) {
      let end = start + 1; while (end < bytes.length && bytes[end] === 10) end++;
      append({ start, end, envelope: null }); start = end; continue;
    }
    const lf = bytes.indexOf(10, start), end = lf < 0 ? bytes.length : lf + 1;
    const line = bytes.subarray(start, lf < 0 ? end : lf);
    let envelope = lf < 0 ? null : decodeEnvelope(line, context);
    let recovered = 0;
    if (!envelope && lf >= 0) {
      // Valid producer records cannot contain this unescaped header in string fields.
      // A complete earlier frame would have its own LF, so only the last candidate can recover this line.
      const pos = line.lastIndexOf('{"storageVersion":2,');
      if (pos > 0) {
        envelope = decodeEnvelope(line.subarray(pos), context);
        if (envelope) recovered = pos;
      }
    }
    if (recovered) append({ start, end: start + recovered, envelope: null });
    append({ start: start + recovered, end, envelope });
    start = end;
  }
  return frames;
}
export function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
export function validWitness(w, source) {
  return exact(w, ['agentId', 'instance', 'lifetime', 'pid', 'createdAtUs'])
    && w.agentId === source.agentId && w.instance === source.instanceId
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(w.lifetime) && w.lifetime === source.incarnation
    && Number.isSafeInteger(w.pid) && w.pid > 0 && Number.isSafeInteger(w.createdAtUs) && w.createdAtUs > 0;
}
