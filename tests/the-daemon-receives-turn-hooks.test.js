// One transport witness for G3: actual daemon, probe and disk with a harmless Node process, never an agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ENTRY = path.resolve(import.meta.dirname, "../bin/aify-env.mjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-hook-daemon-"));
  const allowed = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|USERNAME|USERDOMAIN)$/i.test(key)));
  const env = { ...allowed, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, TMPDIR: root, AIFY_ADVERTISE: "0", AIFY_NO_DASHBOARD: "1",
    AIFY_SERVICE_REGISTRY: path.join(root, "absent-services.json"), AIFY_ENV_PROCESS_RECORD: path.join(root, "owned.json") };
  const home = path.join(root, ".aify");
  fs.mkdirSync(path.join(home, "residents"), { recursive: true });
  const closers = [];
  t.after(async () => { for (const stop of closers.reverse()) await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const child = (argv) => {
    const processChild = spawn(process.execPath, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const done = once(processChild, "exit");
    let output = "";
    processChild.stdout.on("data", (chunk) => output += chunk);
    processChild.stderr.on("data", (chunk) => output += chunk);
    const stop = async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill(); await done; };
    closers.push(stop);
    return { child: processChild, stop, get output() { return output; } };
  };
  return { root, home, child };
}
async function waitFor(d, pattern) {
  const ceiling = Date.now() + 30000;
  while (Date.now() < ceiling) {
    const match = pattern.exec(d.output);
    if (match) return match;
    assert.equal(d.child.exitCode, null, d.output);
    assert.equal(d.child.signalCode, null, d.output);
    await pause(20);
  }
  throw new Error(`test child did not produce its marker: ${d.output}`);
}

test("the daemon delivers hooks to its real state host and a restart retains the durable ordering", {
  skip: process.platform !== "win32", timeout: 90000,
}, async (t) => {
  const b = box(t);
  const quietFile = path.join(b.root, "harmless.cjs");
  fs.writeFileSync(quietFile, "process.stdout.write('FIXTURE_ALIVE\\n'); setInterval(() => {}, 1000);\n");
  const quiet = b.child([quietFile]);
  await waitFor(quiet, /FIXTURE_ALIVE/);
  await pause(20); // writtenAtUs must follow the real process creation microseconds, not its rounded millisecond.
  const lifetime = randomUUID();
  const r = { agentId: "fixture", lifetime, instance: "default", harness: "hermes", pid: quiet.child.pid,
    launcher: process.execPath, writtenAtUs: Date.now() * 1000 };
  fs.writeFileSync(path.join(b.home, "residents", `fixture.${lifetime}.json`), JSON.stringify(r));
  const first = b.child([ENTRY, "--port", "0"]);
  const url = (await waitFor(first, /listening on (http:\/\/127\.0\.0\.1:\d+)/))[1];
  const turns = path.join(b.home, "env", "default.turns.json");
  assert.equal(fs.existsSync(turns), false);
  const post = async (endpoint, body, headers = {}) => {
    const response = await fetch(`${endpoint}/agents/fixture/turn-event`, { method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const startedAtUs = Date.now() * 1000;
  const event = { instance: "default", lifetime, kind: "turn-start", firedAtUs: startedAtUs };
  const applied = await post(url, event);
  assert.equal(applied.status, 200, "the actual daemon did not deliver a current hook to its host");
  assert.equal(applied.body.applied, true);
  assert.equal(applied.body.reason, "current:first");
  const read = () => JSON.parse(fs.readFileSync(turns, "utf8"));
  assert.deepEqual(read()[lifetime], { open: true, startedAtUs, awaitingInput: false, lastEventAtUs: startedAtUs });
  const before = fs.readFileSync(turns, "utf8");
  // Malformed JSON and wrong state identity cannot produce a turn write.
  assert.equal((await post(url, "{")).status, 400);
  const wrong = await post(url, { ...event, instance: "not-default", firedAtUs: startedAtUs + 1 });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.reason, "wrong-instance");
  // A browser-shaped loopback request inherits the transport's refusal even when its event is otherwise valid.
  assert.equal((await post(url, { ...event, kind: "turn-end", firedAtUs: startedAtUs + 2 }, { origin: "https://fixture.invalid" })).status, 403);
  assert.equal(fs.readFileSync(turns, "utf8"), before);
  await first.stop();
  const second = b.child([ENTRY, "--port", "0"]);
  const nextUrl = (await waitFor(second, /listening on (http:\/\/127\.0\.0\.1:\d+)/))[1];
  assert.equal(fs.readFileSync(turns, "utf8"), before, "reboot discarded the verified lifetime's stored turn");
  const ended = await post(nextUrl, { ...event, kind: "turn-end" });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.reason, "current:end-wins-tie");
  assert.equal(read()[lifetime].open, false);
  const closed = fs.readFileSync(turns, "utf8");
  const delayed = await post(nextUrl, { ...event, firedAtUs: startedAtUs - 1 });
  assert.equal(delayed.status, 409);
  assert.equal(delayed.body.reason, "out-of-order");
  assert.equal(fs.readFileSync(turns, "utf8"), closed);
  assert.match(second.output, /agent turn event refused: out-of-order/);
  await quiet.stop();
  const exited = await post(nextUrl, { ...event, firedAtUs: startedAtUs + 3 });
  assert.equal(exited.status, 409);
  assert.equal(exited.body.reason, "not-current");
  assert.equal(fs.readFileSync(turns, "utf8"), closed, "a refused late hook changed the durable turn");
  assert.equal(fs.existsSync(path.join(b.home, "residents", `fixture.${lifetime}.json`)), false);
});
