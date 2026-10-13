// The daemon asks the OS about its agents' pids without blocking while it serves (lib/process-probe.mjs ProcessProbeCache).
//
// Measured 2026-10-13: every Claude tool call sends a turn event, each event ran a ~1.2 s synchronous PowerShell probe,
// and the daemon's /health reached p99 1.42 s, freezing every herdr pane on it. Driven with a fake OS: no real process
// is asked about.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStateHost } from "../lib/agent-state-host.mjs";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { PROBE_REUSE_MS, ProcessProbeCache, probeProcessesAsync } from "../lib/process-probe.mjs";

const L1 = "7f3c9e2a-0000-4000-8000-000000000001";
const WRITTEN = 1_790_950_000_500_123;
const RUNNING = { alive: true, createdAtUs: WRITTEN - 5, commandLine: `"C:/Program Files/Git/bin/bash.exe" /c/Users/x/bin/claude-aify` };
const UNANSWERED = { alive: null, createdAtUs: null, commandLine: null };

function homeWith41() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-probe-cache-"));
  fs.mkdirSync(path.join(home, "residents"), { recursive: true });
  fs.writeFileSync(path.join(home, "residents", `lead.${L1}.json`), JSON.stringify({ agentId: "lead", lifetime: L1,
    instance: "default", harness: "claude", pid: 41, launcher: "C:/Users/x/bin/claude-aify", writtenAtUs: WRITTEN }));
  return home;
}

/** A cache over a fake OS: `pending` holds each background probe until the test answers it. */
function fakeOs({ state = "alive" } = {}) {
  const clock = { ms: 1_000_000 };
  const pending = [];
  const io = {
    clock, pending, syncProbes: 0,
    os: { state },
    answerNext(answers) { pending.shift().resolve(answers); },
  };
  io.cache = new ProcessProbeCache({
    nowMs: () => clock.ms,
    state: () => io.os.state,
    probeSync: (pids) => {
      io.syncProbes += 1;
      if (io.serving) throw new Error("a probe blocked the daemon after boot");
      return new Map(pids.map((pid) => [pid, RUNNING]));
    },
    probe: (pids) => new Promise((resolve) => pending.push({ pids, resolve })),
  });
  return io;
}

test("A TURN EVENT IS ANSWERED BEFORE THE OS IS: the probe runs in the background once the daemon serves", async () => {
  const io = fakeOs();
  const host = new AgentStateHost({ aifyHome: homeWith41(), instance: "default", probe: (pids) => io.cache.answers(pids),
    nowUs: () => WRITTEN + 60_000_000 });
  host.boot();
  assert.equal(io.syncProbes, 1, "boot asks the OS before anything is served");
  io.cache.serve();
  io.serving = true;
  io.clock.ms += PROBE_REUSE_MS + 1;
  const events = new AgentTurnEvents({ host, instance: "default" });
  const answered = events.receive("lead", { kind: "turn-start", instance: "default", lifetime: L1, firedAtUs: WRITTEN + 1 });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(io.pending.length, 1, "the OS is being asked, and the event did not wait for it");
  io.answerNext(new Map([[41, RUNNING]]));
});

test("EVENTS INSIDE THE WINDOW SHARE ONE ANSWER, and asks while a probe runs join it", async () => {
  const io = fakeOs();
  io.cache.answers([41]);
  io.cache.serve();
  io.serving = true;
  for (let i = 0; i < 10; i += 1) io.cache.answers([41]);
  assert.equal(io.pending.length, 0, "an answer younger than the window is reused");
  io.clock.ms += PROBE_REUSE_MS + 1;
  for (let i = 0; i < 10; i += 1) io.cache.answers([41]);
  assert.equal(io.pending.length, 1, "ten asks past the window start one probe");
  assert.equal(io.cache.refresh([41]), io.cache.refresh([41]), "concurrent refreshes are one probe");
  io.answerNext(new Map([[41, RUNNING]]));
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 10; i += 1) io.cache.answers([41]);
  assert.equal(io.pending.length, 0, "the fresh answer is reused again");
});

