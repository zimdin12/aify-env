// Real CLI processes send real HTTP to an inert fixture transport; no aify-env daemon or harness is run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { authorityServer } from './fixtures/http-authority.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dnsFixture = fileURLToPath(new URL('./fixtures/http-authority-dns.cjs', import.meta.url));
function client(command, args, endpoint, home) {
  return new Promise((resolve, reject) => {
    const script = command === 'output' ? path.join(root, 'tests', 'fixtures', 'http-authority-output-client.mjs') : path.join(root, 'bin', `aify-env-${command}.mjs`);
    const child = spawn(process.execPath, ['--require', dnsFixture, script, ...(command === 'output' ? [endpoint] : args)], {
      env: { ...process.env, HOME: home, USERPROFILE: home, AIFY_ENV_ENDPOINT: endpoint,
        AIFY_SERVICE_REGISTRY: path.join(home, 'no-services.json'), AIFY_AGENT_DEFINITIONS_DIR: path.join(home, 'definitions'), AIFY_ENV_LOCAL_SOCKET: '0',
        AIFY_PROBE_TIMEOUT_MS: '1000', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`own fixture client timed out: ${command}`)); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

for (const command of ['tui', 'doctor', 'attach', 'run', 'agents', 'roots']) {
  for (const mode of ['default', 'untrusted-forwarder', 'trusted-forwarder']) {
    test(`real ${command} client: ${mode} sends its exact URL authority`, async t => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-client-'));
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      const trusted = mode === 'trusted-forwarder';
      const server = await authorityServer(t, trusted ? { http: { trustedAuthorities: ['forwarded.example'] } } : {}, { worker: true });
      const host = mode === 'default' ? `127.0.0.1:${server.port}` : `forwarded.example:${server.port}`;
      const endpoint = `http://${host}`;
      const launcher = path.join(home, 'fixture-launcher.sh');
      fs.writeFileSync(launcher, '#!/bin/sh\nHARNESS_WRAPPER_VERSION="1.0"\n', { mode: 0o700 });
      const args = { tui: ['--once'], doctor: ['--json'], attach: ['--id', 'p'], agents: ['import'], roots: ['list'],
        run: ['--service', 'fixture', '--launcher', launcher, '--label', 'fixture', '--'] }[command];
      const result = await client(command, args, endpoint, home);
      assert.ok(server.seen.requests.length, `client never reached the fixture: ${JSON.stringify(result)}`);
      assert.ok(server.seen.requests.every(request => request.host === host), 'client or fixture rewrote the HTTP authority');
      if (mode === 'untrusted-forwarder') {
        assert.ok(server.seen.requests.every(request => request.status === 403), JSON.stringify(server.seen.requests));
        assert.equal(server.seen.deps, 0, 'untrusted endpoint reached protocol dependencies');
      } else {
        if (command === 'attach' || command === 'run') {
          // A pipe must keep the real command's terminal refusal. Exercise its actual HTTP output consumer separately.
          assert.equal(result.code, 64, JSON.stringify(result));
          assert.match(result.stderr, /needs a terminal on both ends/);
          const output = await client('output', [], endpoint, home);
          assert.equal(output.code, 0, JSON.stringify(output));
          assert.equal(JSON.parse(output.stdout).status, 'exited');
          assert.equal(server.seen.streams, 1, 'the real console consumer lost its HTTP stream');
        } else assert.equal(result.code, 0, JSON.stringify(result));
        assert.ok(server.seen.requests.some(request => request.status === 200), JSON.stringify(server.seen.requests));
        assert.ok(server.seen.requests.every(request => request.status !== 403), JSON.stringify(server.seen.requests));
        assert.ok(server.seen.requests.every(request => request.host === host), 'console consumer changed authority');
        if (command === 'run') assert.ok(server.seen.requests.some(request => request.method === 'POST' && request.path === '/processes' && request.status === 201), 'run did not reach the existing start route');
      }
    });
  }
}
