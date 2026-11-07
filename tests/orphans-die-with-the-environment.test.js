// Product disappearance is asserted before fixture teardown. No cleanup signals a saved HTTP PID.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealedDaemonEnv } from './_sealed-daemon-env.mjs';
import { ControlledFamily } from './fixtures/controlled-family.mjs';

const DAEMON = fileURLToPath(new URL('../bin/aify-env.mjs', import.meta.url));
const ownedDaemons = new Set();
const RECORD_ONLY = process.env.AIFY_TEST_ORPHAN_RECORD_ONLY === '1';

async function endDaemon(child, signal = 'SIGKILL') {
  assert.ok(ownedDaemons.has(child), 'only the actual daemon ChildProcess spawned by this test may be stopped');
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('owned daemon did not exit within 20000ms')), 20_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

afterEach(async () => {
  for (const child of ownedDaemons) await endDaemon(child);
  ownedDaemons.clear();
});

async function startDaemon(record) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: sealedDaemonEnv({ AIFY_ENV_PROCESS_RECORD: record }),
    });
    ownedDaemons.add(child);
    let out = '', errors = '', settled = false;
    const timer = setTimeout(() => reject(Error(`daemon did not start: ${out}\n${errors}`)), 20_000);
    child.stdout.on('data', chunk => {
      out += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve({ child, base: match[1] }); }
    });
    // Drain stderr on both success and failure; a full pipe must not block the daemon.
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      if (!settled) { clearTimeout(timer); reject(Error(`daemon exited ${code}/${signal}: ${errors}`)); }
    });
  });
}

function recordPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-orphan-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'owned.json');
}

function trackFamily(t, family, cleanupContext) {
  const before = family.inputSnapshot(), key = path.basename(family.dir);
  t.after(async () => {
    let after = null, outcome = null;
    try { after = family.inputSnapshot(); }
    finally {
      try { outcome = await family.dispose(cleanupContext()); }
      finally {
        const dir = process.env.AIFY_TEST_EVIDENCE_DIR;
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'inputs-' + key + '.json'), JSON.stringify({ before, after, outcome }, null, 2));
        }
      }
    }
    assert.deepEqual(after, before, 'the actual generated launcher/worker inputs must remain unchanged through execution');
    assert.equal(outcome.confirmed, true, outcome.problem || 'fixture cleanup remained unknown');
  });
}

