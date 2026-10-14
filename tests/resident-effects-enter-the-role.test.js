// B1 contract item 7 at the two effects other than a turn event: a resident lifecycle stop and the residents'
// publication each run inside an operation the role admitted and ask it again at the effect, so nothing is killed or
// published by a daemon that does not hold, or no longer holds, the role. Real locks of temp homes; the OS is faked.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStateSender } from "../lib/agent-state-sender.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { createAgentLifecyclePorts } from "../lib/daemon-agent-lifecycle.mjs";
import { DaemonResidents } from "../lib/daemon-residents.mjs";

const SKIP = process.platform === "win32" || process.platform === "linux" ? false : `not qualified on ${process.platform}`;
const L1 = "7f3c9e2a-0000-4000-8000-0000000000d1";
const WRITTEN = 1_790_950_000_000_000;
const witness = { agentId: "lead", lifetime: L1, instance: "residents", harness: "claude", pid: 4242,
  launcher: process.execPath, writtenAtUs: WRITTEN, createdAtUs: WRITTEN - 1 };
const alive = { alive: true, createdAtUs: WRITTEN - 1, commandLine: `node "${process.execPath}"` };

function home(t) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-res-effects-")), ".aify");
  fs.mkdirSync(path.join(dir, "env"), { recursive: true });
  fs.writeFileSync(path.join(dir, "env", "residents.generation"), "300\n");
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}
function residentsOf(t, dir) {
  const residents = new DaemonResidents({ aifyHome: dir, url: "http://127.0.0.1:1", pid: process.pid,
    probe: () => new Map(), nowUs: () => WRITTEN + 1_000_000 });
  t.after(() => residents.release({ waitMs: 0 }));
  return residents;
}
function ports(dir, residents, { probe, kills }) {
  return createAgentLifecyclePorts({ aifyHome: dir, machineId: "m", stateHost: { rawIdentity: () => ({ current: null, conflict: false, unknown: false }) },
    residents, runner: {}, definitions: {}, installed: async () => new Set(), probe, settleMs: 0,
    killTree: async (pid) => { kills.push(pid); } });
}

test("a resident stop needs the role: refused without it, and without any residents owner at all", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const kills = [];
  const probe = async () => new Map([[4242, alive]]);
  const notHeld = residentsOf(t, dir);
  assert.equal(await ports(dir, notHeld, { probe, kills }).stop(witness, "resident"), false);
  assert.equal(await ports(dir, null, { probe, kills }).stop(witness, "resident"), false, "no residents owner fails closed");
  assert.deepEqual(kills, []);
  const held = residentsOf(t, path.join(path.dirname(dir), "other", ".aify"));
  fs.mkdirSync(path.join(path.dirname(dir), "other", ".aify", "env"), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(dir), "other", ".aify", "env", "residents.generation"), "1\n");
  assert.equal(await held.acquire(), true);
  let calls = 0;
  const dies = async () => new Map([[4242, ++calls === 1 ? alive : { alive: false }]]);
  assert.equal(await ports(dir, held, { probe: dies, kills }).stop(witness, "resident"), true);
  assert.deepEqual(kills, [4242], "control: the holder does stop a verified resident");
});

test("a resident stop entered before the role's release, completing after it, kills nothing", { skip: SKIP }, async (t) => {
  const dir = home(t);
  const residents = residentsOf(t, dir);
  assert.equal(await residents.acquire(), true);
  const kills = [];
  let answer;
  const verified = new Promise((resolve) => { answer = resolve; });
  const slowProbe = async () => { await verified; return new Map([[4242, alive]]); };
  const stopping = ports(dir, residents, { probe: slowProbe, kills }).stop(witness, "resident");
  const outcome = await residents.release({ waitMs: 50 });
  assert.equal(outcome.timedOut, true, "the stop was still entered when the wait ran out");
  answer();
  assert.equal(await stopping, false);
  assert.deepEqual(kills, [], "a late resident stop killed after the role was released");
});

function sender(dir, { admit, posts }) {
  return new AgentStateSender({ identity: { machineId: "m", instance: "residents-000000000000", generation: 9 },
    stateHost: { readAll: () => ({ agents: [], complete: true, problems: [] }) },
    definitions: new DefinitionStore({ dir: path.join(dir, "defs") }), observedHarnesses: async () => new Set(),
    lifecycle: { stopFacts: async () => new Map() }, admit, report: (line) => posts.push(`notice ${line}`),
    readRegistry: () => JSON.stringify({ services: { s: { endpoint: "http://fixture.invalid/", agentState: { path: "/state" } } } }),
    credentialOptions: () => ({ env: {}, root: path.join(dir, "credentials") }),
    fetchImpl: async (url, options) => { posts.push(JSON.parse(options.body).kind); return new Response(null, { status: 204 }); } });
}

test("the residents' publication is composed and sent only inside an admitted operation, asked again at the post", async (t) => {
  const dir = home(t);
  const refusedPosts = [];
  await sender(dir, { admit: () => null, posts: refusedPosts }).tick();
  assert.deepEqual(refusedPosts, ['notice agent state "population": not-owner']);
  // Admitted to compose, but the role is gone by the time the body would be posted: the post's own operation is dead.
  const run = async (sendLive) => {
    const posts = [];
    let admissions = 0;
    const done = [];
    await sender(dir, { posts, admit: () => {
      const mine = ++admissions;
      return { live: () => mine === 1 || sendLive, done: () => done.push(mine) };
    } }).tick();
    for (const end = Date.now() + 2000; done.length < 2 && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
    return { posts, done };
  };
  const gone = await run(false);
  assert.deepEqual(gone.posts, [], "a body was posted for a role that was gone at the post");
  assert.deepEqual(gone.done.sort(), [1, 2], "every admitted operation is finished");
  const control = await run(true);
  assert.deepEqual(control.posts, ["snapshot"], "control: a live operation posts");
});
