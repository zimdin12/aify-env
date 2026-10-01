#!/usr/bin/env node
// The parts the aify-comms plugin is built from, each held to its own contract. The plugin's own tests
// (aify-comms-plugin, plugins-follow-the-registry) prove them wired together; these name what each
// part promises, so a part can change without a plugin-level test being the only thing that notices.

import assert from "node:assert/strict";
import test from "node:test";

import { claimerFromAnswer } from "../lib/plugins/aify-comms/claimer-answer.mjs";
import { runPasses } from "../lib/plugins/aify-comms/pass-loop.mjs";
import { DETACHING, PluginPhase } from "../lib/plugins/aify-comms/plugin-phase.mjs";

test("PluginPhase: what each phase allows, and the only ways between them", async () => {
  const phase = new PluginPhase();
  const view = () => [phase.name, phase.claims, phase.controls, phase.refusal()];
  assert.deepEqual(view(), ["running", true, true, ""]);
  assert.equal(phase.resume(), false, "only a held plugin resumes");
  assert.equal(await phase.quiesce(), false, "not held before");
  assert.deepEqual(view(), ["quiescing", false, false, DETACHING]);
  phase.hold();
  assert.deepEqual(view(), ["held", false, true, DETACHING], "held: controls for its workers, no claims, starts refused");
  assert.equal(await phase.quiesce(), true, "held before, so the caller does not announce it twice");
  phase.hold();
  assert.equal(phase.resume(), true);
  assert.deepEqual(view(), ["running", true, true, ""]);
  await phase.quiesce();
  phase.detach();
  assert.deepEqual([phase.name, phase.detached, phase.claims, phase.controls], ["detached", true, false, false]);
  phase.begin();
  assert.equal(phase.name, "running", "a fresh start");
});

test("PluginPhase.quiesce waits for every tracked pass, and a failed pass does not fail it", async () => {
  const phase = new PluginPhase();
  let finish;
  const claim = phase.track("claim", new Promise((resolve) => { finish = resolve; }));
  phase.track("control", Promise.reject(new Error("a pass that threw")));
  let quiet = false;
  const quiescing = phase.quiesce().then(() => { quiet = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(quiet, false, "the claim pass is still in flight");
  finish({ outcome: "idle" });
  await quiescing;
  assert.deepEqual(await claim, { outcome: "idle" }, "track hands the pass itself back to its loop");
});

test("runPasses: a throwing pass costs one interval and is reported, never the loop", async () => {
  const logs = [];
  const settled = [];
  const pauses = [];
  let passes = 0;
  await runPasses({
    label: "claim",
    runs: () => passes < 3,
    pass: async () => {
      passes += 1;
      if (passes === 2) throw new Error("boom");
      return { outcome: "idle" };
    },
    settle: (result) => { settled.push(result.outcome); return result.outcome === "unreachable" ? 50 : 5; },
    log: (line) => logs.push(line),
    setTimeoutImpl: (fn, ms) => { pauses.push(ms); fn(); },
  });
  assert.deepEqual(settled, ["idle", "unreachable", "idle"], "the third pass ran");
  assert.deepEqual(pauses, [5, 50, 5], "each pass waits what its settle returned");
  assert.deepEqual(logs, ["aify-comms claim pass failed: boom"]);
  // Control: a loop that may not run begins no pass.
  let began = false;
  await runPasses({ label: "x", runs: () => false, pass: async () => { began = true; }, settle: () => 0, log: () => {}, setTimeoutImpl: setTimeout });
  assert.equal(began, false);
});

test("claimerFromAnswer: accepted, refused once with one log line, accepted again, and an older service", () => {
  const accepted = claimerFromAnswer({ claimer: { accepted: true, bridgeId: "me" } }, { ourBridgeId: "me" });
  assert.deepEqual([accepted.claimRefused, accepted.lastHeartbeatError, accepted.logLine], [false, "", ""]);
  assert.deepEqual([accepted.claimer.holderBridgeId, accepted.claimer.ourBridgeId], ["me", "me"]);

  const refusal = { claimer: { accepted: false, bridgeId: "them", reason: "an existing bridge started later" } };
  const first = claimerFromAnswer(refusal, { wasRefused: false, ourBridgeId: "me" });
  assert.equal(first.claimRefused, true);
  assert.equal(first.lastHeartbeatError, "not the claimer: an existing bridge started later");
  assert.match(first.logLine, /did NOT accept this host as the claimer \(holder: them;/);
  assert.deepEqual([first.claimer.holderBridgeId, first.claimer.ourBridgeId], ["them", "me"], "the holder's id and ours, both named");
  assert.equal(claimerFromAnswer(refusal, { wasRefused: true }).logLine, "", "said once per transition");

  const back = claimerFromAnswer({ claimer: { accepted: true } }, { wasRefused: true });
  assert.match(back.logLine, /accepted this host as the claimer again/);

  for (const older of [{ ok: true }, null, "ok"]) {
    const read = claimerFromAnswer(older, { wasRefused: false });
    assert.deepEqual([read.claimer, read.claimRefused, read.lastHeartbeatError, read.logLine], [null, false, "", ""],
      `an answer with no claimer (${JSON.stringify(older)}) is unknown, not a refusal`);
  }
});