async function startFamily(t, daemon, { hasChild = true } = {}) {
  const family = new ControlledFamily({ hasChild });
  let created = null, registration = null;
  trackFamily(t, family, () => ({ registration, expectedPid: created?.pid ?? null }));
  const response = await fetch(`${daemon.base}/processes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'aify-comms', launcher: family.launcher, cwd: family.dir }),
  });
  assert.equal(response.status, 201, `fixture launcher was refused: ${await response.clone().text()}`);
  created = await response.json();
  registration = await family.ready({ expectedPid: created.pid });
  if (process.env.AIFY_TEST_ORPHAN_REQUIRE_PIPED === '1') {
    assert.equal(created.terminal, false, 'this qualification explicitly requires the real piped fallback');
  }
  assert.equal(await family.originalsGone(registration), false, 'the fixture must actually exist before a product effect');
  assert.equal(family.stopRequested(), false, 'teardown must not supply the product trigger');
  return { family, registration, created };
}

async function assertProductGone(family, registration, what) {
  if (RECORD_ONLY) {
    // Input control omits the product request, never mutates a daemon or a native ending implementation.
    assert.equal(await family.productGone(registration), true, `${what}: record-only request leaves the actual fixture alive`);
  } else {
    await family.until(() => family.productGone(registration), what);
  }
}

function evidence(t, name, facts) {
  const dir = process.env.AIFY_TEST_EVIDENCE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ recordOnly: RECORD_ONLY, ...facts }, null, 2)));
}

test('a process outlives a KILLED environment, and the next one reaps it', async t => {
  const record = recordPath(t), first = await startDaemon(record);
  const { family, registration } = await startFamily(t, first, { hasChild: false });
  evidence(t, 'crashed-environment', { births: [registration.root.birth] });
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).length, 1, 'the owning record is the actual recovery trigger');
  if (!RECORD_ONLY) {
    await endDaemon(first.child);
    if (process.platform === 'win32') {
      // This fixture qualifies the console-dies-with-owner arm, never an unscoped recovery snapshot.
      await family.until(() => family.productGone(registration), 'original Windows fixture root absent before successor boot');
    }
    await startDaemon(record);
  }
  // Both dying with the owner and verified recovery are valid; private teardown/TTL is not.
  await assertProductGone(family, registration, 'original fixture after replacement boot');
});

test('a graceful stop takes its processes with it', { skip: process.platform === 'win32'
  && 'Windows: external SIGTERM is TerminateProcess; no shutdown handler runs' }, async t => {
  const daemon = await startDaemon(recordPath(t));
  const { family, registration } = await startFamily(t, daemon);
  evidence(t, 'graceful-environment', { births: [registration.root.birth, ...registration.children.map(row => row.birth)] });
  if (!RECORD_ONLY) await endDaemon(daemon.child, 'SIGTERM');
  await assertProductGone(family, registration, 'graceful product shutdown must end the root and its real descendant');
});

test('a GRANDCHILD dies too — killing the launcher is not enough', async t => {
  const daemon = await startDaemon(recordPath(t));
  const { family, registration, created } = await startFamily(t, daemon);
  evidence(t, 'real-descendant', { births: [registration.root.birth, ...registration.children.map(row => row.birth)] });
  assert.equal(await family.countChildren(registration), 1, 'positive control: the real registered descendant must be present');
  if (!RECORD_ONLY) {
    const response = await fetch(`${daemon.base}/processes/${created.id}`, { method: 'DELETE' });
    assert.equal(response.ok, true, 'the actual owning product stop request must be accepted');
  }
  await assertProductGone(family, registration, 'the real descendant must disappear through product ending');
});

test('THE COUNT IS SCOPED TO ONE LAUNCHER, so a sibling test file cannot defeat it', async t => {
  const daemon = await startDaemon(recordPath(t));
  const { family, registration, created } = await startFamily(t, daemon);
  const empty = await startFamily(t, daemon, { hasChild: false });
  const decoy = new ControlledFamily();
  let decoyRegistration = null, decoyChild = null;
  trackFamily(t, decoy, () => ({ registration: decoyRegistration, expectedPid: decoyChild?.pid ?? null }));
  // An independent fixture, not a machine-wide process query or a product-managed sibling.
  decoyChild = spawn(process.execPath, [decoy.launcher], { stdio: 'ignore', windowsHide: true });
  decoyRegistration = await decoy.ready({ expectedPid: decoyChild.pid });
  evidence(t, 'scoped-observation', { ownedBirths: [registration.root.birth, ...registration.children.map(row => row.birth)],
    independentBirths: [decoyRegistration.root.birth, ...decoyRegistration.children.map(row => row.birth)] });
  assert.equal(await family.countChildren(registration), 1, 'same-run known-child positive control');
  assert.equal(await empty.family.countChildren(empty.registration), 0, 'same-run live-root/no-child negative control');
  assert.equal(await empty.family.originalsGone(empty.registration), false, 'zero children must not mean the root is gone');
  assert.equal(await decoy.countChildren(decoyRegistration), 1, 'the independent decoy really has a child');
  assert.equal(await family.countChildren(registration), 1, 'the independent child cannot inflate this fixture population');
  if (!RECORD_ONLY) {
    const response = await fetch(`${daemon.base}/processes/${created.id}`, { method: 'DELETE' });
    assert.equal(response.ok, true);
  }
  await assertProductGone(family, registration, 'scoped product root and descendant must disappear');
  assert.equal(await decoy.originalsGone(decoyRegistration), false, 'stopping the owned fixture must not stop the independent decoy');
  assert.equal(await decoy.countChildren(decoyRegistration), 1, 'decoy descendant remains outside the product stop');
});
