// The screen rules read a runtime's screen the way Herdr does.
//
// PORTED FROM HERDR. Every screen and title below comes from Herdr's own manifest tests
// (herdrdev/herdr, src/detect/manifest/tests.rs, tag v0.9.0, commit b99002ac), Apache-2.0 -- see
// lib/plugins/aify-comms/agent-detection/NOTICE. They are synthetic or upstream's own captures;
// none is a screen from this project's hosts. Each test keeps its upstream name, so a divergence can
// be looked up on both sides. The hermes tests at the end are this project's: upstream has none.
//
// WHAT THIS PROVES. That the JSON copy of the manifests, evaluated by `screen-rules.mjs`, reaches
// the verdict Herdr's engine reaches on the same input: the same state, the same winning rule, the
// same visible flags. It does NOT prove the screen text fed in matches what Herdr would read from a
// live pane -- that is `a-managed-terminal-reports-what-its-screen-shows.test.js`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateScreen,
  manifestForRuntime,
  regionText,
  screenText,
} from "../lib/plugins/aify-comms/screen-rules.mjs";

const claude = manifestForRuntime("claude-code");
const codex = manifestForRuntime("codex");
const hermes = manifestForRuntime("hermes");
const rule = (screen, manifest, title = "", progress = "") => evaluateScreen(manifest, { screen, title, progress });
const RULE64 = "─".repeat(64);

// ── the manifests ──────────────────────────────────────────────────────────────────────────────

test("the three vendored manifests load by runtime name, and anything else has none", () => {
  assert.equal(claude?.id, "claude");
  assert.equal(manifestForRuntime("claude")?.id, "claude");
  assert.equal(manifestForRuntime(" Claude-Code ")?.id, "claude");
  assert.equal(codex?.id, "codex");
  assert.equal(hermes?.id, "hermes");
  assert.equal(manifestForRuntime("hermes-agent")?.id, "hermes");
  for (const other of ["opencode", "pi", "generic", "", null, undefined]) {
    assert.equal(manifestForRuntime(other), null, `${other} has no manifest`);
  }
});

test("every rule in every vendored manifest compiles, so none is silently skipped", () => {
  for (const manifest of [claude, codex, hermes]) {
    // An empty screen evaluates every rule, so a pattern JavaScript cannot compile throws here.
    assert.doesNotThrow(() => rule("", manifest, "x", "x"), manifest.id);
    assert.match(manifest.vendored.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.vendored.commit, "b99002ac99b09e00b4ca692436cb15a6b0d676f1");
  }
});

// ── engine semantics ───────────────────────────────────────────────────────────────────────────

test("known_agent_no_match_defaults_to_idle_fallback", () => {
  const result = rule("ordinary prompt text", codex);
  assert.equal(result.state, "idle");
  assert.equal(result.rule, null);
  assert.equal(result.visibleIdle, false);
});

test("rule_semantics_apply_gates_priority_and_line_regex", () => {
  const manifest = {
    id: "codex",
    rules: [
      { id: "low_contains", state: "idle", priority: 1, contains: ["match"] },
      {
        id: "high_nested_gates", state: "working", priority: 10, contains: ["match"],
        all: [{ any: [{ regex: ["w[io]n"] }, { contains: ["fallback"] }] }],
        not: [{ contains: ["blocked"] }],
      },
      { id: "line_regex", state: "blocked", priority: 20, line_regex: ["^exact line$"] },
    ],
  };
  const high = rule("match win", manifest);
  assert.equal(high.state, "working");
  assert.equal(high.rule, "high_nested_gates");

  const notGate = rule("match win blocked", manifest);
  assert.equal(notGate.state, "idle");
  assert.equal(notGate.rule, "low_contains");

  const line = rule("before\nexact line\nafter", manifest);
  assert.equal(line.state, "blocked");
  assert.equal(line.rule, "line_regex");
});

test("a priority tie goes to the rule that comes first (this project's, from manifest.rs)", () => {
  const manifest = {
    id: "codex",
    rules: [
      { id: "first", state: "idle", priority: 5, contains: ["x"] },
      { id: "second", state: "working", priority: 5, contains: ["x"] },
    ],
  };
  assert.equal(rule("x", manifest).rule, "first");
});

test("bottom_non_empty_lines_uses_bottom_occurrence_for_repeated_text", () => {
  const content = "marker\nold\n\nmiddle\nmarker\nnew\n";
  assert.equal(regionText({ screen: content }, "bottom_non_empty_lines(2)"), "marker\nnew\n");
});

