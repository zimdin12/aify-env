// STORAGEv2 behavioral pins. Native HTTP in the fixture is a stub, not the dashboard receiver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fixture, prerequisite, ack } from './_activity-fixture.mjs';
import { sourceName, LIMITS, decodeFrames } from '../lib/plugins/aify-dashboard/activity-raw.mjs';
const segment = f => path.join(f.directory, sourceName(f.events[0].source));
const load = f => fs.readFileSync(segment(f), 'utf8').trimEnd().split('\n').map(JSON.parse);
const write = (f, lines) => fs.writeFileSync(segment(f), lines.map(l => JSON.stringify(l) + '\n').join(''));
const receipt = r => ({ committed: true, eventIds: r.token.eventIds, gapIds: r.token.gapIds });

test('torn-prefix recovery bounds JSON parsing rather than repeatedly parsing every suffix', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 });
  const prefix = '{"storageVersion":2,';
  const bytes = Buffer.concat([Buffer.from(prefix.repeat(64)), fs.readFileSync(segment(f))]);
  let attempts = 0; const original = JSON.parse; let frames;
  JSON.parse = (...args) => { attempts++; return original(...args); };
  try { frames = decodeFrames(bytes, { name: sourceName(f.events[0].source), validRecord: f.open().validRecord }); }
  finally { JSON.parse = original; }
  assert.ok(attempts <= 2, 'one corrupt line must require at most two JSON parse attempts');
  assert.deepEqual(frames.filter(v => v.envelope).map(v => v.envelope.record.event), [f.events[0].event], 'bounded recovery still recognizes the valid suffix');
});

test('consecutive malformed frames compact into a bounded unknown-loss interval before a valid frame', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 });
  const prefix = Buffer.from('broken\n'.repeat(1024));
  const bytes = Buffer.concat([prefix, fs.readFileSync(segment(f))]);
  const frames = decodeFrames(bytes, { name: sourceName(f.events[0].source), validRecord: f.open().validRecord });
  assert.equal(frames.length, 2, 'malformed runs must not allocate one retained frame per byte');
  assert.equal(frames[0].start, 0); assert.equal(frames[0].end, prefix.length); assert.equal(frames[0].envelope, null);
  assert.deepEqual(frames[1].envelope.record.event, f.events[0].event, 'compaction never consumes the later valid frame');
});

test('an acknowledged malformed prefix cannot reenter the next batch after compaction', { skip: prerequisite }, async t => {
  const f = await fixture(t); const file = segment(f); fs.writeFileSync(file, 'broken\n' + fs.readFileSync(file, 'utf8'));
  await f.pass();
  const next = { ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } };
  assert.equal(f.producer().append(next).ok, true); await f.pass();
  assert.deepEqual(f.bodies[1]?.events, [next.event], 'acknowledged prefix records cannot reenter a later batch');
  assert.deepEqual(f.bodies[1].coverage.gaps, [], 'acknowledged malformed bytes acquire no fresh gap');
});

test('malformed bytes appended after an ACK get a new gap even when decoding compacts the old run', { skip: prerequisite }, async t => {
  const f = await fixture(t); fs.appendFileSync(segment(f), '\n'); await f.pass();
  assert.equal(f.bodies[0].coverage.gaps[0]?.reason, 'malformed', 'first malformed interval is committed');
  fs.appendFileSync(segment(f), '\n');
  const next = { ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } };
  assert.equal(f.producer().append(next).ok, true); await f.pass();
  assert.deepEqual(f.bodies[1]?.events, [next.event], 'later valid record still ships');
  assert.ok(f.bodies[1].coverage.gaps.some(g => g.reason === 'malformed'), 'new malformed bytes cannot inherit an old gap ACK');
  assert.notEqual(f.bodies[1].coverage.gaps[0].id, f.bodies[0].coverage.gaps[0].id, 'new loss has a fresh durable gap identity');
});

