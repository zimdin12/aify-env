// Actual daemon wiring, in private homes with no agent or service credentials.
// bootDaemonAgentState is exercised through the real daemon entrypoint, not called in a substitute fixture.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { instanceFixture } from "./helpers/instance-fixture.mjs";

const ENTRY = path.resolve(import.meta.dirname, "../bin/aify-env.mjs");
const RUNNER = path.resolve(import.meta.dirname, "run-in-a-temp-root.mjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-state-boot-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|USERNAME|USERDOMAIN)$/i.test(key)));
  const env = { ...clean, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, TMPDIR: root, AIFY_ADVERTISE: "0", AIFY_NO_DASHBOARD: "1",
    AIFY_SERVICE_REGISTRY: path.join(root, "absent-services.json"), AIFY_ENV_PROCESS_RECORD: path.join(root, "owned.json") };
  const home = path.join(root, ".aify");
  const state = path.join(home, "env");
  fs.mkdirSync(state, { recursive: true });
  const close = [];
  t.after(async () => { for (const stop of close.reverse()) await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, home, state, env, close };
}
function daemon(t, b, args = ["--port", "0"]) {
  const child = spawn(process.execPath, [ENTRY, ...args], { cwd: b.root, env: b.env, stdio: ["ignore", "pipe", "pipe"] });
  const done = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done;
  };
  b.close.push(stop);
  return { child, done, stop, get output() { return output; } };
}
async function outcome(d) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const ready = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(d.output);
    if (ready) return { ready: true, url: ready[1] };
    if (d.child.exitCode !== null || d.child.signalCode !== null) return { ready: false };
    await pause(20);
  }
  throw new Error(`no startup outcome: ${d.output}`);
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function descriptor(b, instance = "default") { return path.join(b.state, `${instance}.json`); }
function generation(b, instance = "default") { return path.join(b.state, `${instance}.generation`); }
async function health(url) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}

test("readiness has a bound descriptor and a saved generation, and a restart keeps the state name", async (t) => {
  const b = box(t);
  const saved = Date.now() + 60000;
  fs.writeFileSync(generation(b), `${saved}\n`);
  const a = daemon(t, b);
  const first = await outcome(a);
  assert.equal(first.ready, true, a.output);
  assert.ok(fs.existsSync(descriptor(b)), "the daemon announced readiness without its descriptor");
  assert.equal(Number(fs.readFileSync(generation(b))), saved + 1);
  const pointer = read(descriptor(b));
  assert.deepEqual({ url: pointer.url, instance: pointer.instance, pid: pointer.pid },
    { url: first.url, instance: "default", pid: a.child.pid });
  assert.ok(Number.isFinite(Date.parse(pointer.startedAt)));
  const firstHealth = await health(first.url);
  assert.notEqual(firstHealth.instance, pointer.instance, "the boot UUID must not become the durable state name");
  const beforeExit = fs.readFileSync(descriptor(b), "utf8");
  await a.stop();
  assert.equal(fs.readFileSync(descriptor(b), "utf8"), beforeExit, "shutdown must leave the writer-only descriptor");
  const c = daemon(t, b);
  const second = await outcome(c);
  assert.equal(second.ready, true, c.output);
  assert.equal(Number(fs.readFileSync(generation(b))), saved + 2);
  assert.equal(read(descriptor(b)).url, second.url);
  assert.equal(read(descriptor(b)).pid, c.child.pid);
  assert.equal(read(descriptor(b)).instance, "default");
  assert.notEqual((await health(second.url)).instance, firstHealth.instance);
});

test("the actual Windows boot probes an ended resident and removes its stored turn", { skip: process.platform !== "win32" }, async (t) => {
  const b = box(t);
  // A short, harmless Node process, not an agent. Its PID is observed only after its exit.
  const ended = spawnSync(process.execPath, ["-e", ""], { env: b.env });
  assert.equal(ended.status, 0);
  assert.ok(ended.pid > 0);
  const lifetime = randomUUID();
  const file = `fixture.${lifetime}.json`;
  const residents = path.join(b.home, "residents");
  fs.mkdirSync(residents);
  const record = { agentId: "fixture", lifetime, instance: "default", harness: "hermes",
    pid: ended.pid, launcher: process.execPath, writtenAtUs: Date.now() * 1000 };
  fs.writeFileSync(path.join(residents, file), JSON.stringify(record));
  const turns = path.join(b.state, "default.turns.json");
  fs.writeFileSync(turns, JSON.stringify({ [lifetime]: { open: true, startedAtUs: record.writtenAtUs,
    awaitingInput: false, lastEventAtUs: record.writtenAtUs } }));
  const d = daemon(t, b);
  assert.equal((await outcome(d)).ready, true, d.output);
  assert.equal(fs.existsSync(path.join(residents, file)), false, "the real daemon never booted its state host/probe");
  assert.deepEqual(read(turns), {}, "the real daemon never restored the ended turn");
});