test("top_non_empty_lines_uses_top_occurrence_for_repeated_text", () => {
  const content = "\nmarker\nold\n\nmiddle\nmarker\nnew\n";
  assert.equal(regionText({ screen: content }, "top_non_empty_lines(2)"), "\nmarker\nold\n");
});

test("top_non_empty_lines_requires_a_canonical_positive_bounded_count", () => {
  const content = "a\nb\n";
  assert.equal(regionText({ screen: content }, "top_non_empty_lines(1)"), "a\n");
  for (const count of ["0", "01", "+1", "65536", "999999999999999999999999"]) {
    assert.equal(regionText({ screen: content }, `top_non_empty_lines(${count})`), "", count);
  }
});

test("engine details upstream's fixtures do not pin (this project's, each read from manifest.rs)", () => {
  // A visible flag counts only when the rule's state is the flag's state.
  const mismatched = { id: "codex", rules: [{ id: "r", state: "working", priority: 1, visible_idle: true, contains: ["x"] }] };
  assert.equal(rule("x", mismatched).visibleIdle, false);
  // `str::lines` drops the empty piece after a final newline, so the last line is "b", not "".
  assert.equal(regionText({ screen: "a\nb\n" }, "bottom_lines(1)"), "b\n");
  // A horizontal rule is dashes alone, or three or more dashes followed by anything.
  assert.equal(regionText({ screen: "a\n── b\nc\n" }, "after_last_horizontal_rule"), "a\n── b\nc\n");
  assert.equal(regionText({ screen: "a\n─── b\nc\n" }, "after_last_horizontal_rule"), "c\n");
  // A codex prompt line is exactly "›" or starts with "› "; "›x" is not one.
  assert.equal(rule("do you want to continue? [y/n]\n›x\n", codex, "project").state, "blocked");
  assert.equal(rule("do you want to continue? [y/n]\n› x\n", codex, "project").state, "idle");
});

// ── the screen text itself ─────────────────────────────────────────────────────────────────────

test("screen text is trimmed rows joined by newline, trailing blank rows dropped (terminal.rs)", () => {
  assert.equal(screenText(["a  ", "", " b", "   ", ""]), "a\n\n b\n");
  assert.equal(screenText(["", "  "]), "");
  assert.equal(screenText([]), "");
});

// ── Claude ─────────────────────────────────────────────────────────────────────────────────────

test("claude_idle_prompt_with_background_shell_is_idle", () => {
  const screen = "✻ Sautéed for 10s · 1 shell still running\n\n"
    + `${"─".repeat(56)} WINDOWS ─\n`
    + "❯\n"
    + `${RULE64}\n`
    + "  ⏵⏵ auto mode on · 1 shell · ← for agents                     /rc\n";
  const result = rule(screen, claude);
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "live_prompt_box");
  assert.equal(result.visibleIdle, true);
  assert.equal(result.visibleWorking, false);
});

test("claude_background_shell_without_foreground_evidence_is_idle_fallback", () => {
  const result = rule("  ⏵⏵ auto mode on · 1 shell · ← for agents\n", claude);
  assert.equal(result.state, "idle");
  assert.equal(result.rule, null);
  assert.equal(result.visibleWorking, false);
});

test("claude_live_turn_with_background_shell_remains_working", () => {
  const screen = `${RULE64}\n❯\n${RULE64}\n  ⏵⏵ auto mode on · 1 shell · esc to interrupt\n`;
  const result = rule(screen, claude);
  assert.equal(result.state, "working");
  assert.equal(result.rule, "live_turn_working");
  assert.equal(result.visibleWorking, true);
});

test("claude_blocker_with_background_shell_remains_blocked", () => {
  const screen = "do you want to proceed?\n"
    + "bash command: rm -rf /tmp/test\n"
    + "❯ 1. Yes\n"
    + "  2. No\n\n"
    + "Esc to cancel · Tab to amend · ctrl+e to explain\n"
    + "  ⏵⏵ auto mode on · 1 shell · ← for agents\n";
  const result = rule(screen, claude);
  assert.equal(result.state, "blocked");
  assert.equal(result.rule, "bash_permission_prompt");
  assert.equal(result.visibleBlocker, true);
  assert.equal(result.visibleWorking, false);
});