test('the approved producer delimiter preserves a torn tail and the consumer delivers the later frame', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 }); const file = segment(f);
  fs.writeFileSync(file.replace('.jsonl', '.loss'), '?'); fs.appendFileSync(file, 'torn-pending');
  const before = fs.readFileSync(file);
  const next = { ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } };
  assert.equal(f.producer().append(next).ok, true, 'approved producer creates a delimited later frame');
  const raw = fs.readFileSync(file);
  assert.deepEqual(raw.subarray(0, before.length), before, 'producer retains every torn-prefix byte');
  assert.equal(raw[before.length], 10, 'producer inserts its recovery delimiter');
  await f.pass();
  assert.deepEqual(f.bodies[0]?.events, [f.events[0].event, next.event], 'later producer frame is delivered without truncating the torn history');
  assert.ok(f.bodies[0].coverage.gaps.some(g => g.reason === 'malformed'), 'torn line is represented as a gap');
  assert.deepEqual(fs.readFileSync(file), raw, 'consumer ACK leaves producer recovery bytes intact');
});

test('cross-poll rollback is detected even when original append clocks still look young', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 }); const lines = load(f);
  const at = { wallMs: 100000, uptimeMs: 50000 }; lines[0].appendedAt = at; write(f, lines);
  assert.equal(f.open({ clock: () => ({ wallMs: 105000, uptimeMs: 55000 }) }).read().records.length, 1, 'original append has a healthy elapsed-time control');
  const rollback = f.open({ clock: () => ({ wallMs: 100001, uptimeMs: 50001 }) }).read();
  assert.deepEqual(rollback.records, [], 'cross-poll rollback cannot restore younger sendability');
  assert.equal(rollback.gaps[0]?.reason, 'clock');
});

// Before trust, altered bytes are raw input; after trust, altered bytes must be identity loss.
for (const [guard, alter] of Object.entries({
  'storage version': v => { v.storageVersion = 1; },
  'envelope exact fields': v => { v.extra = true; },
  'record schema': v => { v.record.event.path.content = 'forbidden'; },
  'policy bound': v => { v.policy.maxAgeMs = LIMITS.maxAgeMs + 1; },
  'policy exact fields': v => { v.policy.extra = 1; },
  'append clock': v => { v.appendedAt.wallMs = -1; },
  'source hash': v => { v.record.source.sessionId = 'other-session'; },
})) {
  test(`v2 ${guard} becomes a gap while a later valid frame still ships`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const lines = load(f); alter(lines[0]); write(f, lines);
    const raw = f.raw(); await f.pass();
    assert.equal(f.bodies.length, 1, 'trusted later source enables a bounded gap report');
    assert.deepEqual(f.bodies[0].events, [f.events[1].event], `${guard} refuses the malformed event`);
    assert.equal(f.bodies[0].coverage.gaps[0]?.reason, 'malformed', `${guard} is not successful empty history`);
    assert.deepEqual(f.raw(), raw, `${guard} never repairs producer bytes`);
    assert.equal(f.open().read().token, null, 'committed gap retires only the consumer interval');
  });
}
for (const torn of ['bad LF frame\n', '{"storageVersion":2,"record":']) {
  test(`torn ${torn.includes('\n') ? 'line' : 'prefix'} does not hide later complete v2 frames`, { skip: prerequisite }, async t => {
    const f = await fixture(t); const file = segment(f);
    fs.writeFileSync(file, torn + fs.readFileSync(file, 'utf8'));
    const raw = f.raw(); await f.pass();
    assert.deepEqual(f.bodies[0]?.events, f.events.map(r => r.event), 'later complete frames actually ship');
    assert.equal(f.bodies[0].coverage.gaps[0]?.reason, 'malformed', 'torn bytes become a gap');
    assert.deepEqual(f.raw(), raw, 'raw torn bytes never truncated');
  });
}
test('an unretained source cannot be fabricated from root uncertainty or malformed bytes', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 0 }); fs.mkdirSync(f.directory, { recursive: true });
  fs.writeFileSync(path.join(f.directory, 'uncertain'), '?');
  fs.writeFileSync(path.join(f.directory, `session-${'a'.repeat(64)}.jsonl`), 'torn');
  const raw = f.raw(); const p = await f.pass();
  assert.deepEqual(f.bodies, [], 'no invented source for unretained history');
  assert.deepEqual(f.raw(), raw, 'unknown producer history remains intact');
  assert.ok(p.state().problems.some(p => p.startsWith('file activity:')), 'unknown coverage remains visible');
});

