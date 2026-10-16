// B1 contract items 3-5 and 8, with REAL processes contending for the real OS lock of a temp home: a Windows named
// pipe or a Linux abstract socket, named from that temp home's identity, so the real home's role is never touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { homeIdentity, roleEndpoint } from "../lib/residents-home.mjs";
import { ResidentsRole, notOwnerError } from "../lib/residents-role.mjs";

const HOLDER = path.resolve(import.meta.dirname, "helpers", "residents-holder.mjs");
const qualified = process.platform === "win32" || process.platform === "linux";
const SKIP = qualified ? false : `the residents lock is not qualified on ${process.platform}`;

function home(t, generation = "100\n") {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-res-lock-")), ".aify");
  fs.mkdirSync(path.join(dir, "env"), { recursive: true });
  if (generation !== null) fs.writeFileSync(path.join(dir, "env", "residents.generation"), generation);
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}
function holder(t, aifyHome, ...args) {
  const child = spawn(process.execPath, [HOLDER, aifyHome, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; };
  t.after(kill);
  const line = async (index = 0) => {
    for (const end = Date.now() + 20000; Date.now() < end;) {
      const lines = out.split("\n").filter(Boolean);
      if (lines.length > index) return JSON.parse(lines[index]);
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`holder said nothing: ${out} ${err}`);
  };
  return { child, line, kill };
}
const generation = (dir) => fs.readFileSync(path.join(dir, "env", "residents.generation"), "utf8");

test("contenders for one home: exactly one holder, the rest refused held-elsewhere", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const contenders = Array.from({ length: 5 }, () => holder(t, dir, "role"));
  const answers = await Promise.all(contenders.map((c) => c.line()));
  assert.equal(answers.filter((a) => a.held).length, 1, JSON.stringify(answers));
  assert.deepEqual(answers.filter((a) => !a.held).map((a) => a.reason), Array(4).fill("held-elsewhere"));
  assert.equal(answers.find((a) => a.held).generation, 101);
  assert.equal(generation(dir), "101\n", "a refused contender wrote a generation");
  // This process is a contender too, and the lock refuses it while the holder lives.
  const mine = new ResidentsRole({ aifyHome: dir });
  assert.deepEqual(await mine.acquire(), { held: false, reason: "held-elsewhere" });
  assert.equal(mine.enter(), null, "no role, no admission");
});

test("two different homes: two holders, both succeed", { skip: SKIP }, async (t) => {
  const [a, b] = [holder(t, home(t), "role"), holder(t, home(t), "role")];
  assert.deepEqual([(await a.line()).held, (await b.line()).held], [true, true]);
});

test("a crashed holder releases: the successor binds and its generation is above", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const first = holder(t, dir, "role");
  assert.deepEqual(await first.line(), { held: true, reason: "", generation: 101 });
  const waiting = new ResidentsRole({ aifyHome: dir });
  assert.equal((await waiting.acquire()).held, false);
  await first.kill();
  t.after(() => waiting.release({ waitMs: 0 }));
  assert.deepEqual(await waiting.acquire(), { held: true, reason: "" });
  assert.equal(waiting.generation, 102);
  const third = holder(t, dir, "role");
  assert.equal((await third.line()).reason, "held-elsewhere");
});

test("a paused holder still holds: no successor meanwhile, and it holds on resuming", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const paused = holder(t, dir, "role", "1500");
  assert.equal((await paused.line()).held, true);
  // The holder's event loop is now blocked: it answers nothing, and the kernel still holds its endpoint.
  const during = new ResidentsRole({ aifyHome: dir });
  assert.deepEqual(await during.acquire(), { held: false, reason: "held-elsewhere" });
  assert.deepEqual(await paused.line(1), { resumed: true, holds: true });
  assert.equal(generation(dir), "101\n");
});

test("a generation that cannot be read is no role, and the endpoint is given back", { skip: SKIP }, async (t) => {
  const dir = home(t, null);
  fs.mkdirSync(path.join(dir, "env", "residents.generation"));
  const role = new ResidentsRole({ aifyHome: dir });
  const taken = await role.acquire();
  assert.equal(taken.held, false);
  assert.match(taken.reason, /^generation-unreadable: /);
  assert.equal(role.report().reason, taken.reason, "reported");
  // Given back: another process can bind the endpoint now.
  const endpoint = roleEndpoint(homeIdentity(dir, { platform: process.platform, realpath: fs.realpathSync.native }).identity, process.platform);
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  await new Promise((resolve) => server.close(resolve));
});

