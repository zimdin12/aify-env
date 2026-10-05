// A listing timeout must not kill the attach pane beside a responding environment.
// The CLI arms replace only transport, never startup policy or target resolution.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = { pid: 4242, instance: 'fixture-env', processes: [], terminals: {} };
const LIST = [{ id: 'fixture-pane', label: 'fixture-only' }];

function cli(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'transport.mjs');
  fs.writeFileSync(preload, `
    let lists = 0, clock = 0;
    const requests = [];
    const mode = ${JSON.stringify(mode)};
    if (mode === 'unanswered') Date.now = () => clock;
    globalThis.fetch = async (url, options = {}) => {
      const address = new URL(url);
      if (address.origin !== 'http://127.0.0.1:1' || (options.method && options.method !== 'GET')) {
        throw new Error('fixture refuses another endpoint or a mutating request');
      }
      requests.push(address.pathname);
      if (address.pathname === '/health') {
        if (mode === 'unanswered') { clock += 2000; throw new TypeError('health unanswered'); }
        return Response.json(${JSON.stringify(HEALTH)});
      }
      if (address.pathname === '/processes') {
        lists += 1;
        if (mode === 'unanswered') { clock += 5000; throw new TypeError('listing unanswered'); }
        if (mode === 'transient' && lists === 1) throw new DOMException('listing timed out', 'TimeoutError');
        return Response.json({processes: ${JSON.stringify(LIST)}});
      }
      throw new Error('unexpected fixture route ' + address.pathname);
    };
    process.on('exit', code => process.stdout.write(JSON.stringify({code, lists, requests}) + '\\n'));
  `);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AIFY_|HERDR_|HERMES_|CLAUDE_|CODEX_|OPENCODE_)/i.test(key) || key === 'NODE_OPTIONS') delete env[key];
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP']) env[key] = root;
  env.AIFY_ENV_ENDPOINT = 'http://127.0.0.1:1';
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
    path.join(ROOT, 'bin/aify-env-attach.mjs'), '--id', 'fixture-pane'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(child.error);
  return { ...child, observed: JSON.parse(child.stdout.trim()) };
}

test('the healthy CLI reaches the terminal guard without retrying', t => {
  const result = cli(t, 'healthy');
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /needs a terminal on both ends/);
  assert.equal(result.observed.lists, 1);
});

test('the actual CLI retries one listing timeout before reaching the terminal guard', t => {
  const result = cli(t, 'transient');
  assert.equal(result.status, 64, result.stderr);
  assert.equal(result.observed.lists, 2);
  assert.match(result.stderr, /needs a terminal on both ends/);
  assert.doesNotMatch(result.stderr, /no environment answered|Start one with/);
});

test('an unanswered CLI stops at its deadline without advice to replace the environment', t => {
  const result = cli(t, 'unanswered');
  assert.equal(result.status, 69, result.stderr);
  assert.ok(result.observed.lists > 1, 'one unanswered request is not the deadline');
  assert.match(result.stderr, /could not read processes/);
  assert.doesNotMatch(result.stderr, /no environment answered|Start one with/);
});

async function startup() {
  return (await import('../lib/attach-startup.mjs')).waitForAttachProcesses;
}

test('each live health answer renews the deadline rather than capping total attach time', async () => {
  const wait = await startup();
  let clock = 0, lists = 0;
  const answer = await wait({ endpoint: 'http://127.0.0.1:1', unansweredMs: 15, retryMs: 1,
    now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async url => {
      if (url.endsWith('/health')) return Response.json(HEALTH);
      assert.ok(url.endsWith('/processes'));
      clock += 20;
      if (++lists < 8) throw new DOMException('slow listing', 'TimeoutError');
      return Response.json({ processes: LIST });
    },
  });
  assert.ok(clock > 15, 'the successful arm must exceed the unanswered deadline');
  assert.equal(lists, 8);
  assert.deepEqual(answer.processes, LIST);
  assert.deepEqual(answer.health, HEALTH);
});

test('generic health JSON does not turn an unanswered endpoint into an unlimited live wait', async () => {
  const wait = await startup();
  let clock = 0, lists = 0;
  await assert.rejects(wait({ endpoint: 'http://127.0.0.1:1', unansweredMs: 15, retryMs: 1,
    now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async url => {
      if (url.endsWith('/health')) return Response.json({ status: 'healthy' });
      clock += 10; lists += 1;
      throw new TypeError('listing unavailable');
    },
  }), /listing unavailable/);
  assert.equal(lists, 2);
});

test('a refused or malformed listing is not retried as a transient transport timeout', async () => {
  const wait = await startup();
  for (const response of [Response.json({}, { status: 403 }), Response.json({}), new Response('{')]) {
    let lists = 0;
    await assert.rejects(wait({ endpoint: 'http://127.0.0.1:1',
      fetchImpl: async url => {
        if (url.endsWith('/health')) return Response.json(HEALTH);
        lists += 1;
        return response;
      },
      sleep: async () => assert.fail('a refusal must not enter the retry delay'),
    }), /403|processes array|invalid JSON/);
    assert.equal(lists, 1);
  }
});

for (const errorName of ['TimeoutError', 'AbortError']) {
  test(`a ${errorName} reading the listing body retries instead of being called invalid JSON`, async () => {
    const wait = await startup();
    let lists = 0;
    const answer = await wait({ endpoint: 'http://127.0.0.1:1', retryMs: 0, sleep: async () => {},
      fetchImpl: async url => {
        if (url.endsWith('/health')) return Response.json(HEALTH);
        if (++lists === 1) {
          return new Response(new ReadableStream({
            start(controller) { controller.error(new DOMException('body timed out', errorName)); },
          }));
        }
        return Response.json({ processes: LIST });
      },
    });
    assert.equal(lists, 2);
    assert.deepEqual(answer.processes, LIST);
  });
}
