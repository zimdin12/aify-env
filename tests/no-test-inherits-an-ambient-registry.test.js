// A shell that set AIFY_SERVICE_REGISTRY must not hand it to the suite (review of B1, 2026-10-17). A private HOME does
// not fence an absolute registry, and advertising off is not plugin startup off, so a test daemon that inherited one
// started its plugins against the services it named. The runner and the sealed daemon env each choose a registry in
// the test temp root instead. The sentinel is a real registry naming a fake service OUTSIDE that root, so a daemon that
// read it is seen: the fake service is contacted. The controls point a daemon at it explicitly and see that contact.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";

const RUNNER = path.resolve(import.meta.dirname, "run-in-a-temp-root.mjs");
const SEALED = pathToFileURL(path.resolve(import.meta.dirname, "_sealed-daemon-env.mjs")).href;
const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "aify-env.mjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fold = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (file, dir) => fold(file).startsWith(fold(dir) + path.sep);

/** A registry naming a fake service, beside the test temp root rather than in it, removed afterwards. */
async function sentinel(t) {
  const received = [];
  const server = createServer((request, response) => {
    received.push(request.url);
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(path.dirname(os.tmpdir()), `aify-registry-sentinel-${randomUUID()}.json`);
  // The entry names its own heartbeat route: a service with no route and no plugin is sent nothing.
  const text = JSON.stringify({ version: 1, services: { sentinel: { endpoint: `http://127.0.0.1:${server.address().port}`,
    advertisement: { path: "/heartbeat" } } } });
  fs.writeFileSync(file, text);
  t.after(async () => { fs.rmSync(file, { force: true }); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  assert.equal(inside(file, os.tmpdir()), false, "the sentinel must sit outside the test temp root");
  return { file, text, received };
}

test("the runner gives the suite a registry in its own temp root, whatever the starting shell set", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-runner-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(path.dirname(os.tmpdir()), `aify-registry-sentinel-${randomUUID()}.json`);
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests", "fixture.test.js"), `
    const assert = require('node:assert/strict');
    const os = require('node:os');
    const path = require('node:path');
    const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const registry = process.env.AIFY_SERVICE_REGISTRY;
    assert.notEqual(registry, process.env.SENTINEL_REGISTRY, 'the runner passed the shell registry through');
    assert.ok(registry && fold(registry).startsWith(fold(os.tmpdir()) + path.sep), 'not in the temp root: ' + registry);
    require('node:fs').writeFileSync(process.env.FIXTURE_RAN, registry);
  `);
  // NOT NODE_TEST_CONTEXT: inherited from this test's own runner, it makes the nested run skip every file and exit 0.
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_TEST_CONTEXT"));
  const ran = path.join(root, "fixture-ran.txt");
  const answer = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...ambient, AIFY_SERVICE_REGISTRY: outside, SENTINEL_REGISTRY: outside, FIXTURE_RAN: ran } });
  assert.equal(answer.status, 0, answer.stdout + answer.stderr);
  assert.ok(fs.existsSync(ran), `the fixture never ran, so this proves nothing: ${answer.stdout}${answer.stderr}`);
  assert.equal(fs.existsSync(outside), false, "the sentinel registry was created");
});

test("a daemon from the sealed env never reads an inherited registry; one given it explicitly does", async (t) => {
  const s = await sentinel(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aify-ambient-registry-"));
  // ONE cleanup, in order: every daemon has exited before its working directory is removed.
  const daemons = [];
  t.after(async () => {
    for (const d of daemons) { if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill(); await d.exited; }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const boot = async (env) => {
    const child = spawn(process.execPath, [DAEMON, "--port", "0"], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    daemons.push({ child, exited });
    for (const end = Date.now() + 30000; !/listening on http/.test(output); await pause(25)) {
      if (Date.now() > end || child.exitCode !== null) throw new Error(`no readiness: ${output}`);
    }
    return { child, exited, output: () => output };
  };
  const extra = (n) => ({ AIFY_ADVERTISE: "1", AIFY_ADVERTISE_MS: "250", AIFY_ENV_PROCESS_RECORD: path.join(scratch, `owned-${n}.json`) });

  // CONTROL FIRST: the explicit registry is read, and the fake service is contacted. This proves the probe can see it.
  const control = await boot(sealedDaemonEnv({ ...extra(1), AIFY_SERVICE_REGISTRY: s.file }));
  const started = Date.now();
  for (const end = started + 20000; !s.received.length && Date.now() < end;) await pause(25);
  assert.ok(s.received.length > 0, `control: a daemon given the registry explicitly never contacted it: ${control.output()}`);
  const latency = Date.now() - started;
  control.child.kill();
  await control.exited;
  s.received.length = 0;

  const before = process.env.AIFY_SERVICE_REGISTRY;
  process.env.AIFY_SERVICE_REGISTRY = s.file;
  let env;
  try { env = sealedDaemonEnv(extra(2)); } finally {
    if (before === undefined) delete process.env.AIFY_SERVICE_REGISTRY; else process.env.AIFY_SERVICE_REGISTRY = before;
  }
  // The daemon first: what it does is the claim, and the path checks after it say why.
  const sealed = await boot(env);
  await pause(Math.max(3000, latency * 3));
  assert.deepEqual(s.received, [], `a daemon from the sealed env read the inherited registry: ${sealed.output()}`);
  assert.notEqual(env.AIFY_SERVICE_REGISTRY, s.file, "the sealed env kept the inherited registry");
  assert.ok(inside(env.AIFY_SERVICE_REGISTRY, os.tmpdir()), `the sealed registry is outside the temp root: ${env.AIFY_SERVICE_REGISTRY}`);
  assert.equal(fs.readFileSync(s.file, "utf8"), s.text, "the sentinel registry was rewritten");
  assert.equal((await import(SEALED)).NO_REGISTRY, env.AIFY_SERVICE_REGISTRY);
});