test("claude_bash_prompt_with_dont_ask_again_option_matches_bash_rule", () => {
  const screen = `${RULE64}\n`
    + " Bash command\n\n"
    + "   curl -sS -o /tmp/probe.html https://example.com\n"
    + "   Download example.com to /tmp/probe.html\n\n"
    + " This command requires approval\n\n"
    + " Do you want to proceed?\n"
    + " ❯ 1. Yes\n"
    + "   2. Yes, and don't ask again for: curl *\n"
    + "   3. No\n\n"
    + " Esc to cancel · Tab to amend · ctrl+e to explain\n";
  const result = rule(screen, claude);
  assert.equal(result.state, "blocked");
  assert.equal(result.rule, "bash_permission_prompt");
  assert.equal(result.visibleBlocker, true);
});

test("claude_permission_prompt_matches_at_every_cursor_position", () => {
  const layouts = [
    [" ❯ 1. Yes", "   2. No"],
    [" ❯ 1. Yes", "   2. Yes, and don't ask again for: curl *", "   3. No"],
  ];
  for (const layout of layouts) {
    for (let selected = 0; selected < layout.length; selected += 1) {
      const options = layout.map((line, index) => {
        const bare = line.trimStart().replace(/^❯+/u, "").trimStart();
        return index === selected ? ` ❯ ${bare}` : `   ${bare}`;
      });
      const screen = `${RULE64}\n Bash command\n\n   curl -sS https://example.com\n\n`
        + ` Do you want to proceed?\n${options.join("\n")}\n\n`
        + " Esc to cancel · Tab to amend · ctrl+e to explain\n";
      const result = rule(screen, claude);
      assert.equal(result.rule, "bash_permission_prompt", `${JSON.stringify(options)} selected=${selected}`);
      assert.equal(result.state, "blocked");
      assert.equal(result.visibleBlocker, true);
    }
  }
});

test("claude_osc_title_braille_prefix_is_working", () => {
  const result = rule("", claude, "⠂ project");
  assert.equal(result.state, "working");
  assert.equal(result.rule, "osc_title_working");
  assert.equal(result.visibleWorking, true);
});

test("claude_osc_title_half_circle_frames_are_working", () => {
  for (const frame of ["◐", "◓", "◑", "◒"]) {
    const result = rule("", claude, `${frame} Initial conversation with Claude`);
    assert.equal(result.state, "working", frame);
    assert.equal(result.rule, "osc_title_working", frame);
    assert.equal(result.visibleWorking, true, frame);
  }
});

test("claude_osc_title_static_prefix_is_idle", () => {
  const result = rule("", claude, "✳ Claude Code");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_title_idle");
  assert.equal(result.visibleIdle, true);
});

test("claude_osc_progress_4_3_alone_does_not_force_working", () => {
  const result = rule("", claude, "", "4;3;");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, null);
  assert.equal(result.visibleWorking, false);
});

test("claude_blocker_screen_outranks_stale_osc_progress", () => {
  const screen = "──────────\n  1. Yes\n  2. No\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n";
  const result = rule(screen, claude, "✳ Task title", "4;3;");
  assert.equal(result.state, "blocked");
  assert.equal(result.visibleBlocker, true);
});

test("claude_osc_progress_4_0_is_idle", () => {
  const result = rule("", claude, "", "4;0;");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_progress_idle");
});

test("claude_blocker_screen_outranks_osc_idle_title", () => {
  const screen = "do you want to proceed?\nbash command: rm -rf /tmp/test\n❯ 1. Yes\n   2. No\n\n"
    + "Esc to cancel · Tab to amend · ctrl+e to explain\n";
  const result = rule(screen, claude, "✳ Claude Code");
  assert.equal(result.state, "blocked");
  assert.equal(result.visibleBlocker, true);
});

test("claude_mcp_elicitation_is_blocked", () => {
  for (const screen of [
    "MCP server \u201cmy-server\u201d requests your input\n\nGrant temporary access to the demo gateway for 15 minutes?\n\n\u276f Accept    Decline\n\nEsc to cancel \u00b7 \u2191/\u2193 to navigate\n",
    "MCP server \"my-server\" requests your input\n\nserver-supplied message\n\n\u276f Accept    Decline\n\nEsc to cancel \u00b7 \u2191/\u2193 to navigate\n",
  ]) {
    const result = rule(screen, claude, "\u2733 Claude Code");
    assert.equal(result.state, "blocked");
    assert.equal(result.visibleBlocker, true);
    assert.equal(result.rule, "mcp_elicitation_prompt");
  }
});

test("claude_empty_osc_empty_screen_is_idle_fallback", () => {
  const result = rule("", claude);
  assert.equal(result.state, "idle");
  assert.equal(result.rule, null);
  assert.equal(result.visibleIdle, false);
});

// ── Codex ──────────────────────────────────────────────────────────────────────────────────────

