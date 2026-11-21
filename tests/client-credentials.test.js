import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { credentialRefProblem, decodeCredential, readStoredCredentialSync, resolveServiceKey,
  resolveServiceKeySync, sameServiceEndpoint } from 'aify-env/client/credentials';
import { machineIdFor } from 'aify-env/client/machine-id';
import { machineIdFor as legacyMachineId } from '../lib/advertise.mjs';
import { hostIsWsl } from 'aify-env/host-wsl';
import { credentialRoot, readCredentialFileSync, writeCredentialFile } from '../lib/credential-fs.mjs';
import { inspectCredentialFile, inspectCredentialFileSync } from '../lib/credential-inspection.mjs';
import { selectEnvironmentCredential } from '../lib/credential-store.mjs';

const base = 'https://service.invalid/prefix';
const other = 'https://other.invalid/prefix';
const key = 'fixture-key-from-private-file';
const fromEnv = 'fixture-key-from-manual-pair';
const entry = { endpoint: base, credentialRef: 'service.key', keyEnv: ['FIRST', 'SECOND'] };
const adapters = [resolveServiceKey, resolveServiceKeySync];
const options = (extra = {}) => ({ url: base, env: {}, home: '', mode: 'reconcile', ...extra });
function privateHome(t) {
  // Do not let any test use the runtime's actual credential root.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'client-key-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  return home;
}

function noKey(result, state) {
  assert.equal(result.state, state, result.detail);
  assert.deepEqual([result.value, result.source ?? ''], ['', '']);
  assert.equal(result.detail.includes(key) || result.detail.includes(fromEnv), false, 'the detail must be safe to display');
}

test('canonical endpoint equality keeps authority and the exact path prefix', () => {
  assert.equal(sameServiceEndpoint('HTTPS://SERVICE.INVALID:443/prefix/', base), true);
  for (const bad of [other, 'http://service.invalid/prefix', `${base}/longer`, `${base}?x=`, `${base}#`,
    'https://@service.invalid/prefix', 'https:///service.invalid/prefix', 'ftp://service.invalid/prefix',
    '/prefix', 'https://localhost/prefix', 'https://service.invalid/Prefix']) {
    assert.equal(sameServiceEndpoint(base, bad), false);
  }
  assert.equal(sameServiceEndpoint('invalid', 'invalid'), false);
  assert.equal(sameServiceEndpoint('http://localhost:8800', 'http://127.0.0.1:8800'), false,
    'only a transport that rewrites loopback can authorize the rewritten base');
});

test('destination refusal precedes even looking for an environment key or store reference', async () => {
  let consulted = 0;
  const scoped = { endpoint: base, get credentialRef() { consulted++; return 'service.key'; },
    get keyEnv() { consulted++; return ['FIRST']; } };
  for (const resolve of adapters) {
    for (const mode of ['explicit-first', 'reconcile']) {
      const deny = await resolve(scoped, options({ url: other, env: { FIRST: fromEnv }, mode }));
      noKey(deny, 'endpoint-refused');
      assert.equal(deny.detail.includes(other), false);
    }
    assert.equal((await resolve({ endpoint: base, keyEnv: ['FIRST'] }, options({
      env: { FIRST: fromEnv }, mode: 'explicit-first',
    }))).value, fromEnv, 'control: a complete manual pair authorizes the selected base without a home');
  }
  assert.equal(consulted, 0, 'failed binding contacted the key sources');
});

test('explicit-first ignores the store but cannot salvage an invalid selected environment value', async () => {
  for (const resolve of adapters) {
    assert.equal((await resolve(entry, options({ mode: 'explicit-first', env: { FIRST: fromEnv } }))).value, fromEnv);
    noKey(await resolve(entry, options({ mode: 'explicit-first', env: { FIRST: ` ${fromEnv}`, SECOND: key } })), 'CREDENTIAL_INVALID');
    assert.equal((await resolve({ endpoint: base, keyEnv: ['FIRST', 'SECOND'] }, options({
      env: Object.assign(Object.create({ FIRST: key }), { SECOND: fromEnv }), mode: 'explicit-first',
    }))).value, fromEnv, 'inherited variables do not provide keys');
    noKey(await resolve(entry, options({ mode: 'other', env: { FIRST: fromEnv } })), 'CREDENTIAL_INVALID');
  }
  assert.equal(selectEnvironmentCredential(['FIRST', 'SECOND'], { FIRST: '', SECOND: fromEnv }).value, fromEnv);
});

test('both readers reconcile a real private file, report faults, and refuse malformed references before reading', async t => {
  const home = privateHome(t), root = credentialRoot(home);
  const written = await writeCredentialFile({ root, ref: entry.credentialRef, value: key });
  assert.ok(written.ok, written.detail);
  for (const resolve of adapters) {
    assert.deepEqual(await resolve(entry, options({ home })), { state: 'ok', source: 'file', value: key, detail: '' });
    assert.deepEqual(await resolve(entry, options({ home, env: { FIRST: key } })), { state: 'ok', source: 'env', value: key, detail: '' });
    noKey(await resolve(entry, options({ home, env: { FIRST: fromEnv } })), 'CREDENTIAL_CONFLICT');
    noKey(await resolve({ ...entry, credentialRef: 'missing.key' }, options({ home, env: { FIRST: fromEnv } })), 'CREDENTIAL_MISSING');
    noKey(await resolve({ ...entry, credentialRef: '../wrong.key' }, options({ home })), 'CREDENTIAL_INVALID');
    noKey(await resolve({ ...entry, credentialRef: 7 }, options({ home })), 'CREDENTIAL_INVALID');
    noKey(await resolve(entry, options({ home: 'relative' })), 'CREDENTIAL_INVALID');
  }
  assert.deepEqual(readStoredCredentialSync(entry.credentialRef, { home }), { state: 'ok', value: key, detail: '' });
  assert.deepEqual(readCredentialFileSync({ root, ref: entry.credentialRef }).identity.split(':').length, 4);
  assert.notEqual(credentialRefProblem(7), '');
  assert.equal(credentialRefProblem('service.key'), '');
  assert.equal(decodeCredential(Buffer.from(`${key}\n`)).value, key);
  noKey(decodeCredential(Buffer.from(`${key}\r\n`)), 'CREDENTIAL_INVALID');
});

