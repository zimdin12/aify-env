// New obligations: physical removal, bounded slots, END/ACK/identity guards. No prior test deletes raw input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { reclamationFixture, commit, receipt } from './_activity-reclamation-fixture.mjs';
import { prerequisite, conflict, ack } from './_activity-fixture.mjs';
const options = { skip: prerequisite };
async function drained(f) {
  const owner = await f.owner(), record = f.record(owner.lifetime), file = f.append(record);
  const c = f.open(); commit(c, c.read()); await owner.end();
  return { owner, record, file, c };
}
function terminal(c) {
  const r = c.read(); assert.equal(r.ok, true);
  assert.equal(r.gaps[0]?.reason, 'reclaimed', 'ended drained source must ship a terminal reclaimed gap');
  assert.deepEqual(r.records, []); return r;
}

test('17 sequential ended incarnations free both real producer capacity and bounded checkpoint slots', options, async t => {
  const f = await reclamationFixture(t, { policy: { maxSessions: 1 } });
  const generations = [];
  for (let i = 0; i < 17; i++) {
    const { c, file } = await drained(f); const r = terminal(c); generations.push(r.generation);
    assert.equal(fs.existsSync(file), true, 'terminal publication is not an ACK');
    commit(c, r); f.open().read();
    assert.equal(fs.existsSync(file), false, `ended source ${i + 1} physically removed`);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.checkpoint)).sources).length, 0, 'slot really retired on disk');
  }
  assert.ok(generations.every((v, i) => i === 0 || v > generations[i - 1]), 'recycled slots never reset delivery generation');
});

// Each population owns one drained source. A spurious terminal batch cannot be
// confused with an ordinary record left queued by another source's recovery.
for (const kind of ['LIVE', 'null', 'unknown', 'unbound historical']) {
  test(`fully ACKed ${kind} incarnation remains physically retained`, options, async t => {
    const f = await reclamationFixture(t); const owner = await f.owner();
    const incarnation = kind === 'LIVE' ? owner.lifetime : kind === 'null' ? null : kind === 'unknown' ? 'unknown' : randomUUID();
    const file = f.append(f.record(incarnation)), c = f.open(), first = c.read();
    assert.equal(first.source.incarnation, incarnation);
    assert.equal(first.records.length, 1, 'one original source record is ready');
    commit(c, first);
    const before = fs.readFileSync(f.checkpoint), idle = f.open().read();
    assert.equal(idle.ok, true, 'protected source remains readable');
    assert.deepEqual(idle.records, [], 'no unrelated queued record can satisfy this discriminator');
    assert.equal(idle.token, null, `${kind} incarnation cannot acquire terminal reclamation`);
    assert.deepEqual(fs.readFileSync(f.checkpoint), before, 'ordinary drained lifecycle observation publishes no checkpoint');
    assert.equal(fs.existsSync(file), true, 'protected source remains on disk');
  });
}

test('terminal retry survives reopen and malformed ACK, 409 and transport failure cannot authorize deletion', options, async t => {
  const f = await reclamationFixture(t); const { c, file } = await drained(f); const r = terminal(c);
  const reopen = f.open().read();
  assert.equal(fs.existsSync(file), true, 'a pending terminal gap never authorizes physical unlink');
  assert.deepEqual(reopen.token, r.token, 'same pending generation and IDs across reopen');
  assert.equal(c.ack(r.token, { ...receipt(r), gapIds: [] }).ok, false);
  f.respond(() => ({ destroy: true })); await f.pass(); assert.equal(fs.existsSync(file), true);
  f.respond(b => conflict(b, [], b.coverage.gaps.map(g => g.id))); await f.pass();
  const retry = terminal(f.open());
  assert.notEqual(retry.gaps[0].id, r.gaps[0].id, 'a conflict replaces the ID, not its terminal meaning');
  assert.equal(fs.existsSync(file), true);
  f.respond(b => ({ body: ack(b) })); await f.pass();
  assert.equal(fs.existsSync(file), true, 'durable ACK precedes unlink');
  await f.pass(); assert.equal(fs.existsSync(file), false, 'production lifecycle wiring reaches real reclamation');
});

test('new suffix after terminal publication refuses reclamation until its bytes and a new terminal gap ACK', options, async t => {
  const f = await reclamationFixture(t); const { c, file, record } = await drained(f); const r = terminal(c);
  const late = { ...record, event: { ...record.event, eventId: randomUUID() } }; f.append(late);
  commit(c, r); const next = f.open().read();
  assert.equal(fs.existsSync(file), true); assert.deepEqual(next.records.map(v => v.record.event), [late.event]);
  commit(f.open(), next); const again = terminal(f.open()); assert.notEqual(again.gaps[0].id, r.gaps[0].id);
  commit(f.open(), again); f.open().read(); assert.equal(fs.existsSync(file), false);
});

test('same-name recreation is consumed by FILE IDENTITY with a higher generation, never by retired cursor', options, async t => {
  const f = await reclamationFixture(t); const { c, file, record } = await drained(f); const r = terminal(c);
  commit(c, r); f.open().read(); assert.equal(fs.existsSync(file), false);
  const late = { ...record, event: { ...record.event, eventId: randomUUID() } }; f.append(late);
  const next = f.open().read(); assert.deepEqual(next.records.map(v => v.record.event), [late.event]);
  assert.ok(next.generation > r.generation, 'recreated deterministic source cannot replace newer receiver coverage with old generation');
  assert.equal(c.ack(r.token, receipt(r)).ok, false, 'old terminal token has no authority over a fresh file');
  assert.equal(fs.existsSync(file), true);
});

test('replacement before terminal ACK refuses the stale receipt and preserves replacement bytes', options, async t => {
  const f = await reclamationFixture(t); const { c, file } = await drained(f); const r = terminal(c);
  const bytes = fs.readFileSync(file); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, bytes); fs.unlinkSync(file + '.old');
  assert.equal(c.ack(r.token, receipt(r)).ok, false);
  const next = f.open().read(); assert.equal(next.records.length, 1); assert.ok(next.gaps.some(g => g.reason === 'identity'));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('loss marker must be ACKed and root uncertainty is never removed during physical retirement', options, async t => {
  const f = await reclamationFixture(t); const owner = await f.owner(), file = f.append(f.record(owner.lifetime));
  const loss = file.replace('.jsonl', '.loss'), root = file.replace(/session-.+$/, 'uncertain');
  fs.writeFileSync(loss, '?'); fs.writeFileSync(root, '?');
  const c = f.open(), first = c.read(); assert.ok(first.gaps.some(g => g.reason === 'producer_loss'));
  await owner.end(); assert.equal(c.ack(first.token, { ...receipt(first), gapIds: [] }).ok, false);
  assert.equal(fs.existsSync(loss), true); commit(c, first);
  const r = terminal(c); commit(c, r); f.open().read();
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(loss), false); assert.equal(fs.readFileSync(root, 'utf8'), '?');
});

test('typed unknown process evidence cannot retire a previously bound dead source', options, async t => {
  const f = await reclamationFixture(t); const { file } = await drained(f);
  const c = f.open({ probe: () => new Map() });
  assert.equal(c.read().token, null); assert.equal(fs.existsSync(file), true, 'unanswered is not process death');
  const real = terminal(f.open()); commit(f.open(), real); f.open().read(); assert.equal(fs.existsSync(file), false, 'same-run real evidence positive control');
});
