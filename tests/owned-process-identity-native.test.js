// Actual enrolled child -> Runner's default capture -> durable owned record -> shared observation. No real killer is called.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { Runner } from '../lib/runner.mjs';
import { readOwned } from '../lib/owned-processes.mjs';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { defaultVerify } from '../lib/orphan-reap.mjs';

test('a real enrolled piped child carries its owning capture through the record and verifies against the shared OS answer',
  { skip: !['linux', 'win32'].includes(process.platform) && 'native identity exists only on Linux and Windows', timeout: 30000 }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-native-identity-'));
    let child, closed;
    t.after(async () => {
      child?.stdin?.end();
      if (closed) await closed;
      fs.rmSync(home, { recursive: true, force: true });
    });
    const launcher = path.join(home, 'identity-worker.cjs'), ownedFile = path.join(home, 'owned.json');
    const fileText = '#!/usr/bin/env node\nHARNESS_WRAPPER_VERSION="1.0"\nprocess.stdin.resume();\n';
    fs.writeFileSync(launcher, fileText);
    const runner = new Runner({ ownedFile, openTerminal: null, loadCheckpoint: null,
      spawnProcess: (...args) => {
        child = spawn(...args);
        closed = new Promise(resolve => child.once('close', resolve));
        return child;
      }, killTree: async () => { throw Error('native identity qualification never calls a killer'); } });
    const handle = await runner.start({ service: 'fixture', command: process.execPath, args: [launcher], launcher,
      fileText, env: { HOME: home, USERPROFILE: home } });
    const [record] = readOwned(ownedFile);
    assert.equal(record.pid, child.pid); assert.equal(record.id, handle.id); assert.equal(record.launcher, launcher);
    const answer = (await new ProcessIdentityProbe().probe([child.pid])).get(child.pid);
    assert.equal(answer.alive, true);
    if (process.platform === 'linux') {
      assert.deepEqual(record.startToken, answer.startToken);
      assert.equal(record.startToken.pid, child.pid);
    } else assert.equal(Object.hasOwn(record, 'startToken'), false, 'Windows launch publication adds no Linux token/probe');
    const killed = [], injectedKill = pid => killed.push(pid);
    if (defaultVerify(record, { answer })) injectedKill(record.pid);
    assert.deepEqual(killed, [child.pid], 'only this test-owned child is an eligible synthetic recovery decision');
  });
