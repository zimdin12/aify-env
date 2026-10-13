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

test("AN EXIT INSIDE THE WINDOW IS SEEN AT ONCE: a reused answer carries creation and command line, never life", () => {
  const io = fakeOs();
  io.cache.answers([41]);
  io.cache.serve();
  assert.equal(io.cache.answers([41]).get(41).alive, true);
  io.os.state = "gone";
  assert.deepEqual(io.cache.answers([41]).get(41), { alive: false, createdAtUs: null, commandLine: null },
    "a process that exited a moment ago was still reported alive from the reused answer");
});