test("codex_osc_title_braille_spinner_is_working", () => {
  const result = rule("", codex, "⠋ llm-proxy");
  assert.equal(result.state, "working");
  assert.equal(result.rule, "osc_title_working");
  assert.equal(result.visibleWorking, true);
});

test("codex_osc_title_action_required_is_blocked", () => {
  const result = rule("", codex, "[ . ] Action Required | llm-proxy");
  assert.equal(result.state, "blocked");
  assert.equal(result.rule, "osc_title_blocked");
  assert.equal(result.visibleBlocker, true);
});

test("codex_osc_title_plain_is_idle", () => {
  const result = rule("", codex, "llm-proxy");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_title_idle");
  assert.equal(result.visibleIdle, true);
});

test("codex_trust_directory_requires_live_top_region", () => {
  const screen = "> You are in C:\\Users\\user\\project\n\n"
    + "Do you trust the contents of this\n"
    + "directory? Working with untrusted\n"
    + "contents comes with higher risk of\n"
    + "prompt injection. Trusting the\n"
    + "directory allows project-local config,\n"
    + "hooks, and exec policies to load.\n\n"
    + "› 1. Yes, continue\n"
    + "2. No, quit\n\n"
    + "Press enter to continue\n";
  let result = rule(screen, codex, "project");
  assert.equal(result.state, "blocked");
  assert.equal(result.rule, "trust_directory");
  assert.equal(result.visibleBlocker, true);

  const transcript = "› > You are in C:\\Users\\user\\project\n\n"
    + "Do you trust the contents of this\n"
    + "directory? Working with untrusted contents comes with higher risk.\n";
  result = rule(transcript, codex, "project");
  assert.equal(result.state, "idle");
  assert.notEqual(result.rule, "trust_directory");
  assert.equal(result.visibleBlocker, false);
});

test("codex_startup_update_requires_complete_live_chooser", () => {
  const chooser = "Update available! 0.153.0 -> 9.8.7\n"
    + "Run bun add -g @openai/codex to update.\n\n"
    + "› 1. Update now\n"
    + "2. Skip until next version\n\n"
    + "Press enter to continue   \n";
  const wrapped = "✨ Update available! 0.153.0\n\n"
    + "Release notes: https://example\n\n"
    + "› 1. Update now (runs `npm\n"
    + "install -g\n"
    + "@openai/codex`)\n"
    + "2. Skip\n"
    + "3. Skip until next\n"
    + "version\n\n"
    + "Press enter to continue\n";
  for (const screen of [chooser, wrapped]) {
    const result = rule(screen, codex, "project");
    assert.equal(result.state, "blocked");
    assert.equal(result.rule, "startup_update");
    assert.equal(result.visibleBlocker, true);
  }
  for (const screen of [chooser.replace("Update now", "Install"), `${wrapped}\n› Ask Codex to do anything\n`]) {
    const result = rule(screen, codex, "project");
    assert.equal(result.state, "idle");
    assert.notEqual(result.rule, "startup_update");
    assert.equal(result.visibleBlocker, false);
  }
});

test("codex_background_terminal_screen_does_not_override_osc_idle", () => {
  const result = rule("background terminal running · /ps to view · /stop to close\n", codex, "llm-proxy");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_title_idle");
  assert.equal(result.visibleIdle, true);
});

test("codex_screen_working_fallback_handles_static_osc_title", () => {
  const screen = "• I’ll run it and wait for completion.\n\n"
    + "◦ Working (1m 16s • esc to interrupt) · 1 background…\n\n"
    + "› Use /skills to list available skills\n\n"
    + "gpt-5.6-sol default · /work\n";
  const result = rule(screen, codex, "project");
  assert.equal(result.state, "working");
  assert.equal(result.rule, "screen_working_fallback");
  assert.equal(result.visibleWorking, true);
});

test("codex_osc_working_remains_preferred_over_screen_fallback", () => {
  const screen = "• Working (4s • esc to interrupt)\n\n› Use /skills to list available skills\n\ngpt-5.6-sol default · /work\n";
  const result = rule(screen, codex, "⠸ project");
  assert.equal(result.state, "working");
  assert.equal(result.rule, "osc_title_working");
  assert.equal(result.visibleWorking, true);
});

test("codex_screen_blocker_outranks_working_fallback", () => {
  const screen = "• Working (4s • esc to interrupt)\n› 1. Yes, proceed\nPress enter to confirm or esc to cancel\n";
  const result = rule(screen, codex, "project");
  assert.equal(result.state, "blocked");
  assert.equal(result.rule, "live_strong_blocker");
  assert.equal(result.visibleBlocker, true);
  assert.equal(result.visibleWorking, false);
});

