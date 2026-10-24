// Crash recovery and final-effect guards. Prior prefix tests do not govern raw unlink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { reclamationFixture, commit } from './_activity-reclamation-fixture.mjs';
import { prerequisite } from './_activity-fixture.mjs';
const options = { skip: prerequisite };
async function prepare(f) {
  const owner = await f.owner(), r = f.record(owner.lifetime), file = f.append(r);
  const loss = file.replace('.jsonl', '.loss'); fs.writeFileSync(loss, '?');
  commit(f.open(), f.open().read()); await owner.end();
  const terminal = f.open().read(); assert.equal(terminal.gaps[0]?.reason, 'reclaimed');
  return { file, loss, terminal, record: r };
}

test('native crashes retain exact terminal obligation and distinguish committed unlink outcomes from ambiguous missing paths', options, async t => {
  for (const boundary of ['before-ack-save', 'before-marker', 'after-marker', 'marker-saved', 'after-raw', 'raw-saved']) {
    const f = await reclamationFixture(t), { file, loss, terminal } = await prepare(f);
    if (boundary !== 'before-ack-save') commit(f.open(), terminal);
    const input = path.join(f.root, 'crash-input.json');
    const bytes = Buffer.from(JSON.stringify({ boundary, directory: f.directory, endpoint: f.endpoint,
      wrapper: process.env.AIFY_WRAPPER_REPO, token: terminal.token })); fs.writeFileSync(input, bytes);
    const before = createHash('sha256').update(bytes).digest('hex');
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_)/i.test(k) || ['NODE_OPTIONS', 'HERMES_SESSION_ID'].includes(k.toUpperCase())) delete env[k];
    const child = spawnSync(process.execPath, [path.join(import.meta.dirname, 'data/activity-reclamation-crash.mjs'), input], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 23, `${boundary}: ${child.stderr}`);
    const worker = JSON.parse(child.stdout); assert.equal(worker.version, process.version); assert.equal(worker.executable, process.execPath);
    assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' }, 'owned crashed worker is gone');
    assert.doesNotThrow(() => process.kill(process.pid, 0), 'same-run liveness positive control');
    assert.equal(createHash('sha256').update(fs.readFileSync(input)).digest('hex'), before, 'executed generated inputs unchanged');
    const disk = JSON.parse(fs.readFileSync(f.checkpoint)), source = Object.values(disk.sources)[0];
    assert.equal(source.retirement.id, terminal.gaps[0].id);
    if (boundary === 'before-ack-save') {
      const retry = f.open().read(); assert.deepEqual(retry.token, terminal.token); assert.equal(fs.existsSync(file), true);
      commit(f.open(), retry); f.open().read(); assert.equal(fs.existsSync(file), false);
    } else if (boundary === 'after-marker' || boundary === 'after-raw') {
      assert.equal(f.open().read().ok, false, 'missing before an outcome save is not attributed to this consumer');
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.checkpoint)).sources).length, 1, 'ambiguous outcome retains a bounded slot');
    } else {
      assert.equal(f.open().read().ok, true, `${boundary}: persisted outcome permits restart continuation`);
      assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(loss), false);
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.checkpoint)).sources).length, 0);
    }
  }
});

test('unlink refusal retries only a later read without idle checkpoint churn or clearing source loss', options, async t => {
  const f = await reclamationFixture(t), { file, loss, terminal, record } = await prepare(f); commit(f.open(), terminal);
  const unlink = fs.unlinkSync; let calls = 0;
  fs.unlinkSync = function(p, ...args) {
    if (p === file) { calls++; const error = Error('owned injected sharing violation'); error.code = 'EBUSY'; throw error; }
    return unlink.call(this, p, ...args);
  };
  try {
    assert.equal(f.open().read().ok, true); const bytes = fs.readFileSync(f.checkpoint);
    assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(loss), false, 'marker removal already recorded');
    assert.equal(f.open().read().ok, true); assert.deepEqual(fs.readFileSync(f.checkpoint), bytes, 'no repeated idle publication');
    assert.equal(calls, 2, 'one attempted unlink on each existing read, no new retry loop');
  } finally { fs.unlinkSync = unlink; }
  // A callback recreating the marker after its acknowledged removal creates a fresh obligation.
  fs.writeFileSync(loss, '?');
  const late = { ...record, event: { ...record.event, eventId: randomUUID() } }; f.append(late);
  const next = f.open().read(); assert.ok(next.gaps.some(g => g.reason === 'producer_loss'));
  assert.equal(next.coverage, 'unknown'); commit(f.open(), next);
  const again = f.open().read(); commit(f.open(), again); f.open().read(); assert.equal(fs.existsSync(file), false);
});