test('persistent loss and root markers survive ACK and later complete append bytes still ship', { skip: prerequisite }, async t => {
  const f = await fixture(t); const file = segment(f);
  const loss = file.replace('.jsonl', '.loss'); fs.writeFileSync(loss, '?'); fs.writeFileSync(path.join(f.directory, 'uncertain'), '?');
  const before = f.raw(); await f.pass();
  assert.equal(f.bodies[0].coverage.producer, 'unknown');
  assert.deepEqual(f.raw(), before, 'ACK never clears producer uncertainty');
  const next = { ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } };
  assert.equal(f.producer().append(next).ok, true, 'approved producer appends after loss with its marker retained');
  await f.pass();
  assert.equal(f.bodies.length, 2, 'retained marker cannot veto subsequent valid delivery');
  assert.deepEqual(f.bodies[1].events, [next.event], 'later valid event body is unchanged');
  assert.equal(f.bodies[1].coverage.producer, 'unknown', 'persistent uncertainty cannot become supported');
  assert.equal(fs.readFileSync(loss, 'utf8'), '?', 'source marker still retained');
  assert.equal(fs.readFileSync(path.join(f.directory, 'uncertain'), 'utf8'), '?');
});

test('the original per-line age policy cannot be renewed by a wider consumer setting or restart', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 }); const lines = load(f);
  const at = { wallMs: 100000, uptimeMs: 50000 }; lines[0].appendedAt = at; lines[0].policy.maxAgeMs = 100;
  write(f, lines);
  const first = f.open({ clock: () => ({ wallMs: at.wallMs + 99, uptimeMs: at.uptimeMs + 99 }) }).read();
  assert.equal(first.records.length, 1, 'below-age healthy control');
  const expired = f.open({ clock: () => ({ wallMs: at.wallMs + 100, uptimeMs: at.uptimeMs + 100 }) }).read();
  assert.deepEqual(expired.records, [], 'original max age refuses at its boundary');
  assert.equal(expired.gaps[0]?.reason, 'expired');
  const reopened = f.open({ clock: () => ({ wallMs: at.wallMs + 101, uptimeMs: at.uptimeMs + 101 }) }).read();
  assert.deepEqual(reopened.gaps, expired.gaps, 'expired gap ID and body survive restart');
  assert.equal(reopened.token.segment.start, 0, 'no freshness or cursor renewal before gap ACK');
});
for (const [kind, at, now] of [
  ['rollback', { wallMs: 100000, uptimeMs: 50000 }, { wallMs: 99999, uptimeMs: 50001 }],
  ['reboot', { wallMs: 100000, uptimeMs: 50000 }, { wallMs: 100001, uptimeMs: 100 }],
  ['disagreement', { wallMs: 100000, uptimeMs: 50000 }, { wallMs: 103001, uptimeMs: 51000 }],
]) {
  test(`cross-poll ${kind} is durable unknown age, not newly fresh history`, { skip: prerequisite }, async t => {
    const f = await fixture(t, { records: 1 }); const lines = load(f); lines[0].appendedAt = at; write(f, lines);
    assert.equal(f.open({ clock: () => at }).read().records.length, 1, 'continuous-clock healthy control');
    const read = f.open({ clock: () => now }).read();
    assert.deepEqual(read.records, [], `${kind} refuses uncertain-age events`);
    assert.equal(read.gaps[0]?.reason, 'clock', `${kind} is a coverage gap`);
    assert.deepEqual(f.open({ clock: () => at }).read().gaps, read.gaps, 'clock restoration cannot undo the gap');
  });
}

test('same deterministic filename with replaced bytes cannot inherit the old committed cursor', { skip: prerequisite }, async t => {
  const f = await fixture(t); await f.pass();
  const lines = load(f); lines[0].record.event.eventId = randomUUID(); lines[1].record.event.eventId = randomUUID();
  fs.renameSync(segment(f), segment(f) + '.retired'); write(f, lines); fs.unlinkSync(segment(f) + '.retired');
  await f.pass();
  assert.deepEqual(f.bodies[1]?.events, lines.map(v => v.record.event), 'replacement records are not skipped with the old cursor');
  assert.equal(f.bodies[1].coverage.gaps[0]?.reason, 'identity', 'replacement reports lost prefix identity');
});