test('a successful ACL observation opens only the checked file; failed stdout grants nothing', async t => {
  const home = privateHome(t), target = path.join(home, 'fixture.key');
  fs.writeFileSync(target, `${key}\n`, { mode: 0o600 });
  const owner = 'fixture-owner';
  const stdout = `${target} ${owner}:(F)`;
  const common = { target, platform: 'win32', owner };
  const pairs = [[inspectCredentialFile, async () => ({ stdout })], [inspectCredentialFileSync, () => stdout]];
  for (const [inspect, good] of pairs) {
    const known = await inspect({ ...common, run: good });
    assert.equal(known.state, 'ok', known.detail);
    assert.equal(known.value, key);
    let asked = 0;
    const failed = await inspect({ ...common, run: () => { asked++; throw Object.assign(Error('ACL query failed'), { stdout }); } });
    assert.equal(asked, 1);
    noKey(failed, 'CREDENTIAL_INSECURE');
    assert.match(failed.detail, /no access-control entries/);
  }
});

test('both readers refuse a different file opened under the inspected name', async t => {
  const owner = 'fixture-owner';
  const readers = [[inspectCredentialFile, fsp, 'open'], [inspectCredentialFileSync, fs, 'openSync']];
  for (const [inspect, collector, method] of readers) {
    const home = privateHome(t), target = path.join(home, 'checked.key'), next = path.join(home, 'replacement.key');
    fs.writeFileSync(target, `${key}\n`, { mode: 0o600 });
    fs.writeFileSync(next, `${fromEnv}\n`, { mode: 0o600 });
    let swaps = 0, aclCalls = 0;
    const original = collector[method];
    const open = t.mock.method(collector, method, (file, ...args) => {
      if (file === target) { fs.renameSync(next, target); swaps++; }
      return original(file, ...args);
    });
    try {
      const state = await inspect({ target, owner, platform: 'win32', run: () => {
        aclCalls++;
        const stdout = `${target} ${owner}:(F)`;
        return inspect === inspectCredentialFileSync ? stdout : { stdout };
      } });
      assert.equal(swaps, 1, 'the test actually replaced the inspected file before open');
      noKey(state, 'CREDENTIAL_INSECURE');
      assert.match(state.detail, /changed while opening/);
      assert.equal(aclCalls, 0, 'a mismatched file does not reach the ACL check');
    } finally { open.mock.restore(); }
    assert.equal(fs.readFileSync(target, 'utf8'), `${fromEnv}\n`);
  }
});

test('POSIX custody refuses owner-external modes, hard links and symlinks',
  { skip: process.platform === 'win32' && 'POSIX mode and symlink checks require a POSIX host' }, async t => {
    const home = privateHome(t), target = path.join(home, 'one'), hard = path.join(home, 'two'), soft = path.join(home, 'three');
    fs.writeFileSync(target, `${key}\n`, { mode: 0o600 });
    for (const inspect of [inspectCredentialFile, inspectCredentialFileSync]) {
      assert.equal((await inspect({ target })).value, key);
      fs.chmodSync(target, 0o644); noKey(await inspect({ target }), 'CREDENTIAL_INSECURE');
      fs.chmodSync(target, 0o600); fs.linkSync(target, hard);
      noKey(await inspect({ target }), 'CREDENTIAL_INSECURE');
      fs.unlinkSync(hard); fs.symlinkSync(target, soft);
      noKey(await inspect({ target: soft }), 'CREDENTIAL_INSECURE');
      fs.unlinkSync(soft);
    }
  });

test('the pure machine-id leaf and its old import produce the same observed tags', () => {
  const tag = process.platform === 'linux' && /microsoft|wsl/i.test(os.release()) ? 'wsl' : process.platform;
  assert.equal(machineIdFor({ platform: process.platform, hostname: 'Kernel-Fixture', isWsl: hostIsWsl() }), `${tag}:kernel-fixture`);
  const cases = [
    [{ platform: 'linux', hostname: 'DevBox', isWsl: true }, 'wsl:devbox'],
    [{ platform: 'win32', hostname: 'irrelevant', env: { COMPUTERNAME: 'WORK-PC' }, isWsl: true }, 'win32:work-pc'],
    [{ platform: 'linux', hostname: 'host', env: { AIFY_MACHINE_ID: '   ' } }, 'linux:unknown-host'],
    [{ platform: 'darwin', hostname: 'Fallback', env: { AIFY_MACHINE_ID: '', COMPUTERNAME: '' } }, 'darwin:fallback'],
  ];
  for (const [facts, expected] of cases) {
    assert.equal(machineIdFor(facts), expected);
    assert.equal(legacyMachineId(facts), expected);
  }
});