test("A PROBE THAT FAILS STILL SAYS NOTHING: unanswered, never gone, and not asked again inside the window", async () => {
  const io = fakeOs({ state: "unknown" });
  io.cache.serve();
  io.serving = true;
  assert.deepEqual(io.cache.answers([41]).get(41), UNANSWERED, "never answered and not provably alive: unanswered");
  io.answerNext(new Map([[41, UNANSWERED]]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(io.cache.answers([41]).get(41), UNANSWERED, "a failed probe is not the OS saying it is gone");
  assert.equal(io.pending.length, 0, "a failing probe waits out the window rather than looping");
  io.os.state = "gone";
  assert.deepEqual(io.cache.answers([41]).get(41), { alive: false, createdAtUs: null, commandLine: null },
    "signal 0 proving it gone is an answer");
});

test("THE BACKGROUND PROBE READS THE SAME TABLE THE BLOCKING ONE DOES", async () => {
  const run = (_cmd, _args, _opts, done) => done(null, JSON.stringify([{ pid: 11, created: "2026-10-02T15:00:00Z", cmd: "x" }]), "");
  const answers = await probeProcessesAsync([11, 22], { platform: "win32", run });
  assert.deepEqual(answers.get(11), { alive: true, createdAtUs: Date.parse("2026-10-02T15:00:00Z") * 1000, commandLine: "x" });
  assert.deepEqual(answers.get(22), { alive: false, createdAtUs: null, commandLine: null });
  const failed = await probeProcessesAsync([11], { platform: "win32", run: (_c, _a, _o, done) => done(new Error("ETIMEDOUT"), "", "") });
  assert.deepEqual(failed.get(11), UNANSWERED);
});

test("A KEPT ANSWER SIGNAL 0 CONTRADICTS IS NOT REUSED: a reused pid, or one signal 0 cannot read, is unanswered", async () => {
  // Review of 3e58c72: boot saw pid 41 gone, a new lifetime started on reused 41 a moment later, and the kept GONE made
  // the host delete the new lifetime's record and report the agent cold.
  const io = fakeOs({ state: "gone" });
  io.cache.serve();
  io.serving = true;
  const landed = io.cache.refresh([41]);
  io.answerNext(new Map([[41, { alive: false, createdAtUs: null, commandLine: null }]]));
  await landed;
  assert.equal(io.cache.answers([41]).get(41).alive, false, "the setup: the kept answer is GONE");
  assert.equal(io.pending.length, 0, "the setup: inside the window");
  io.os.state = "alive";
  assert.deepEqual(io.cache.answers([41]).get(41), UNANSWERED, "a kept GONE was reused for a pid that is alive again");
  const kept = fakeOs();
  kept.cache.answers([41]);
  kept.cache.serve();
  kept.serving = true;
  kept.os.state = "unknown";
  assert.deepEqual(kept.cache.answers([41]).get(41), UNANSWERED, "a kept alive answer outlived signal 0 going unknown");
  kept.os.state = "alive";
  assert.deepEqual(kept.cache.answers([41]).get(41), RUNNING, "the control: an answer signal 0 agrees with is reused");
});

test("AN EXIT INSIDE THE WINDOW IS SEEN AT ONCE: a reused answer carries creation and command line, never life", () => {
  const io = fakeOs();
  io.cache.answers([41]);
  io.cache.serve();
  assert.equal(io.cache.answers([41]).get(41).alive, true);
  io.os.state = "gone";
  assert.deepEqual(io.cache.answers([41]).get(41), { alive: false, createdAtUs: null, commandLine: null },
    "a process that exited a moment ago was still reported alive from the reused answer");
});

test("AN ANSWER PROBED BEFORE A RECORD WAS WRITTEN IS NOT REUSED FOR IT: a reused pid never inherits the old birth", () => {
  // Review of 50e4839: L1 on pid 41 was probed alive, exited, and L2 took pid 41 a millisecond later. Signal 0 said
  // alive, the kept L1 answer pinned L2 to L1's birth, and the next fresh probe called L2 reused and deleted it.
  const io = fakeOs();
  io.cache.answers([41]);
  io.cache.serve();
  io.serving = true;
  const probedAt = io.clock.ms;
  io.clock.ms += 1;
  assert.deepEqual(io.cache.answers([41], { writtenAtMs: new Map([[41, probedAt + 1]]) }).get(41), UNANSWERED,
    "an answer older than the record was reused for it");
  assert.equal(io.pending.length, 1, "the new record's pid is asked about at once");
  assert.deepEqual(io.cache.answers([41], { writtenAtMs: new Map([[41, probedAt - 1]]) }).get(41), RUNNING,
    "the control: an answer probed after the record was written is reused");
});

test("THE STATE HOST TELLS THE PROBE WHEN EACH RECORD WAS WRITTEN, and the daemon passes that to the cache", () => {
  const asked = [];
  const host = new AgentStateHost({ aifyHome: homeWith41(), instance: "default", nowUs: () => WRITTEN + 60_000_000,
    probe: (pids, options) => { asked.push(options?.writtenAtMs?.get(41)); return new Map(pids.map((pid) => [pid, RUNNING])); } });
  host.boot();
  assert.deepEqual(asked, [Math.floor(WRITTEN / 1000)]);
  const wiring = fs.readFileSync(new URL("../lib/daemon-agent-state.mjs", import.meta.url), "utf8");
  assert.match(wiring, /\(pids, options\) => cache\.answers\(pids, options\)/);
});

test("A PROBE IN THE WRITE'S OWN MILLISECOND, OR ONE THAT STARTED BEFORE IT AND LANDED AFTER, IS NOT REUSED FOR IT", async () => {
  // Review of 3900ae2: the write is known only to the millisecond, so an equal stamp may predate it; and an answer was
  // stamped when it landed, so a snapshot taken before the write but delivered after it read as newer.
  const io = fakeOs();
  io.cache.answers([41]);
  io.cache.serve();
  io.serving = true;
  const probedAt = io.clock.ms;
  assert.deepEqual(io.cache.answers([41], { writtenAtMs: new Map([[41, probedAt]]) }).get(41), UNANSWERED,
    "an answer from the write's own millisecond was reused");
  io.answerNext(new Map([[41, RUNNING]]));
  await new Promise((resolve) => setImmediate(resolve));

  const late = fakeOs();
  late.cache.serve();
  late.serving = true;
  const landed = late.cache.refresh([41]);
  const startedAt = late.clock.ms;
  late.clock.ms += 5;
  late.answerNext(new Map([[41, RUNNING]])); // L1's snapshot, delivered after L2's write at startedAt + 2
  await landed;
  assert.deepEqual(late.cache.answers([41], { writtenAtMs: new Map([[41, startedAt + 2]]) }).get(41), UNANSWERED,
    "a snapshot taken before the write was reused because it landed after it");
  assert.deepEqual(late.cache.answers([41], { writtenAtMs: new Map([[41, startedAt - 1]]) }).get(41), RUNNING,
    "the control: a snapshot started after the write is reused");
});