test('an ACK concurrent with replacement cannot mutate the consumer checkpoint', { skip: prerequisite }, async t => {
  const f = await fixture(t); const read = f.open().read(); const before = fs.readFileSync(f.checkpoint);
  const bytes = fs.readFileSync(segment(f)); bytes[0] = 32; fs.writeFileSync(segment(f), bytes);
  assert.equal(f.open().ack(read.token, receipt(read)).ok, false, 'replacement refuses old ACK');
  assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'replacement ACK leaves checkpoint byte-identical');
});

test('new append during HTTP waits for the next bounded pass and all raw bytes remain', { skip: prerequisite }, async t => {
  const f = await fixture(t); const next = { ...f.events[0], event: { ...f.events[0].event, eventId: randomUUID() } };
  f.respond(b => { assert.equal(f.producer().append(next).ok, true); return { body: ack(b) }; });
  await f.pass();
  assert.deepEqual(f.bodies[0].events, f.events.map(r => r.event), 'in-flight interval remains fixed');
  const later = f.open().read(); assert.deepEqual(later.records.map(r => r.record.event), [next.event], 'new suffix survives ACK');
  assert.equal(load(f).length, 3, 'consumer never unlinks an active writer segment');
});

test('duplicate event IDs split before transport rather than violating the receiver batch contract', { skip: prerequisite }, async t => {
  const f = await fixture(t, { records: 1 }); assert.equal(f.producer().append(f.events[0]).ok, true);
  await f.pass();
  assert.equal(f.bodies[0].events.length, 1, 'each outbound batch has unique event IDs');
  await f.pass(); assert.equal(f.bodies[1].events.length, 1, 'duplicate raw line is resolved in a later batch');
  assert.equal(f.open().read().token, null);
});

test('legacy activity-v1 bytes are untouched and never treated as v2', { skip: prerequisite }, async t => {
  const f = await fixture(t); const old = path.join(path.dirname(f.directory), 'activity-v1'); fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'control'), 'legacy-private');
  await f.pass(); assert.equal(fs.readFileSync(path.join(old, 'control'), 'utf8'), 'legacy-private');
  assert.deepEqual(f.bodies[0].events, f.events.map(r => r.event));
});

for (const action of ['read', 'crash']) {
test(`consumer recovery and stable gap IDs reopen after native process ${action}`, { skip: prerequisite }, async t => {
  const f = await fixture(t); const first = f.open().read();
  assert.equal(f.open().resolve(first.token, { eventIds: [first.token.eventIds[0]], reason: 'event_conflict' }).ok, true);
  const read = f.open().read();
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_)/i.test(k) || ['NODE_OPTIONS', 'HERMES_SESSION_ID'].includes(k.toUpperCase())) delete env[k];
  const input = { directory: f.directory, agentId: 'agent-1', endpoint: f.endpoint, wrapper: process.env.AIFY_WRAPPER_REPO, action };
  fs.writeFileSync(path.join(f.root, 'child-input.json'), JSON.stringify(input));
  const child = spawnSync(process.execPath, [path.join(import.meta.dirname, 'data/activity-consumer-child.mjs'), JSON.stringify(input)], { env, encoding: 'utf8' });
  assert.equal(child.status, action === 'crash' ? 23 : 0, child.stderr);
  const reopened = JSON.parse(child.stdout);
  assert.deepEqual(reopened.gaps, read.gaps, 'fresh-process gap identity is stable');
  assert.deepEqual(reopened.token, read.token, 'fresh-process checkpoint is the same contiguous prefix');
  assert.deepEqual(reopened.records.map(r => r.record.event), [f.events[1].event]);
  if (action === 'crash') {
    assert.equal(fs.existsSync(path.join(path.dirname(f.checkpoint), 'lock')), true, 'native crash really leaves the owned lock');
    const recovered = f.open().read();
    assert.equal(recovered.ok, true, 'dead-owner lock reopens without a timeout-based unlock');
    assert.deepEqual(recovered.gaps, read.gaps, 'native crash cannot change stable gap identities');
  }
});
}
