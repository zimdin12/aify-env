// Actual approved observer paused after O_APPEND open, not fake filesystem or PID evidence.
// This proves honest declared tail loss, not actual Claude/ConPTY launch or a real receiver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reclamationFixture } from './_activity-reclamation-fixture.mjs';
import { prerequisite, until } from './_activity-fixture.mjs';
import { probeProcesses } from '../lib/process-probe.mjs';
const gone = pid => { try { process.kill(pid, 0); return false; } catch (e) { assert.equal(e.code, 'ESRCH'); return true; } };

test('production plugin declares and ACKs reclaimed tail before removing a source with a real async hook still at writeSync', { skip: prerequisite }, async t => {
  let cleanup = async () => {};
  t.after(async () => cleanup()); // Runs before fixture root teardown.
  const f = await reclamationFixture(t), lifetime = randomUUID(), instance = 'reclamation-instance';
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_)/i.test(k) || ['NODE_OPTIONS', 'HERMES_SESSION_ID'].includes(k.toUpperCase())) delete env[k];
  Object.assign(env, { ACTIVITY_LIFETIME_BOX: f.root.replaceAll('\\', '/'), AIFY_FILE_ACTIVITY: '1', AIFY_AGENT_ID: 'agent-1',
    AIFY_ENV_INSTANCE: instance, AIFY_LIFETIME: lifetime, AIFY_AGENT_LEASE_DIR: f.leases,
    ACTIVITY_NATIVE_NODE: process.execPath.replaceAll('\\', '/'),
    ACTIVITY_LIFETIME_PRELOAD: new URL('./data/activity-reclamation-lifetime-preload.mjs', import.meta.url).href,
    AIFY_WRAPPER_REPO: process.env.AIFY_WRAPPER_REPO.replaceAll('\\', '/') });
  const input = Buffer.from(JSON.stringify({ lifetime, instance, env, interpreter: process.execPath,
    ownerScript: 'tests/data/activity-reclamation-lifetime-owner.sh' }));
  const inputFile = path.join(f.root, 'observer-input.json'); fs.writeFileSync(inputFile, input);
  const sha = v => createHash('sha256').update(v).digest('hex'); const before = sha(input);
  const owner = spawn('C:/Program Files/Git/bin/bash.exe', [fileURLToPath(new URL('./data/activity-reclamation-lifetime-owner.sh', import.meta.url)).replaceAll('\\', '/')], { env, stdio: 'ignore', windowsHide: true });
  const exit = new Promise((resolve, reject) => { owner.once('error', reject); owner.once('exit', code => resolve(code)); });
  let ready = null;
  cleanup = async () => {
    fs.writeFileSync(path.join(f.root, 'exit-owner'), '1'); fs.writeFileSync(path.join(f.root, 'release-writer'), '1');
    assert.equal(await exit, 0);
    if (ready) await until(() => gone(ready.pid), 'exact owned native observer gone before root teardown', 10000);
  };
  await until(() => fs.existsSync(path.join(f.root, 'writer-ready.json')), 'real observer reaches actual writeSync after O_APPEND open', 15000);
  ready = JSON.parse(fs.readFileSync(path.join(f.root, 'writer-ready.json')));
  assert.equal(ready.version, process.version); assert.equal(ready.executable, process.execPath);
  const live = probeProcesses([owner.pid, ready.pid, process.pid]);
  assert.equal(live.get(process.pid)?.alive, true); assert.equal(live.get(owner.pid)?.alive, true); assert.equal(live.get(ready.pid)?.alive, true);
  f.stateHost.startManaged({ agentId: 'agent-1', lifetime, instance, pid: owner.pid, handle: 'owned-bash', writtenAtUs: Date.now() * 1000 });
  await f.pass(); assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].events.length, 1, 'real first CLI observer frame committed');
  assert.equal(f.stateHost.retirementProof([lifetime]).holds, false);
  fs.writeFileSync(path.join(f.root, 'exit-owner'), '1'); assert.equal(await exit, 0);
  assert.equal(f.stateHost.endManaged(lifetime).ended, true); assert.equal(f.stateHost.retirementProof([lifetime]).holds, true);
  assert.equal(gone(owner.pid), true); assert.equal(gone(ready.pid), false, 'real async hook outlives authoritative lifetime END');
  await f.pass(); const tail = f.bodies.at(-1);
  assert.equal(tail.coverage.gaps[0]?.reason, 'reclaimed', 'tail is explicitly possibly incomplete, never complete');
  const source = Object.values(JSON.parse(fs.readFileSync(f.checkpoint)).sources)[0];
  assert.equal(source.retirement.phase, 'acked'); assert.equal(source.retirement.ackGeneration, tail.coverage.generation);
  const names = () => fs.readdirSync(f.directory).filter(n => n.endsWith('.jsonl'));
  await f.pass(); const removedBeforeRelease = names().length === 0;
  fs.writeFileSync(path.join(f.root, 'release-writer'), '1');
  await until(() => fs.existsSync(path.join(f.root, 'writer-exited.json')), 'real observer finishes its actual append', 10000);
  await until(() => gone(ready.pid), 'native observer exits', 10000);
  // On Windows sharing refusal retains the file; an allowed unlink can lose this open-inode tail.
  if (names().length) {
    await f.pass();
    assert.ok(f.bodies.some(b => b.events.some(e => e.path.raw === 'after-end.txt')), 'retained file late frame is captured');
  } else assert.ok(f.bodies.some(b => b.coverage.gaps.some(g => g.reason === 'reclaimed')), 'unlinked tail has an ACKed declared gap');
  // Finish any retained-file retry, then reopen this exact deterministic source with the real CLI.
  for (let i = 0; i < 3 && names().length; i++) await f.pass();
  assert.equal(names().length, 0, 'old segment retired before fresh-open callback');
  const freshEnv = { ...env }; delete freshEnv.ACTIVITY_LIFETIME_PRELOAD;
  const freshInput = JSON.stringify({ session_id: 'lifetime-fixture-session', cwd: 'C:/fixture/project',
    tool_name: 'Read', tool_input: { file_path: 'fresh-open-after-unlink.txt' } });
  fs.writeFileSync(path.join(f.root, 'fresh-observer-input.json'), freshInput);
  const fresh = spawnSync(process.execPath, [path.join(env.AIFY_WRAPPER_REPO, 'bin/aify-tool-event.mjs'), 'success'],
    { env: freshEnv, input: freshInput, encoding: 'utf8', timeout: 15000 });
  assert.equal(fresh.status, 0, fresh.stderr); assert.equal(names().length, 1, 'real callback recreates same-name file');
  await f.pass();
  const recreated = f.bodies.at(-1);
  assert.equal(recreated.events[0]?.path.raw, 'fresh-open-after-unlink.txt', 'new file identity is consumed, not skipped by retired offset');
  assert.ok(recreated.coverage.generation > tail.coverage.generation);
  assert.equal(sha(fs.readFileSync(inputFile)), before, 'generated native inputs remain byte-identical');
  const report = { runtime: process.version, observerPid: ready.pid, observerCreatedAtUs: live.get(ready.pid).createdAtUs,
    ownerPid: owner.pid, ownerCreatedAtUs: live.get(owner.pid).createdAtUs, removedBeforeRelease,
    terminalGap: tail.coverage.gaps[0], ackGeneration: tail.coverage.generation,
    generatedInputSha256Before: before, generatedInputSha256After: sha(fs.readFileSync(inputFile)),
    ownerGone: gone(owner.pid), observerGone: gone(ready.pid), limitations: 'Owned Bash/native observer fixture; HTTP stub, not Claude/ConPTY or dashboard.' };
  fs.writeFileSync(path.join(f.root, 'tail-receipt.json'), JSON.stringify(report));
});