test('a newly unanswered END at the final effect blocks unlink even after terminal gap ACK', options, async t => {
  const f = await reclamationFixture(t), { file, terminal } = await prepare(f); commit(f.open(), terminal);
  const c = f.open({ probe: () => new Map() }); assert.equal(c.read().ok, true);
  assert.equal(fs.existsSync(file), true, 'fresh final END check is required, the previous proof is not enough');
  f.open().read(); assert.equal(fs.existsSync(file), false);
});

test('same-name replacement after committed terminal ACK is read and cannot be unlinked using that ACK', options, async t => {
  const f = await reclamationFixture(t), { file, terminal, record } = await prepare(f); commit(f.open(), terminal);
  const old = path.join(f.root, 'old-segment'); fs.renameSync(file, old);
  const fresh = { ...record, event: { ...record.event, eventId: randomUUID() } }; f.append(fresh); fs.unlinkSync(old);
  const next = f.open().read(); assert.equal(fs.existsSync(file), true);
  assert.deepEqual(next.records.map(v => v.record.event), [fresh.event], 'new identity is consumed from byte zero');
});

test('same-byte different file identity after terminal ACK cannot be removed with the old committed generation', options, async t => {
  const f = await reclamationFixture(t), { file, terminal } = await prepare(f); commit(f.open(), terminal);
  const bytes = fs.readFileSync(file), old = path.join(f.root, 'old-segment');
  fs.renameSync(file, old); fs.writeFileSync(file, bytes); fs.unlinkSync(old);
  const next = f.open().read();
  assert.equal(fs.existsSync(file), true, 'same bytes do not authorize deleting a different inode');
  assert.equal(next.records.length, 1); assert.ok(next.gaps.some(g => g.reason === 'identity'));
});

test('an obsolete persisted terminal ACK generation cannot authorize deletion of the current source checkpoint', options, async t => {
  const f = await reclamationFixture(t), { file, terminal } = await prepare(f); commit(f.open(), terminal);
  const state = JSON.parse(fs.readFileSync(f.checkpoint)), source = Object.values(state.sources)[0];
  source.retirement.generation--; source.retirement.ackGeneration--;
  fs.writeFileSync(f.checkpoint, JSON.stringify(state)); const before = fs.readFileSync(f.checkpoint);
  assert.equal(f.open().read().ok, false, 'obsolete terminal ACK generation must fail closed');
  assert.equal(fs.existsSync(file), true); assert.deepEqual(fs.readFileSync(f.checkpoint), before);
});

test('a lease ancestor containing .jsonl cannot redirect source-marker lookup or leave an orphan after reclamation', options, async t => {
  const f = await reclamationFixture(t), owner = await f.owner();
  const directory = path.join(f.root, 'leases.jsonl', 'agent-1', 'activity-v2');
  assert.equal(f.producer({ directory }).append(f.record(owner.lifetime)).ok, true);
  const name = fs.readdirSync(directory)[0], file = path.join(directory, name);
  const loss = path.join(directory, name.replace(/\.jsonl$/, '.loss')); fs.writeFileSync(loss, '?');
  const open = () => f.open({ directory });
  const first = open().read(); assert.ok(first.gaps.some(g => g.reason === 'producer_loss')); commit(open(), first);
  await owner.end(); const terminal = open().read(); assert.equal(terminal.gaps[0]?.reason, 'reclaimed');
  commit(open(), terminal); assert.equal(open().read().ok, true);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(loss), false, 'actual source marker must be removed with the raw segment');
});