test("codex_weak_blocker_without_current_prompt_is_blocked", () => {
  const result = rule("do you want to continue? [y/n]\n", codex, "project");
  assert.equal(result.state, "blocked");
  assert.equal(result.rule, "weak_blocker");
});

test("codex_current_prompt_keeps_weak_text_from_overriding_working_fallback", () => {
  const screen = "• Working (4s • esc to interrupt)\ndo you want to continue? [y/n]\n› Use /skills to list available skills\n";
  const result = rule(screen, codex, "project");
  assert.equal(result.state, "working");
  assert.equal(result.rule, "screen_working_fallback");
  assert.equal(result.visibleWorking, true);
});

test("codex_weak_blocker_ignores_finished_response_above_current_prompt", () => {
  const screen = "• The `wt rm` transcript now shows [y/N] / esc, matching the real prompt.\n\n"
    + "─ Worked for 4m 59s ─\n\n"
    + "› Ask Codex to do anything\n";
  const result = rule(screen, codex, "project");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_title_idle");
});

test("codex_weak_blocker_ignores_wrapped_current_prompt_text", () => {
  const screen = "› Explain why this prompt wraps before quoting the confirmation text\n"
    + "[y/N] / esc and whether the docs should include it\n\n"
    + "gpt-5.6-sol default · /work\n";
  const result = rule(screen, codex, "project");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_title_idle");
});

test("codex_transcript_viewer_outranks_working_fallback", () => {
  const screen = "• Working (4s • esc to interrupt)\n› transcript\n"
    + "↑/↓ to scroll · pgup/pgdn to move · home/end to jump · q to quit · esc to edit prev\n";
  const result = rule(screen, codex, "project");
  assert.equal(result.state, "unknown");
  assert.equal(result.rule, "transcript_viewer");
  assert.equal(result.skipStateUpdate, true);
  assert.equal(result.visibleWorking, false);
});

test("codex_screen_working_fallback_ignores_stale_and_prompt_text", () => {
  const screens = [
    "◦ Working (1m 16s • esc to interrupt)\n■ Conversation interrupted\n› Use /skills to list available skills\ngpt-5.6-sol default · /work\n",
    "› Explain the text ◦ Working (1m 16s • esc to interrupt)\ngpt-5.6-sol default · /work\n",
    "  ◦ Working (1m 16s • esc to interrupt)\n› Use /skills to list available skills\ngpt-5.6-sol default · /work\n",
  ];
  for (const screen of screens) {
    const result = rule(screen, codex, "project");
    assert.equal(result.state, "idle", screen);
    assert.equal(result.rule, "osc_title_idle", screen);
    assert.equal(result.visibleIdle, true);
    assert.equal(result.visibleWorking, false);
  }
});

test("codex_screen_working_fallback_ignores_interrupted_short_terminal", () => {
  const result = rule("◦ Working (1m 16s • esc to interrupt)\n■ Conversation interrupted\n›\n", codex, "project");
  assert.equal(result.state, "idle");
  assert.equal(result.rule, "osc_title_idle");
  assert.equal(result.visibleIdle, true);
  assert.equal(result.visibleWorking, false);
});

test("codex_osc_working_beats_weak_blocker_screen", () => {
  const result = rule("do you want to continue? [y/n]\n", codex, "⠋ llm-proxy");
  assert.equal(result.state, "working");
  assert.equal(result.rule, "osc_title_working");
});

// ── Hermes (this project's; upstream ships the manifest without tests) ─────────────────────────

test("hermes titles: hourglass is working, warning is blocked, check is idle, with or without a variation selector", () => {
  assert.equal(rule("", hermes, "⏳ thinking").rule, "osc_title_working");
  assert.equal(rule("", hermes, "⏳\ufe0f thinking").state, "working");
  assert.equal(rule("", hermes, "⚠\ufe0e needs approval").state, "blocked");
  assert.equal(rule("", hermes, "✓ done").rule, "osc_title_idle");
  assert.equal(rule("", hermes, "a title with ⏳ inside").state, "idle", "an unanchored glyph is not a signal");
  assert.equal(rule("", hermes, "a title with ⏳ inside").rule, null);
});

test("hermes screen: an interrupt hint in the bottom lines is working, and a stale one above them is not", () => {
  assert.equal(rule("working on it\n  ctrl+c to interrupt\n", hermes).state, "working");
  const scrolledAway = `ctrl+c to interrupt\n${"line\n".repeat(6)}`;
  assert.equal(rule(scrolledAway, hermes).state, "idle");
});
