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
