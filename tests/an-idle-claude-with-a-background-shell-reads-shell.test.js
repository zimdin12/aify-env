// An idle Claude Code prompt with background shells running reports `shell`, and nothing else does.
//
// The footer and transcript lines are copied from the operator's screenshot of 2026-09-17, where the
// footer read `bypass permissions on · 1 shell · ↓ to manage` and the transcript above it carried
// `Brewed for 52s · done 2:59 AM · 1 shell still running`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKGROUND_SHELL_RULE, withBackgroundShell } from "../lib/plugins/aify-comms/background-shell.mjs";
import { evaluateScreen, manifestForRuntime, screenText } from "../lib/plugins/aify-comms/screen-rules.mjs";

const claude = manifestForRuntime("claude-code");
const PROMPT_BOX = "─".repeat(60);
const screenWith = (footer, above = "✻ Brewed for 52s · done 2:59 AM · 1 shell still running") => screenText([
  above,
  "",
  PROMPT_BOX,
  "❯ ",
  PROMPT_BOX,
  footer,
]);
const judge = (screen) => withBackgroundShell(claude.id, evaluateScreen(claude, { screen }), screen);

test("an idle prompt whose footer shows a background shell reads shell", () => {
  const verdict = judge(screenWith("  ▸▸ bypass permissions on · 1 shell · ↓ to manage"));
  assert.equal(verdict.state, "shell");
  assert.equal(verdict.rule, BACKGROUND_SHELL_RULE);
});

test("several shells, and the item at the end of the footer, count too", () => {
  assert.equal(judge(screenWith("  ▸▸ bypass permissions on · 3 shells · ↓ to manage")).state, "shell");
  assert.equal(judge(screenWith("  ▸▸ bypass permissions on · 1 shell")).state, "shell");
});

test("CONTROL: the same idle prompt without the footer item stays idle", () => {
  // The transcript line above still says "1 shell still running"; it is history, not the footer.
  assert.equal(judge(screenWith("  ▸▸ bypass permissions on · ↓ to manage")).state, "idle");
});

test("the transcript's `still running` line alone never reads as the footer", () => {
  const screen = screenText([PROMPT_BOX, "❯ ", PROMPT_BOX, "✻ Brewed for 9s · done 2:51 AM · 1 shell still running"]);
  assert.equal(judge(screen).state, "idle");
});

test("a working or blocked verdict is never refined, and neither is another runtime", () => {
  const working = { state: "working", rule: "live_turn_working", visibleIdle: false };
  assert.equal(withBackgroundShell("claude", working, screenWith("· 1 shell ·")), working);
  const idle = { state: "idle", rule: null, visibleIdle: false };
  assert.equal(withBackgroundShell("codex", idle, screenWith("· 1 shell ·")), idle);
});

test("a screen NO RULE recognised is not renamed, however its footer reads", () => {
  // EXTERNAL REVIEW, 2026-09-21, finding F. `screen-rules.mjs` answers `idle` with `rule: null` when
  // nothing matched, which is the absence of evidence rather than an observed prompt -- a mid-turn
  // repaint looks exactly like that. Renaming it put a state and a rule name on a screen nobody
  // recognised, for an agent that was still generating.
  const unrecognised = { state: "idle", rule: null, visibleIdle: false, visibleBlocker: false };
  const verdict = withBackgroundShell("claude", unrecognised, screenWith("  ▸▸ bypass permissions on · 1 shell ·"));
  assert.equal(verdict, unrecognised, "the fallback verdict must come back untouched, not refined");
});

test("it carries `visibleIdle`, it does not claim it", () => {
  // The other half of F. `visibleIdle: true` asserts the screen VISIBLY showed an idle prompt, and
  // the observer reads that as permission to skip its pending-idle debounce. Setting it here handed
  // that permission to a verdict that had not earned it. `live_prompt_box` DOES declare it -- a
  // drawn prompt box is visible evidence -- but `osc_progress_idle` does not, and that is the
  // verdict the wait exists for. What this must do is pass through whatever the rule said.
  const rulesSaid = { state: "idle", rule: "osc_progress_idle", visibleIdle: false, visibleBlocker: false };
  const verdict = withBackgroundShell("claude", rulesSaid, screenWith("  ▸▸ bypass permissions on · 1 shell ·"));
  assert.equal(verdict.state, "shell");
  assert.equal(verdict.visibleIdle, false, "a refinement must not manufacture the evidence for itself");
});
