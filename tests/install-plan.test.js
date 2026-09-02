// What an install still needs from the operator, and the branch that only happens with no terminal.
//
// THE DEFECT THESE PIN, measured 2026-09-02: a service key sat in aify-comms' `.env`, this host held
// no credential for it, and nothing asked. Every advertisement was refused with 401, both sides
// reported healthy, and a day was lost to a fleet that would not spawn with no component naming a
// credential. An installer that silently proceeds with a missing value is how that happens.
//
// AND THE OPPOSITE FAILURE, which is why "ask" is not unconditional: re-running must be safe and
// must be the UPDATE path. An installer that re-asks for a key it already holds trains an operator
// to paste secrets it did not need, and one that overwrites a working credential turns an update
// into an outage.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANNOT_ASK,
  NEEDS_NOTHING,
  NO_PLUGIN,
  WILL_ASK,
  describePlan,
  planInstall,
  planIsIncomplete,
} from "../lib/install-plan.mjs";

const COMMS = [{ name: "aify-comms", endpoint: "http://127.0.0.1:8800" }];
const has = (...names) => (name) => names.includes(name);
const none = () => false;
const all = () => true;

test("a missing credential is ASKED for, which is the whole point", () => {
  const plan = planInstall({ services: COMMS, hasCredential: none, hasPlugin: all, interactive: true });
  assert.deepEqual(plan.willAsk, ["aify-comms"]);
  assert.equal(plan.steps[0].action, WILL_ASK);
});

test("a credential already stored is NOT asked for again", () => {
  // Re-running is the update path. Re-asking teaches an operator to paste a secret nothing needed,
  // and overwriting a working credential turns an update into an outage.
  const plan = planInstall({ services: COMMS, hasCredential: all, hasPlugin: all, interactive: true });
  assert.deepEqual(plan.willAsk, []);
  assert.equal(plan.steps[0].action, NEEDS_NOTHING);
});

test("with no terminal it says what will break, rather than hanging or passing quietly", () => {
  // The branch that only happens unattended -- CI, a service manager, an agent -- and therefore the
  // one nothing else exercises.
  const plan = planInstall({ services: COMMS, hasCredential: none, hasPlugin: all, interactive: false });
  assert.equal(plan.steps[0].action, CANNOT_ASK);
  assert.match(plan.steps[0].reason, /401/, "the reason must name the symptom, not just say 'configure it'");
  assert.match(plan.steps[0].reason, /credential set/, "and must name the command that fixes it");
  assert.deepEqual(plan.willAsk, [], "nothing may be asked when there is nobody to ask");
});

test("an unattended run that cannot ask reports INCOMPLETE, so it fails rather than lying", () => {
  const blocked = planInstall({ services: COMMS, hasCredential: none, hasPlugin: all, interactive: false });
  assert.equal(planIsIncomplete(blocked), true, "a host that cannot claim anything must not exit 0");
  const fine = planInstall({ services: COMMS, hasCredential: all, hasPlugin: all, interactive: false });
  assert.equal(planIsIncomplete(fine), false);
});

test("a service this host cannot host work for is NAMED, not silently skipped", () => {
  // Describing a machine and running processes for it are different offers. Saying so is what stops
  // an operator wondering later why nothing ever claims.
  const plan = planInstall({
    services: [{ name: "aify-other", endpoint: "http://y" }],
    hasCredential: none, hasPlugin: none, interactive: true,
  });
  assert.equal(plan.steps[0].action, NO_PLUGIN);
  assert.deepEqual(plan.willAsk, [], "a service with no plugin needs no credential from this host");
});

test("several services are decided independently", () => {
  const plan = planInstall({
    services: [
      { name: "aify-comms", endpoint: "a" },
      { name: "aify-second", endpoint: "b" },
      { name: "aify-third", endpoint: "c" },
    ],
    hasCredential: has("aify-comms"),
    hasPlugin: has("aify-comms", "aify-second"),
    interactive: true,
  });
  assert.deepEqual(plan.steps.map((s) => `${s.service}:${s.action}`), [
    `aify-comms:${NEEDS_NOTHING}`,
    `aify-second:${WILL_ASK}`,
    `aify-third:${NO_PLUGIN}`,
  ]);
});

test("no registered services is a clean, explained outcome", () => {
  const plan = planInstall({ services: [], hasCredential: none, hasPlugin: all, interactive: true });
  assert.deepEqual(plan.steps, []);
  assert.match(describePlan(plan).join(" "), /no services are registered/);
  assert.equal(planIsIncomplete(plan), false);
});

test("a nameless registry entry is ignored rather than asked about", () => {
  const plan = planInstall({
    services: [{ endpoint: "http://x" }, { name: "  ", endpoint: "http://y" }],
    hasCredential: none, hasPlugin: all, interactive: true,
  });
  assert.deepEqual(plan.steps, []);
});

test("the description says what will happen, in the operator's terms", () => {
  const lines = describePlan(planInstall({
    services: COMMS, hasCredential: none, hasPlugin: all, interactive: true,
  }));
  assert.match(lines[0], /aify-comms: will ask for a credential/);
});
