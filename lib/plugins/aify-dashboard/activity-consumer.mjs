// The plugin owns ACK, gap identity, age continuity and immutable-prefix checkpoints.
// Only ended, fully committed source files may be reclaimed, with an ACKed tail gap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActivityState, regularFile, readSegment } from './activity-state.mjs';
import { LIMITS, validPolicy, validClock, digest, fileIdentity, decodeFrames, ageReason, continuousClock } from './activity-raw.mjs';
import { existingDirectory } from './activity-source.mjs';
import { ActivityRetirement } from './activity-retirement.mjs';
const SEGMENT = /^session-[a-f0-9]{64}\.jsonl$/;
const LOSS = /^session-[a-f0-9]{64}\.loss$/;
const empty = () => ({ ok: true, token: null, source: null, records: [], gaps: [], coverage: 'unknown' });
const currentClock = () => ({ wallMs: Date.now(), uptimeMs: Math.floor(os.uptime() * 1000) });
function addGap(stage, reason) {
  if (stage.gaps.some(g => g.reason === reason)) return;
  if (stage.gaps.length >= 32) throw new Error('gap-limit');
  stage.gaps.push({ id: randomUUID(), reason, lostCount: null });
}
function tokenFor(name, s) {
  return { segment: { name, start: s.offset, end: s.stage.end, identity: s.identity, prefix: s.prefix },
    generation: s.generation, eventIds: s.stage.items.filter(i => !i.reason).map(i => i.eventId),
    gapIds: s.stage.gaps.map(g => g.id) };
}
export class ActivityConsumer {
  constructor({ directory, agentId, endpoint, validRecord, policy = LIMITS, clock = currentClock, agents, probe }) {
    if (!path.isAbsolute(directory) || !validPolicy(policy) || typeof validRecord !== 'function') throw new Error('consumer-configuration');
    this.directory = directory; this.agentId = agentId; this.policy = policy; this.validRecord = validRecord; this.clock = clock;
    this.storage = new ActivityState({ directory, endpoint });
    this.retirement = new ActivityRetirement({ agents, probe });
  }
  read() {
    try {
      if (!existingDirectory(this.directory)) return empty();
      return this.storage.transaction(state => {
        const entries = fs.readdirSync(this.directory).sort();
        const names = [];
        for (const name of entries) {
          if (!SEGMENT.test(name) && !LOSS.test(name) && name !== 'uncertain') throw new Error('unowned-entry');
          const stat = regularFile(path.join(this.directory, name));
          if (!stat) continue;
          if (SEGMENT.test(name)) names.push(name);
          else if (stat.size !== 1 || fs.readFileSync(path.join(this.directory, name), 'utf8') !== '?') throw new Error('invalid-marker');
        }
        if (names.length > this.policy.maxSessions) throw new Error('session-limit');
        for (const name of Object.keys(state.sources)) {
          if (this.retirement.reclaim(state, name, this.storage, this.directory)) {
            const i = names.indexOf(name); if (i >= 0) names.splice(i, 1);
          } else if (!names.includes(name)) throw Error('retained-source-missing');
        }
        if (!names.length) return { ...empty(), uncertain: fs.readdirSync(this.directory).length > 0 };
        for (const name of names) {
          const read = this.prepare(state, name, entries);
          if (read) return read;
        }
        return { ...empty(), uncertain: entries.includes('uncertain') || entries.some(n => LOSS.test(n))
          || names.some(name => !state.sources[name]) };
      });
    } catch { return { ...empty(), ok: false }; }
  }
  prepare(state, name, entries) {
    const file = path.join(this.directory, name), stat = regularFile(file);
    if (!stat) return null;
    // A producer race can exceed its best-effort limit. Read no more than the admitted maximum.
    if (stat.size > LIMITS.sessionBytes) throw new Error('segment-limit');
    const bytes = readSegment(file, stat);
    const clock = this.clock();
    if (!validClock(clock)) throw new Error('clock');
    const frames = decodeFrames(bytes, { name, agentId: this.agentId, validRecord: this.validRecord });
    let s = state.sources[name];
    const source = frames.find(f => f.envelope)?.envelope.record.source;
    if (!s && !source) return null; // Unretained source identity cannot be invented.
    if (!s) {
      if (Object.keys(state.sources).length >= LIMITS.maxSessions) throw new Error('state-sources');
      s = state.sources[name] = { source, identity: fileIdentity(stat), offset: 0, checked: 0,
        prefix: digest(Buffer.alloc(0)), generation: (state.generationFloor ?? 0) + 1, clock, invalidThrough: 0, latches: [], stage: null };
    }
    if (s.source.agentId !== this.agentId) throw new Error('source-directory');
    if (!s.witness) s.witness = this.retirement.observe(s.source);
    const replaced = s.identity !== fileIdentity(stat) || s.checked > bytes.length || digest(bytes.subarray(0, s.checked)) !== s.prefix;
    if (replaced) {
      // Loss of the previous immutable prefix is reported against its proved source, never the replacement's guess.
      s.offset = 0; s.checked = 0; s.prefix = digest(Buffer.alloc(0)); s.identity = fileIdentity(stat);
      s.stage = { end: 0, items: [], gaps: s.stage?.gaps ?? [], latches: s.stage?.latches ?? [] };
      s.retirement = null;
      addGap(s.stage, 'identity'); this.bump(s);
    }
    if (!continuousClock(s.clock, clock)) s.invalidThrough = Math.max(s.invalidThrough, bytes.length);
    s.clock = clock;
    const marker = this.retirement.marker(file);
    if (marker !== null && marker !== (s.lossIdentity ?? null)) {
      s.latches = s.latches.filter(l => l !== 'loss'); s.lossIdentity = marker;
      if (s.retirement) s.retirement = null;
    }
    if (s.retirement && (s.retirement.phase === 'raw-removed' || s.offset !== bytes.length)) s.retirement = null;
    const latches = [ ...(entries.includes(name.replace('.jsonl', '.loss')) ? ['loss'] : []),
      ...(entries.includes('uncertain') ? ['uncertain'] : []) ];
    if (!s.stage && s.offset === bytes.length && latches.every(l => s.latches.includes(l))) {
      // No uncommitted bytes or new latch means no batch to persist. A later batch saves continuity.
      if (s.retirement || !this.retirement.ended(s)) return null;
      s.stage = { end: s.offset, items: [], gaps: [], latches: [] };
      addGap(s.stage, 'reclaimed');
      s.retirement = { id: s.stage.gaps[0].id, generation: s.generation, ackGeneration: null, phase: 'pending', marker };
    }
    if (!s.stage) s.stage = { end: s.offset, items: [], gaps: [], latches: [] };
    const stage = s.stage;
    for (const latch of latches) {
      if (!s.latches.includes(latch) && !stage.latches.includes(latch)) {
        stage.latches.push(latch); addGap(stage, latch === 'loss' ? 'producer_loss' : 'producer_uncertain');
      }
    }
    // Expiry and discontinuity also apply to already staged retries. They never renew their age.
    for (const item of stage.items) {
      if (item.reason) continue;
      const frame = frames.find(f => f.start === item.start && f.end === item.end);
      if (!frame?.envelope || digest(bytes.subarray(item.start, item.end)) !== item.digest) throw new Error('staged-identity');
      const reason = item.end <= s.invalidThrough ? 'clock' : ageReason(frame.envelope, clock, this.policy.maxAgeMs);
      if (reason) { item.reason = reason; addGap(stage, reason); this.bump(s); }
    }
    const records = stage.items.filter(i => !i.reason).map(item => ({ record: frames.find(f => f.start === item.start).envelope.record }));
    let size = Buffer.byteLength(JSON.stringify({ version: 1, batchId: randomUUID(), source: s.source,
      coverage: { generation: s.generation, producer: 'unknown', reportEveryMs: null, gaps: stage.gaps }, events: records.map(r => r.record.event) }));
    // A staged batch is fixed until resolved. New append bytes belong to the next batch.
    if (!s.retirement && stage.items.length === 0 && stage.end === s.offset) {
      for (const rawFrame of frames) {
        // Compaction can join old acknowledged malformed bytes to a newly appended bad suffix.
        const frame = !rawFrame.envelope && rawFrame.start < stage.end ? { ...rawFrame, start: stage.end } : rawFrame;
        if (frame.end <= stage.end) continue;
        if (frame.start < stage.end) continue;
        const envelope = frame.envelope;
        let reason = !envelope ? 'malformed' : frame.end <= s.invalidThrough ? 'clock' : ageReason(envelope, clock, this.policy.maxAgeMs);
        if (envelope && frame.end > Math.min(envelope.policy.sessionBytes, this.policy.sessionBytes)) reason = 'policy';
        const extra = reason ? 0 : Buffer.byteLength(JSON.stringify(envelope.record.event)) + 1;
        // Leave room for bounded recovery gaps; a later refusal must not strand a full byte-sized batch.
        if (stage.items.length >= 128 || size + extra > 240 * 1024
          || (!reason && stage.items.some(i => !i.reason && i.eventId === envelope.record.event.eventId))) break;
        if (reason) addGap(stage, reason);
        stage.items.push({ start: frame.start, end: frame.end, digest: digest(bytes.subarray(frame.start, frame.end)),
          eventId: envelope?.record.event.eventId ?? null, reason });
        stage.end = frame.end; size += extra;
      }
    }
    s.checked = Math.max(s.checked, stage.end); s.prefix = digest(bytes.subarray(0, s.checked));
    this.storage.save(state); // IDs, clock fence and raw interval are durable before the HTTP request.
    const visible = stage.items.filter(i => !i.reason).map(item => ({ record: frames.find(f => f.start === item.start).envelope.record }));
    return { ok: true, source: s.source, generation: s.generation, coverage: latches.length || stage.gaps.length ? 'unknown' : 'supported',
      records: visible, gaps: stage.gaps, token: tokenFor(name, s) };
  }
  bump(s) { if (s.generation >= Number.MAX_SAFE_INTEGER) throw new Error('generation'); s.generation++; }
  update(token, action) {
    try {
      return this.storage.transaction(state => {
        const s = state.sources[token?.segment?.name];
        if (!s?.stage || JSON.stringify(tokenFor(token.segment.name, s)) !== JSON.stringify(token)) return { ok: false };
        // An ACK cannot commit an old cursor onto new/replaced prefix bytes.
        const file = path.join(this.directory, token.segment.name), stat = regularFile(file);
        if (!stat || stat.size > LIMITS.sessionBytes || fileIdentity(stat) !== s.identity) return { ok: false };
        const bytes = readSegment(file, stat);
        if (digest(bytes.subarray(0, s.checked)) !== s.prefix) return { ok: false };
        action(s); this.storage.save(state); return { ok: true };
      });
    } catch { return { ok: false }; }
  }
  resolve(token, { eventIds = [], gapIds = [], reason }) {
    if (!['refused', 'event_conflict', 'gap_conflict'].includes(reason)
      || !Array.isArray(eventIds) || !Array.isArray(gapIds) || new Set(eventIds).size !== eventIds.length
      || new Set(gapIds).size !== gapIds.length || !eventIds.every(id => token?.eventIds.includes(id))
      || !gapIds.every(id => token?.gapIds.includes(id))) return { ok: false };
    return this.update(token, s => {
      for (const item of s.stage.items) if (eventIds.includes(item.eventId)) item.reason = reason === 'refused' ? 'refused' : 'event_conflict';
      // Each identified gap gets a fresh replacement ID. Other gaps keep their exact bodies and IDs.
      s.stage.gaps = s.stage.gaps.map(g => gapIds.includes(g.id)
        ? { id: randomUUID(), reason: g.reason === 'reclaimed' ? 'reclaimed' : 'gap_conflict', lostCount: null } : g);
      if (eventIds.length) addGap(s.stage, reason === 'refused' ? 'refused' : 'event_conflict');
      this.bump(s);
      if (s.retirement?.phase === 'pending') {
        s.retirement.id = s.stage.gaps.find(g => g.reason === 'reclaimed').id;
        s.retirement.generation = s.generation;
      }
    });
  }
  ack(token, receipt) {
    if (receipt?.committed !== true || JSON.stringify(receipt.eventIds) !== JSON.stringify(token?.eventIds)
      || JSON.stringify(receipt.gapIds) !== JSON.stringify(token?.gapIds)) return { ok: false };
    return this.update(token, s => {
      s.offset = s.stage.end;
      if (s.retirement?.phase === 'pending') {
        if (s.retirement.generation !== token.generation || s.stage.items.length !== 0
          || s.stage.gaps.length !== 1 || s.stage.gaps[0].id !== s.retirement.id
          || s.stage.gaps[0].reason !== 'reclaimed') throw Error('terminal-obligation');
        s.retirement.ackGeneration = token.generation; s.retirement.phase = 'acked';
      }
      s.latches = [...new Set([...s.latches, ...s.stage.latches])];
      s.stage = null; this.bump(s);
    });
  }
}
