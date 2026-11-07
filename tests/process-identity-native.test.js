// Read-only identity qualification on self and children this test owns. Cleanup closes their stdin; no killer is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { ProcessIdentityProbe } from '../lib/process-identity.mjs';
import { processState } from '../lib/definition-lock.mjs';

class OwnedChildren {
  children = [];
  constructor(t) { t.after(() => this.end()); }
  async start(title) {
    const source = "if(process.platform==='linux')process.title=process.argv[1];process.stdout.write('ready');process.stdin.resume();";
    const child = spawn(process.execPath, ['-e', source, title], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = new Promise(resolve => child.once('close', resolve));
    this.children.push({ child, closed });
    await once(child.stdout, 'data');
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    return child;
  }
  async end() {
    for (const { child } of this.children) child.stdin?.end();
    await Promise.all(this.children.map(({ closed }) => closed));
  }
}

test('native shared probe observes only self and twenty owned children, with one Windows batch',
  { skip: !['linux', 'win32'].includes(process.platform) && 'native identity exists only on Linux and Windows', timeout: 30000 }, async t => {
    const owner = new OwnedChildren(t), children = [];
    for (let index = 0; index < 20; index++) {
      const title = `${index} ${['shell', '(shell)', ') tail', 'line\nname', 'space name'][index % 5]}`;
      children.push(await owner.start(title));
    }
    const pids = [process.pid, ...children.map(child => child.pid)], owned = new Set(pids), calls = [];
    const observer = new ProcessIdentityProbe({
      run: (command, args, options, done) => {
        assert.equal(command, 'powershell.exe');
        const asked = [...args.at(-1).matchAll(/ProcessId=(\d+)/g)].map(match => Number(match[1]));
        assert.deepEqual(asked, pids, 'the native query may contain only this test process and its own children');
        calls.push([...asked]); execFile(command, args, options, done);
      },
      readFile: (file, encoding) => {
        if (file !== '/proc/sys/kernel/random/boot_id') {
          const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(file);
          assert.ok(match && owned.has(Number(match[1])), 'native read outside the test population');
        }
        return fs.readFileSync(file, encoding);
      },
      state: pid => { assert.ok(owned.has(pid)); return processState(pid); },
    });
    const answers = await observer.probe(pids);
    assert.equal(answers.size, pids.length);
    for (const pid of pids) {
      const answer = answers.get(pid);
      assert.equal(answer.alive, true, `own pid ${pid} is alive`);
      assert.equal(typeof answer.commandLine, 'string');
      assert.ok(answer.commandLine.length > 0);
      if (process.platform === 'linux') {
        assert.equal(answer.startToken.pid, pid);
        assert.match(answer.startToken.startTicks, /^[0-9]+$/);
      } else assert.ok(Number.isSafeInteger(answer.createdAtUs) && answer.createdAtUs > 0);
    }
    if (process.platform === 'win32') {
      assert.equal(calls.length, 1);
      for (const child of children) assert.equal(observer.captureChild(child), null, 'Windows launch adds no PowerShell query');
      assert.equal(calls.length, 1);
    } else {
      assert.deepEqual(calls, []);
      const again = await observer.probe(pids);
      for (const child of children) {
        assert.deepEqual(again.get(child.pid).startToken, answers.get(child.pid).startToken, 'raw identity is stable across reads');
        assert.deepEqual(observer.captureChild(child), answers.get(child.pid).startToken, 'the owning parent captures this same identity');
      }
      t.diagnostic(JSON.stringify({ specimenPopulation: 'twenty test-owned live children', childStats: children.map(child => fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8')) }));
    }
    t.diagnostic(JSON.stringify({ platform: process.platform, ownedChildren: children.length, answeredPids: answers.size, windowsQueries: calls.length }));
  });