for (const broken of ["generation", "descriptor"]) {
  test(`an unwritable ${broken} refuses startup before readiness`, async (t) => {
    const b = box(t);
    const target = broken === "generation" ? generation(b) : descriptor(b);
    fs.mkdirSync(target);
    const oldDescriptor = broken === "generation" ? '{"predecessor":"unchanged"}\n' : null;
    if (oldDescriptor) fs.writeFileSync(descriptor(b), oldDescriptor);
    const d = daemon(t, b);
    assert.equal((await outcome(d)).ready, false, `${broken} failure was ignored: ${d.output}`);
    assert.notEqual(d.child.exitCode, 0);
    assert.match(d.output, /agent state boot failed/);
    if (oldDescriptor) assert.equal(fs.readFileSync(descriptor(b), "utf8"), oldDescriptor);
    assert.equal(fs.statSync(target).isDirectory(), true);
  });
}

test("a refused port bind cannot touch the predecessor's state files", async (t) => {
  const b = box(t);
  fs.writeFileSync(descriptor(b), '{"predecessor":"kept"}\n');
  fs.writeFileSync(generation(b), "9100\n");
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{"not":"aify-env"}'); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  b.close.push(() => new Promise((resolve) => server.close(resolve)));
  const before = [fs.readFileSync(descriptor(b), "utf8"), fs.readFileSync(generation(b), "utf8")];
  const d = daemon(t, b, ["--port", String(server.address().port)]);
  assert.equal((await outcome(d)).ready, false, d.output);
  assert.equal(d.child.exitCode, 69);
  assert.deepEqual([fs.readFileSync(descriptor(b), "utf8"), fs.readFileSync(generation(b), "utf8")], before);
  assert.equal(server.listening, true);
});

test("a dedicated daemon uses its validated scope for state before publishing ready", async (t) => {
  const b = box(t);
  const f = instanceFixture(b.root);
  const sockets = new Set();
  const owner = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.split("\n")[0]);
      socket.end(JSON.stringify({ ...request, accepted: true }) + "\n");
    });
  });
  await new Promise((resolve) => owner.listen(f.context.ownerEndpoint, resolve));
  b.close.push(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => owner.close(resolve)); });
  const d = daemon(t, b, ["--instance-context", f.file]);
  assert.equal((await outcome(d)).ready, true, d.output);
  const ready = read(f.context.readinessEndpoint);
  assert.ok(fs.existsSync(descriptor(b, f.context.scope)), "dedicated boot has no scope descriptor");
  const pointer = read(descriptor(b, f.context.scope));
  assert.equal(pointer.instance, f.context.scope);
  assert.equal(pointer.url, ready.endpoint);
  assert.equal(pointer.pid, d.child.pid);
  assert.ok(Number(fs.readFileSync(generation(b, f.context.scope))) > 0);
  assert.notEqual(ready.envInstance, pointer.instance);
  assert.equal(fs.existsSync(descriptor(b)), false);
  assert.equal(fs.existsSync(generation(b)), false);
});

test("the standard suite runner gives tests a private home before daemon state can write", (t) => {
  const b = box(t);
  const tests = path.join(b.root, "tests");
  fs.mkdirSync(tests);
  fs.writeFileSync(path.join(tests, "fixture.test.js"), `
    const assert = require('node:assert/strict');
    const os = require('node:os');
    const path = require('node:path');
    assert.notEqual(os.homedir(), process.env.ORIGINAL_TEST_HOME, 'suite runner inherited the caller home');
    assert.equal(os.homedir(), path.join(os.tmpdir(), 'home'));
  `);
  const result = spawnSync(process.execPath, [RUNNER], { cwd: b.root,
    env: { ...b.env, ORIGINAL_TEST_HOME: b.root }, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
