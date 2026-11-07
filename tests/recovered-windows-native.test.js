// Native qualification ONLY: actual shared probe/held protocol, confined to the test's own known tree.
// Never select this file for source mutants. No daemon entry, global process discovery or numeric cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { KnownWindowsTree } from './test-data/owned-windows-tree.mjs';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { observedBirth, heldBirthMatches } from '../lib/process-birth.mjs';
import { RecoveredProcessTermination } from '../lib/recovered-process-termination.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const end = performance.now() + timeout;
  do { if (check()) return true; await pause(20); } while (performance.now() < end);
  return check();
}
function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovered-win-native-'));
  const done = path.join(dir, 'done'), pids = path.join(dir, 'pids.json');
  const rootFile = path.join(dir, 'root.mjs'), childFile = path.join(dir, 'child.mjs');
  const rootExpired = path.join(dir, 'root-expired'), childExpired = path.join(dir, 'child-expired');
  const watcher = marker => `setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)}))process.exit(0)},20);setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'expired');process.exit(91)},60000);`;
  fs.writeFileSync(childFile, `import fs from 'node:fs';${watcher(childExpired)}\n`);
  fs.writeFileSync(rootFile, `import fs from 'node:fs';import{spawn}from'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:'ignore',detached:true,env:process.env});
child.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(pids+'.tmp')},JSON.stringify({child:process.pid,grandchild:child.pid}));fs.renameSync(${JSON.stringify(pids+'.tmp')},${JSON.stringify(pids)})});
${watcher(rootExpired)}\n`);
  const inputs = () => Object.fromEntries([rootFile, childFile].map(file => [path.basename(file), { present: fs.existsSync(file), sha256: hash(file), body: fs.readFileSync(file, 'utf8') }]));
  const before = inputs(), tree = new KnownWindowsTree({ recordOnly: process.env.AIFY_TEST_RECOVERY_RECORD_ONLY === '1' });
  const env = { HOME: dir, USERPROFILE: dir, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TMP: dir, TEMP: dir };
  const startedAt = Date.now(), root = tree.adopt(spawn(process.execPath, [rootFile], { cwd: dir, env, windowsHide: true, stdio: 'ignore' }));
  t.after(async () => {
    fs.writeFileSync(done, 'done');
    const ended = await until(() => !alive(tree.root) && (!tree.grandchild || !alive(tree.grandchild)), 5000);
    assert.ok(ended, 'fixture DONE cleanup was not observed; no numeric cleanup is attempted');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(await until(() => fs.existsSync(pids)), 'owned root really started its detached grandchild');
  tree.learn(pids);
  assert.ok(alive(tree.root) && alive(tree.grandchild), 'both fixture-owned processes are present before the probe');
  const identity = new ProcessIdentityProbe();
  const answer = (await identity.probe([tree.root])).get(tree.root);
  assert.equal(answer.alive, true);
  const birth = observedBirth(tree.root, answer);
  assert.ok(birth, 'native query supplied creation identity for this exact owned root');
  const record = { id: 'owned-native-root', pid: tree.root, owner: process.pid, service: 'fixture', launcher: rootFile, startedAt };
  const retain = (mode, result) => {
    assert.deepEqual(inputs(), before);
    for (const helper of tree.helperInputs) assert.deepEqual(helper.after, helper.before);
    assert.equal(fs.existsSync(rootExpired) || fs.existsSync(childExpired), false, 'a fixture expiry cannot pass for termination');
    const selected = process.env.AIFY_TEST_EVIDENCE_DIR;
    if (selected) {
      const output = path.resolve(selected), allowed = path.resolve(ROOT, '.check-output');
      assert.ok(output.startsWith(allowed + path.sep)); fs.mkdirSync(output, { recursive: true });
      const file = path.join(output, `recovered-win-${mode}.json`); assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(file, JSON.stringify({ mode, node: process.version, platform: process.platform, root: tree.root, grandchild: tree.grandchild,
        birth, result, recordOnly: tree.recordOnly, presence: { rootAlive: alive(tree.root), grandchildAlive: alive(tree.grandchild) },
        helpers: tree.helperInputs, inputs: { before, after: inputs() } }, null, 2));
    }
  };
  return { tree, identity, answer, birth, record, retain };
}

test('native Windows: CIM birth matches the held handle creation clock before a deliberate no-go',
  { skip: process.platform !== 'win32' && 'Windows-only owned-handle qualification', timeout: 40000 }, async t => {
    const f = await fixture(t);
    let observed = null;
    const result = await f.tree.held(f.tree.root, { stillOurs: proof => { observed = proof; return false; }, timeoutMs: 15000 })
      .then(() => null, error => error);
    f.retain('birth-no-go', { refused: result instanceof Error, held: observed });
    assert.ok(result instanceof Error, 'deliberate no-go must refuse');
    assert.equal(heldBirthMatches(f.birth, observed), true, 'actual clocks bind without a wall-time tolerance');
    assert.equal(heldBirthMatches({ ...f.birth, createdAtUs: f.birth.createdAtUs + 1 }, observed), false, 'one microsecond mismatch is refused');
    assert.ok(alive(f.tree.root) && alive(f.tree.grandchild), 'no-go left only this test-owned tree untouched');
  });

test('native Windows: recovered verified root ends its detached known tree through birth-matched handles',
  { skip: process.platform !== 'win32' && 'Windows-only owned-handle qualification', timeout: 40000 }, async t => {
    const f = await fixture(t);
    const termination = new RecoveredProcessTermination({ identity: f.identity, held: f.tree.held });
    const result = await termination.child(f.record, f.answer);
    f.retain('cleanup', result);
    assert.deepEqual(result, { state: 'gone', scope: 'reachable-held-tree' });
    assert.ok(await until(() => !alive(f.tree.root) && !alive(f.tree.grandchild)), 'both own processes ended before success');
    assert.deepEqual(f.tree.heldCalls, [f.tree.root]);
    assert.equal(f.tree.helpersStarted, 1);
  });
