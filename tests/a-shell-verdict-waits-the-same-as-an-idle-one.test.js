#!/usr/bin/env node
// A working agent is not reported as finished on the strength of one repaint.
//
// THE DEBOUNCE THIS GUARDS. Claude's screen goes through moments mid-turn that look like an idle
// prompt, so the observer holds a working -> idle transition for three confirmations, up to 700 ms,
// before reporting it. A verdict carrying VISIBLE evidence of idleness -- a drawn prompt box -- skips
// that wait by design; the verdicts that carry no such evidence are exactly what the wait is for.
//
// EXTERNAL REVIEW, 2026-09-21, finding F. `background-shell.mjs` renames such a verdict to `shell`,
// and the wait was keyed on the literal state `idle` -- so the rename walked straight past it. The
// rename also SET `visibleIdle: true`, which is the other way past the same wait, handed to a verdict
// that had not earned it.
//
// THE FIXTURES ARE THE POINT, and the first version of this file got them wrong twice: a "working"
// screen that the idle rule matched anyway, and an "idle" screen that was VISIBLY idle and so was
// never debounced at all. Both were measured against the real rules rather than reasoned about. What
// reaches the wait is an idle verdict with no prompt box drawn -- here, one recognised only by the
// terminal's OSC progress -- which `screen-rules.mjs` answers with `visibleIdle: false`. The control
// is the same screen without the shell footer, in the same run.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PENDING_IDLE_RECHECK_MS, THROTTLE_MS, observeScreen } from "../lib/plugins/aify-comms/screen-observer.mjs";

const NL = String.fromCharCode(10);
const PROMPT_BOX = "─".repeat(60);
const FOOTER_SHELL = "  ▸▸ bypass permissions on · 1 shell · ↓ to manage";
const FOOTER_PLAIN = "  ▸▸ bypass permissions on · ↓ to manage";
/** Matches `live_turn_working`: a live turn carrying its interrupt hint. */
const WORKING = ["✻ Brewing… (12s · esc to interrupt)", "", PROMPT_BOX, "❯ ", PROMPT_BOX].join(NL);
/** NO prompt box: recognised only by OSC progress, so `visibleIdle` is false and the wait applies. */
const WITH_SHELL = ["some transcript output", FOOTER_SHELL].join(NL);
const WITHOUT_SHELL = ["some transcript output", FOOTER_PLAIN].join(NL);
const PROGRESS = "4;0";

/** Drives one observer with a clock and a timer queue the test advances by hand. */
function harness() {
  let clock = 1_000;
  const timers = [];
  const reported = [];
  let showing = WORKING;
  const observer = observeScreen({
    runtime: "claude-code",
    read: async () => ({ rows: showing.split(NL), title: "", progress: showing === WORKING ? null : PROGRESS }),
    report: async (activity) => { reported.push(activity.state); },
    now: () => clock,
    schedule: (fn, delay) => { const t = { fn, at: clock + delay }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const tick = async () => {
    const t = timers.shift();
    if (!t) return false;
    clock = Math.max(clock, t.at);
    await t.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return true;
  };
  return { observer, reported, tick, show: (screen) => { showing = screen; }, advance: (ms) => { clock += ms; } };
}

/** Settle the observer on `working`, which is the state the wait is entered from. */
async function reachWorking(h) {
  h.show(WORKING);
  h.observer.noteOutput("x");
  for (let i = 0; i < 4 && await h.tick(); i++) { /* read, judge, report */ }
  assert.deepEqual(h.reported, ["working"], "the harness must reach working, or nothing below is a proof");
  h.reported.length = 0;
}

for (const [name, screen, expected] of [
  ["shell", WITH_SHELL, "shell"],
  ["idle (the control)", WITHOUT_SHELL, "idle"],
]) {
  test(`a working agent is not reported as ${name} from one frame`, async () => {
    const h = harness();
    await reachWorking(h);

    h.show(screen);
    h.observer.noteOutput("x");
    await h.tick();
    assert.deepEqual(h.reported, [], `one frame must not settle it; it reported ${h.reported}`);

    // Then the confirmations, at the observer's own recheck interval.
    for (let i = 0; i < 4; i++) { h.advance(PENDING_IDLE_RECHECK_MS); await h.tick(); }
    assert.deepEqual(h.reported, [expected], `it should settle on ${expected} once confirmed`);
    h.observer.dispose();
  });
}

test("a turn that carries on is never reported as finished at all", async () => {
  // What the wait is FOR: the frame that looked finished was transient, and the turn continued.
  const h = harness();
  await reachWorking(h);

  h.show(WITH_SHELL);
  h.observer.noteOutput("x");
  await h.tick();
  h.show(WORKING);
  h.advance(THROTTLE_MS);
  for (let i = 0; i < 4; i++) { h.advance(PENDING_IDLE_RECHECK_MS); await h.tick(); }
  assert.deepEqual(h.reported, [], "the agent must still read working");
  h.observer.dispose();
});
