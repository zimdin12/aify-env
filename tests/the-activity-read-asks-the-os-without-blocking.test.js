// The activity read asks the OS about an agent's pid through the daemon's ProcessProbeCache, never by a synchronous
// PowerShell: that one held the event loop, and every herdr pane on it, for about a second per idle source per pass.
// An answer that never blocks must still arrive: the witness is taken once the background probe lands, and a pid
// reused after its agent ended passes for that agent only until the next probe lands, never after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { ProcessProbeCache, probeProcesses } from '../lib/process-probe.mjs';
import { reclamationFixture, commit } from './_activity-reclamation-fixture.mjs';
import { prerequisite } from './_activity-fixture.mjs';

/** Counts each synchronous powershell.exe the process starts, through the binding process-probe.mjs imports. */
function syncPowerShells(t) {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const original = childProcess.spawnSync;
  let count = 0;
  childProcess.spawnSync = function (file, ...rest) {
    if (/powershell/i.test(String(file))) count += 1;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  return { taken: () => { const seen = count; count = 0; return seen; } };
}

const checkpointed = (f, file) => JSON.parse(fs.readFileSync(f.checkpoint)).sources[path.basename(file)] ?? null;
/** A consumer whose agents port answers from `cache`, as the daemon's does. */
const throughCache = (f, cache) => () => f.open({ agents: { rawIdentity: id => f.agents.rawIdentity(id),
  processes: (pids, options) => cache.answers(pids, options) } });

test('the production pass asks through the daemon\'s cache: no read blocks, the witness arrives within one probe, and the ended source is reclaimed',
  { skip: prerequisite || (process.platform !== 'win32' && 'the OS probe answers only on Windows') }, async t => {
    const cache = new ProcessProbeCache(); cache.serve();
    const f = await reclamationFixture(t, { processes: (pids, options) => cache.answers(pids, options) });
    const owner = await f.owner(), file = f.append(f.record(owner.lifetime));
    const spawned = syncPowerShells(t);
    probeProcesses([process.pid]);
    assert.equal(spawned.taken(), 1, 'positive control: the spy sees a synchronous probe');

    await f.pass();
    assert.equal(checkpointed(f, file)?.offset > 0, true, 'the record was read and shipped');
    assert.equal(checkpointed(f, file).witness, null, 'the pid was never probed, and the read did not wait for it');
    // ProcessProbeCache.answers puts an unanswered pid on `stale` and starts `refresh(stale)`; this waits for that probe.
    await cache.refresh([]);
    await f.pass();
    const witness = checkpointed(f, file)?.witness;
    assert.deepEqual({ pid: witness?.pid, createdAtUs: witness?.createdAtUs }, { pid: owner.child.pid, createdAtUs: owner.createdAtUs },
      'the idle source is witnessed once that probe has landed');
    assert.equal(spawned.taken(), 0, 'no read probed synchronously');
    const stamp = () => ({ bytes: fs.readFileSync(f.checkpoint).toString('base64'), mtime: fs.statSync(f.checkpoint, { bigint: true }).mtimeNs });
    const saved = stamp(); await f.pass();
    assert.deepEqual(stamp(), saved, 'the witness is saved once: the next idle pass leaves the checkpoint unwritten');

    await owner.end(); spawned.taken();
    for (let i = 0; i < 4 && fs.existsSync(file); i++) await f.pass();
    assert.equal(fs.existsSync(file), false, 'the ended source is reclaimed through the production wiring');
    assert.equal(spawned.taken(), 0, 'nor did reclaiming it');
  });

test('the daemon hands its lifecycle ports the cache\'s answer, without which no source is ever witnessed', () => {
  // Read, never imported: importing bin starts the daemon. A dropped line fails closed and silently (nothing reclaimed).
  const source = fs.readFileSync(path.join(import.meta.dirname, '../bin/aify-env.mjs'), 'utf8');
  const call = source.slice(source.indexOf('createAgentLifecyclePorts({'), source.indexOf('});', source.indexOf('createAgentLifecyclePorts({')));
  assert.match(call, /onStopChange/, 'positive control: the slice is the lifecycle ports call');
  assert.match(call, /\bprocesses: agentState\.processes,/, 'the plugin\'s agents port answers from the daemon\'s ProcessProbeCache');
});

test('a pid reused after its agent ended keeps its old answer until the next probe lands, and only then is the source reclaimed',
  { skip: prerequisite }, async t => {
    // The OS, scripted: the pid stays alive by signal 0 throughout, and its birth changes when it is reused.
    let born = null, nowMs = 0;
    const probes = [];
    const cache = new ProcessProbeCache({ state: () => 'alive', nowMs: () => nowMs,
      probe: async pids => { probes.push(pids); return new Map(pids.map(pid => [pid, { alive: true, createdAtUs: born, commandLine: null }])); } });
    cache.serve();
    const f = await reclamationFixture(t);
    const owner = await f.owner(), file = f.append(f.record(owner.lifetime));
    // The clock starts after the record was written, as a real one would: an answer older than the record is never taken.
    born = owner.createdAtUs; nowMs = Math.floor(f.agents.rawIdentity('agent-1').current.writtenAtUs / 1000) + 1;
    const open = throughCache(f, cache);

    const c = open(); commit(c, c.read());
    assert.equal(checkpointed(f, file).witness, null, 'nothing was answered yet');
    await cache.refresh([]);
    assert.equal(open().read().token, null, 'an idle live source ships nothing');
    assert.equal(checkpointed(f, file).witness?.createdAtUs, owner.createdAtUs, 'the witness taken on that idle read was kept');

    await owner.end();
    born = owner.createdAtUs + 1;
    nowMs += 10_000;
    assert.equal(open().read().token, null, 'inside the window the kept answer stands for the reused pid: reclamation waits');
    assert.equal(probes.length, 1, 'and no probe was started');
    nowMs += 25_000;
    assert.equal(open().read().token, null, 'past it a probe starts, and the read does not wait for it: reclamation still waits');
    assert.equal(probes.length, 2, 'that probe was started');
    await cache.refresh([]);

    const last = open(), terminal = last.read();
    assert.equal(terminal.gaps[0]?.reason, 'reclaimed', 'the landed probe shows a different birth: the agent has ended');
    commit(last, terminal); open().read();
    assert.equal(fs.existsSync(file), false, 'and the source is reclaimed');
  });

test('a pid whose previous holder the cache still remembers is witnessed by its own birth, never by that holder\'s',
  { skip: prerequisite }, async t => {
    // The OS, scripted, on a clock the test moves: the pid's previous holder was answered just before this lifetime's
    // record was written, and is still inside the cache's window when the source is first read.
    let born = null, nowMs = 0;
    const cache = new ProcessProbeCache({ state: () => 'alive', nowMs: () => nowMs,
      probe: async pids => new Map(pids.map(pid => [pid, { alive: true, createdAtUs: born, commandLine: null }])) });
    cache.serve();
    const f = await reclamationFixture(t);
    const owner = await f.owner(), file = f.append(f.record(owner.lifetime));
    const writtenAtMs = Math.floor(f.agents.rawIdentity('agent-1').current.writtenAtUs / 1000);
    nowMs = writtenAtMs - 5_000; born = owner.createdAtUs - 1;
    cache.answers([owner.child.pid]); await cache.refresh([]);
    nowMs = writtenAtMs + 5_000; born = owner.createdAtUs;
    const open = throughCache(f, cache);

    const c = open(); commit(c, c.read());
    assert.equal(checkpointed(f, file).witness, null, 'the previous holder\'s answer is not taken for this lifetime');
    await cache.refresh([]);
    open().read();
    assert.equal(checkpointed(f, file).witness?.createdAtUs, owner.createdAtUs, 'the witness is the birth a probe after the record found');
  });