test("a missing generation beside residents state is no role, reported; a fresh home initialises", { skip: SKIP }, async (t) => {
  const uncertain = home(t, null);
  fs.writeFileSync(path.join(uncertain, "env", "residents.turns.json"), "{}");
  const refused = new ResidentsRole({ aifyHome: uncertain });
  assert.match((await refused.acquire()).reason, /^generation-missing-with-residents-state: residents\.turns\.json/);
  const fresh = new ResidentsRole({ aifyHome: home(t, null), nowMs: () => 1_790_000_000_000 });
  t.after(() => fresh.release({ waitMs: 0 }));
  assert.deepEqual(await fresh.acquire(), { held: true, reason: "" });
  assert.equal(fresh.generation, 1_790_000_000_000);
});

test("a home on a cross-OS mount and an unqualified platform are no role, reported, and bind nothing", async (t) => {
  let bound = 0;
  const listen = async () => { bound += 1; throw new Error("must not bind"); };
  const wsl = new ResidentsRole({ aifyHome: home(t), platform: "win32", realpath: () => "\\\\wsl.localhost\\Ubuntu\\home\\me\\.aify", listen });
  assert.match((await wsl.acquire()).reason, /^cross-os-home/);
  const drvfs = new ResidentsRole({ aifyHome: home(t), platform: "linux", realpath: () => "/mnt/c/Users/me/.aify", listen });
  assert.match((await drvfs.acquire()).reason, /^cross-os-home/);
  const mac = new ResidentsRole({ aifyHome: home(t), platform: "darwin", realpath: (p) => p, listen });
  assert.equal((await mac.acquire()).reason, "unsupported-platform: darwin");
  assert.equal(bound, 0);
  for (const role of [wsl, drvfs, mac]) assert.equal(role.report().held, false);
});

test("any failed bind is no role, EACCES included", async (t) => {
  const role = new ResidentsRole({ aifyHome: home(t), listen: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  assert.deepEqual(await role.acquire(), { held: false, reason: "bind-failed: EACCES" });
  assert.equal(role.enter(), null);
});

test("ORDERED RELEASE: stop admitting, wait bounded, close the endpoint even on timeout; a late operation cannot apply", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const role = new ResidentsRole({ aifyHome: dir });
  t.after(() => role.release({ waitMs: 0 }));
  assert.equal((await role.acquire()).held, true);
  // THE CONTENDER IS STARTED AND LOADED BEFORE THE RELEASE, and binds on a cue sent inside the wait. A contender
  // spawned after the release began could reach its bind only after the endpoint closed, and then correctly take the
  // role (review of 462022e). `settled` proves the bind's answer came back while the wait still held the endpoint.
  const during = holder(t, dir, "role-on-cue");
  assert.deepEqual(await during.line(0), { ready: true });
  const slow = role.enter();
  assert.equal(slow.live(), true);
  const started = Date.now();
  let settled = false;
  const releasing = role.release({ waitMs: 1000 }).then((outcome) => { settled = true; return outcome; });
  assert.equal(role.enter(), null, "admission stops at once: not-owner");
  assert.equal(role.holds(), false);
  during.child.stdin.write("bind\n");
  assert.deepEqual(await during.line(1), { attempting: true });
  const answer = await during.line(2);
  assert.equal(settled, false, "the contender's bind was not inside the release's wait, so it proves nothing about it");
  // A contender during the wait is still refused: the endpoint is held until the wait ends.
  assert.equal(answer.reason, "held-elsewhere");
  const outcome = await releasing;
  assert.deepEqual(outcome, { timedOut: true, abandoned: 1 });
  assert.ok(Date.now() - started >= 980, "the wait was bounded, not skipped");
  // The late operation completes now: asked at its effect, it is refused.
  assert.equal(slow.live(), false);
  assert.throws(() => slow.guard(), { code: notOwnerError().code, message: notOwnerError().message });
  assert.equal(notOwnerError().code, "NOT_OWNER", "the code the hook route maps to not-owner");
  slow.done();
  // And the endpoint is closed: the successor binds, with a higher generation.
  const successor = holder(t, dir, "role");
  assert.deepEqual(await successor.line(), { held: true, reason: "", generation: 102 });
});

test("ordered release that does not time out: entered operations finish first, then the endpoint closes", { skip: SKIP }, async (t) => {
  const role = new ResidentsRole({ aifyHome: home(t) });
  t.after(() => role.release({ waitMs: 0 }));
  await role.acquire();
  const op = role.enter();
  const order = [];
  const releasing = role.release({ waitMs: 5000 }).then((outcome) => { order.push("closed"); return outcome; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  order.push("op-done");
  op.done();
  assert.deepEqual(await releasing, { timedOut: false, abandoned: 0 });
  assert.deepEqual(order, ["op-done", "closed"]);
});
