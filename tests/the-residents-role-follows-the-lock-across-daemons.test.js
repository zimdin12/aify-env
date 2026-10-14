// B1 end to end, with REAL daemons in a private home: an ordinary and two dedicated aify-envs contend for the residents
// role, exactly one holds it, and the joins line up: the launcher's `residents` record -> `residents.json` -> /health ->
// turn-event admission -> a publication under the home's residents key. Then the holder crashes, exactly one other
// takes the role on its next sweep with a higher generation, restores the open turn busy, and keeps its watermark.
// A harmless Node process stands in for the resident; the publications go to a local sink, never to a service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { instanceFixture } from "./helpers/instance-fixture.mjs";

const ENTRY = path.resolve(import.meta.dirname, "../bin/aify-env.mjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, check, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(25)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("one holder per home across an ordinary and two dedicated daemons; a crash hands the role over with its turn", {
  skip: process.platform !== "win32", timeout: 150000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-b1-daemons-"));
  const closers = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, ".aify");
  fs.mkdirSync(path.join(home, "residents"), { recursive: true });
  fs.mkdirSync(path.join(home, "env"));
  fs.writeFileSync(path.join(home, "env", "residents.generation"), "500\n");
  // A home with a generation has booted before, so its lifecycle journal exists (lib/daemon-agent-state.mjs).
  fs.writeFileSync(path.join(home, "agent-lifecycle.json"), JSON.stringify({ version: 1, records: {}, stops: {} }));

  const bodies = [];
  const sink = http.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => { bodies.push(JSON.parse(text)); response.writeHead(204); response.end(); });
  });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => sink.close(resolve)));
  const registry = JSON.stringify({ version: 1, services: { sink: { endpoint: `http://127.0.0.1:${sink.address().port}/`,
    agentState: { path: "/agent-state" } } } });
  fs.writeFileSync(path.join(root, "services.json"), registry);

  const allowed = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|USERNAME|USERDOMAIN)$/i.test(key)));
  const env = { ...allowed, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root,
    AIFY_ADVERTISE: "0", AIFY_NO_DASHBOARD: "1", AIFY_SWEEP_MS: "300", AIFY_MACHINE_ID: "b1-fixture",
    AIFY_SERVICE_REGISTRY: path.join(root, "services.json"), AIFY_ENV_PROCESS_RECORD: path.join(root, "owned.json") };
  const child = (argv) => {
    const processChild = spawn(process.execPath, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(processChild, "exit");
    let output = "";
    processChild.stdout.on("data", (chunk) => { output += chunk; });
    processChild.stderr.on("data", (chunk) => { output += chunk; });
    const kill = async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); await exited; };
    closers.push(kill);
    return { child: processChild, kill, get output() { return output; } };
  };
  const ready = async (d) => (await until(`a daemon's readiness: ${d.output}`, () => {
    assert.equal(d.child.exitCode, null, d.output);
    return /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(d.output);
  }))[1];
  const health = async (url) => (await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) })).json()).residents;
  const post = async (url, body) => {
    const response = await fetch(`${url}/agents/fixture/turn-event`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };

  // The resident: a harmless process, and the record its launcher would write, stamped with the role's name.
  const quiet = child(["-e", "process.stdout.write('ALIVE\\n'); setInterval(() => {}, 1000)"]);
  await until("the stand-in resident", () => quiet.output.includes("ALIVE"));
  await pause(20);
  const lifetime = randomUUID();
  fs.writeFileSync(path.join(home, "residents", `fixture.${lifetime}.json`), JSON.stringify({ agentId: "fixture", lifetime,
    instance: "residents", harness: "hermes", pid: quiet.child.pid, launcher: process.execPath, writtenAtUs: Date.now() * 1000 }));

  const ordinary = child([ENTRY, "--port", "0"]);
  const ordinaryUrl = await ready(ordinary);
  // Two dedicated contenders, each with the owner it must be authorised by.
  const startDedicated = async () => {
    const f = instanceFixture(root);
    fs.writeFileSync(f.context.serviceRegistry, registry);
    const owner = net.createServer((socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) socket.end(JSON.stringify({ ...JSON.parse(text.split("\n")[0]), accepted: true }) + "\n");
      });
    });
    await new Promise((resolve) => owner.listen(f.context.ownerEndpoint, resolve));
    closers.push(() => new Promise((resolve) => owner.close(resolve)));
    const d = child([ENTRY, "--instance-context", f.file]);
    return { scope: f.context.scope, url: await ready(d) };
  };
  const dedicated = [await startDedicated(), await startDedicated()];

  const first = await health(ordinaryUrl);
  assert.equal(first.held, true, JSON.stringify(first));
  assert.equal(first.generation, 501);
  assert.match(first.publisherInstance, /^residents-[0-9a-f]{12}$/);
  for (const d of dedicated) {
    assert.deepEqual(await health(d.url), { ...first, held: false, state: "not-held", reason: "held-elsewhere", generation: null },
      "a dedicated contender must not hold, and reports why");
  }
  const [{ url: dedicatedUrl }] = dedicated;

  // The join: the hook reads residents.json and posts there; only the holder admits it.
  const pointer = JSON.parse(fs.readFileSync(path.join(home, "env", "residents.json"), "utf8"));
  assert.deepEqual([pointer.url, pointer.instance], [ordinaryUrl, "residents"]);
  const t2 = Date.now() * 1000;
  const start = { instance: "residents", lifetime, kind: "turn-start", firedAtUs: t2 };
  assert.deepEqual((await post(pointer.url, start)).body.reason, "current:first");
  const stale = await post(dedicatedUrl, { ...start, firedAtUs: t2 + 1 });
  assert.deepEqual([stale.status, stale.body.reason], [409, "not-owner"], "a stale descriptor's target refused the event");

  // Publications: the residents under the home's key alone, each daemon's own managed key beside it.
  const residentsBody = (generation, busy) => bodies.find((b) => b.instance === first.publisherInstance && b.generation === generation
    && b.agents?.some((row) => row.agentId === "fixture" && row.busy === busy && row.lifetime === lifetime));
  const published = await until("the holder's residents publication", () => residentsBody(501, true));
  assert.equal(published.machineId, `${process.platform}:b1-fixture`, "the machine id is the advertised one; the key adds the home");
  await until("every managed key", () => ["default", ...dedicated.map((d) => d.scope)].every((key) => bodies.some((b) => b.instance === key)));
  for (const body of bodies.filter((b) => b.instance !== first.publisherInstance)) {
    assert.equal((body.agents ?? []).some((row) => row.agentId === "fixture"), false, `${body.instance} listed a resident`);
  }

  // The holder crashes. Exactly one dedicated daemon takes the role on a sweep, above, with the saved turn still open.
  await ordinary.kill();
  const holders = await until("the successor's role", async () => {
    const roles = await Promise.all(dedicated.map(async (d) => ({ ...d, role: await health(d.url) })));
    return roles.some((r) => r.role.held) && roles;
  });
  await pause(1000); // three more sweeps: the other contender must still be refused
  const settled = await Promise.all(dedicated.map(async (d) => ({ ...d, role: await health(d.url) })));
  assert.equal(settled.filter((r) => r.role.held).length, 1, JSON.stringify(settled));
  assert.equal(settled.find((r) => !r.role.held).role.reason, "held-elsewhere");
  const successor = settled.find((r) => r.role.held);
  assert.equal(holders.find((r) => r.role.held).url, successor.url, "the role moved between dedicated daemons");
  const taken = successor.role;
  assert.equal(taken.generation, 502);
  assert.equal(taken.publisherInstance, first.publisherInstance, "the key is stable across holders");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "env", "residents.json"), "utf8")).url, successor.url);
  await until("the successor's residents publication, busy", () => residentsBody(502, true));
  const older = await post(successor.url, { ...start, kind: "turn-end", firedAtUs: t2 - 1 });
  assert.deepEqual([older.status, older.body.reason], [409, "out-of-order"], "the restored watermark was lost");
  const turns = () => JSON.parse(fs.readFileSync(path.join(home, "env", "residents.turns.json"), "utf8"))[lifetime];
  assert.deepEqual(turns(), { open: true, startedAtUs: t2, awaitingInput: false, lastEventAtUs: t2 });
  const loser = settled.find((r) => !r.role.held);
  assert.equal((await post(loser.url, { ...start, kind: "turn-end", firedAtUs: t2 + 1 })).body.reason, "not-owner");
  const later = await post(successor.url, { ...start, kind: "turn-end", firedAtUs: t2 + 2 });
  assert.equal(later.status, 200);
  assert.equal(turns().open, false);
});
