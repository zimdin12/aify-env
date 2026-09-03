// "Is aify-env working?" -- the question this doctor could not answer.
//
// ADVERTISING AND CLAIMING ARE DIFFERENT CAPABILITIES. Advertising DESCRIBES this machine; a plugin
// CLAIMS work on it. The split is deliberate: it exists so a host with no claimer stops reading as
// ready. On 2026-09-02 the advertiser was healthy for hours, the aify-comms plugin's every heartbeat
// was discarded by supersession arbitration while being answered `ok: true`, `/spawn` refused six
// times, and every instrument -- this doctor included -- reported the half that worked. The operator
// ran exactly what they were told to. Two agents read the same signals and told them the fleet was
// ready.
//
// FOUR STATES, and each pin below is a reader sent somewhere different: nothing claims (the spawn
// path is dead), refused (someone else holds it, and restarting will not help), accepted, and no
// evidence yet. This project's two worst false greens were both checks that reported no evidence as
// a pass, which is why the last of those is UNANSWERED and not a quiet ok.

import { test } from "node:test";
import assert from "node:assert/strict";

import { claimingCheck } from "../lib/environment-checks.mjs";
import { STATE } from "../lib/health.mjs";

const withClaimer = (claimer) => [{ name: "aify-comms", state: { claimer } }];

test("an ACCEPTED claim passes and names the service", () => {
  const check = claimingCheck({
    answered: true, plugins: withClaimer({ accepted: true, bridgeId: "me", reason: "" }),
  });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /claiming work for: aify-comms/);
});

test("a REFUSED claim FAILS and names who holds the row", () => {
  // The 2026-09-02 state exactly. Restarting this daemon does not help if another claimer
  // legitimately owns the environment, so the remedy has to name the holder rather than say "retry".
  const check = claimingCheck({
    answered: true,
    plugins: withClaimer({ accepted: false, bridgeId: "other-bridge", reason: "an existing bridge started later" }),
  });
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.detail, /other-bridge/);
  assert.match(check.detail, /an existing bridge started later/);
  assert.match(check.fix, /metadata\.bridgeStartedAt/,
    "the fix must name the field, because a beat without it loses every arbitration and is answered ok");
});

test("NO plugin at all FAILS — nothing here claims, so spawns are refused", () => {
  // Distinct from "a plugin that has not answered yet": this host will never claim, and saying
  // nothing about it is what let a registered service sit unserved in silence.
  const check = claimingCheck({ answered: true, plugins: [] });
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.detail, /nothing here claims work/);
  assert.match(check.fix, /services\.json/);
});

test("a plugin that has NOT been told yet is UNANSWERED, never a quiet pass", () => {
  const check = claimingCheck({ answered: true, plugins: [{ name: "aify-comms", state: { claimer: null } }] });
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /has not been told whether it is the claimer/);
});

test("a daemon too old to report plugins is UNANSWERED, not broken", () => {
  // It may be claiming perfectly well and simply cannot say. Calling that a failure would fire on
  // every host mid-upgrade and train the reader to ignore this row.
  for (const plugins of [undefined, "yes", null]) {
    assert.equal(claimingCheck({ answered: true, plugins }).state, STATE.UNANSWERED);
  }
});

test("RUNNING-BUT-SILENT and NOTHING-RUNNING do not print the same sentence", () => {
  // Found in this doctor's own output while diagnosing the very problem it exists to report: it
  // said "no aify-env answered" one line under a row saying an environment was running at
  // 127.0.0.1:8802. Both arrived as `null` and the message picked the wrong one. Two rows of one
  // report contradicting each other is worse than either row alone, and the remedies differ --
  // restart it, versus start one.
  const nothingRunning = claimingCheck({ answered: false });
  const runningButOld = claimingCheck({ answered: true, plugins: null });
  assert.equal(nothingRunning.state, STATE.UNANSWERED);
  assert.equal(runningButOld.state, STATE.UNANSWERED);
  assert.notEqual(nothingRunning.detail, runningButOld.detail);
  assert.match(nothingRunning.detail, /no aify-env answered/);
  assert.match(runningButOld.detail, /running but does not report/);
  assert.match(runningButOld.detail, /restart it/, "and it must name the remedy that differs");
});

test("no aify-env answering is UNANSWERED, and says so", () => {
  const check = claimingCheck({ answered: false });
  assert.equal(check.state, STATE.UNANSWERED);
  assert.match(check.detail, /no aify-env answered/);
});

test("ACCEPTED and REFUSED are DISTINGUISHABLE — the control", () => {
  // If both answered the same, every assertion above could hold on a hardcoded verdict, which is the
  // failure being fixed one layer down.
  const yes = claimingCheck({ answered: true, plugins: withClaimer({ accepted: true, bridgeId: "me" }) });
  const no = claimingCheck({ answered: true, plugins: withClaimer({ accepted: false, bridgeId: "them" }) });
  assert.notEqual(yes.state, no.state);
});

test("one accepted and one silent passes, and still NAMES the silent one", () => {
  // A second service must not be swallowed by the first one's success -- that is how "registered and
  // unserved" stayed invisible.
  const check = claimingCheck({
    answered: true,
    plugins: [
      { name: "aify-comms", state: { claimer: { accepted: true, bridgeId: "me" } } },
      { name: "aify-other", state: { claimer: null } },
    ],
  });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /not yet answered for: aify-other/);
});

test("a refusal WINS over an acceptance, because the failure is the actionable half", () => {
  const check = claimingCheck({
    answered: true,
    plugins: [
      { name: "aify-comms", state: { claimer: { accepted: true, bridgeId: "me" } } },
      { name: "aify-other", state: { claimer: { accepted: false, bridgeId: "them", reason: "held" } } },
    ],
  });
  assert.equal(check.state, STATE.FAILED);
  assert.match(check.detail, /aify-other/);
});
