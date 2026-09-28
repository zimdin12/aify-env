// An idle hermes prompt with background subagents, processes or /bg tasks reports `shell`, the same
// cyan state an idle Claude with a background shell reads, and nothing else does.
//
// The idle screen is comms-senior-dev's live console of 2026-09-28 (status bar and prompt, no dock).
// The dock header is the operator's screenshot of the same day, `▾ 4 live agents · +1 more · Ctrl+T
// expand · Ctrl+R collapse`, taken mid-turn with `Ctrl+C to interrupt…` in the prompt. The other dock
// lines are the strings hermes' ui-tui renders (components/agentsPanel.tsx, appLayout.tsx).

import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKGROUND_WORK_RULE, withBackgroundShell } from "../lib/plugins/aify-comms/background-shell.mjs";
import { evaluateScreen, manifestForRuntime, screenText } from "../lib/plugins/aify-comms/screen-rules.mjs";

const hermes = manifestForRuntime("hermes");
const IDLE_TITLE = "✓ aify-comms-senior-dev";
const WORKING_TITLE = "⏳ aify-comms-senior-dev";
const TRANSCRIPT = [
  "   ├─ ● Read File(\"operator_authz.py\") (4.4s)",
  "   └─ ● Skill Manage (0.3s)",
  " ┊  I sent and delivery-verified APPROVE for the c1cd1ee4 source/tag candidate through aify-comms.",
];
const STATUS_BAR = " ─ ready │ gpt 6 sol high │ 153.4k/272k │ [██████░░░░] 56% │ 3h 17m │ ✓ 2h 14m │ cmp 2 │ ◎ 95% ─  aify-comms-senior-dev #3";
const screenWith = (dock = [], { above = TRANSCRIPT, prompt = " ❯  " } = {}) => screenText([...above, "", ...dock, "", STATUS_BAR, prompt]);
const judge = (screen, title = IDLE_TITLE) => withBackgroundShell(hermes.id, evaluateScreen(hermes, { screen, title }), screen);

test("CONTROL: the live idle console, with no dock, reads idle from hermes' own title", () => {
  const verdict = judge(screenWith());
  assert.equal(verdict.state, "idle");
  assert.equal(verdict.rule, "osc_title_idle", "the idle verdict this refines must come from a matched rule");
});

test("an idle prompt with live subagents in the dock reads shell", () => {
  const verdict = judge(screenWith([
    "▾ 4 live agents · +1 more · Ctrl+T expand · Ctrl+R collapse",
    "● Independent source review of v0.7.5 compaction and turn-liveness change. 4m 49s",
    "  ↳ [set 1 · 1/4] terminal, terminal, terminal",
  ]));
  assert.equal(verdict.state, "shell");
  assert.equal(verdict.rule, BACKGROUND_WORK_RULE);
});

test("the collapsed dock, running processes and a /bg task read shell too", () => {
  for (const dock of [
    ["▸ 2 live agents · 1 procs · last: listening on :8080 · Ctrl+T expand · Ctrl+R restore"],
    ["▸ 1 procs · last: listening on :8080 · Ctrl+T expand · Ctrl+R restore"],
    ["▾ Processes · 1 running · 2 done · Ctrl+T expand · Ctrl+R collapse", "⚙ npm run dev · 42s · last: ready"],
    ["1 background task running"],
    ["3 background tasks running"],
  ]) assert.equal(judge(screenWith(dock)).state, "shell", dock[0]);
});

test("a dock holding only finished work stays idle", () => {
  // hermes keeps an exited process on the dock for 60 s (processRoster.ts PROCESS_RETAIN_SECONDS).
  for (const dock of [
    ["▸ 3 done · Ctrl+T expand · Ctrl+R restore"],
    ["▾ Processes · 2 done · Ctrl+T expand · Ctrl+R collapse", "✓ npm test · exit 0 · 12s ago"],
  ]) assert.equal(judge(screenWith(dock)).state, "idle", dock[0]);
});

test("the transcript talking about background work is not the dock", () => {
  const quoted = [
    " ┊  The dock said 4 live agents and 2 procs while I waited; 1 background task running is the /bg line.",
    " ┊  3 background tasks running in the other session",
  ];
  assert.equal(judge(screenWith([], { above: [...TRANSCRIPT, ...quoted] })).state, "idle");
  // A dock line quoted far up the transcript is out of the rows the dock can occupy.
  const farAbove = ["▾ 2 live agents · Ctrl+T expand · Ctrl+R collapse", ...Array.from({ length: 40 }, (_, i) => ` ┊  line ${i}`)];
  assert.equal(judge(screenWith([], { above: farAbove })).state, "idle");
});

// REVIEW 2026-09-28 (comms-senior-dev, REVISE of a441dab): a transcript line QUOTING the dock, glyph
// and all, sat in the last 30 rows and read as shell. These are its three counterexamples verbatim,
// beside the transcript's real shapes: `┊` answer lines, `├─` tool lines, four-space continuations.
test("a dock line quoted in the transcript near the prompt is not the dock", () => {
  for (const quoted of [
    " ┊  I copied this line: ▸ 2 live agents · 1 procs · Ctrl+T expand",
    " ┊  The screenshot said ▾ 4 live agents · Ctrl+R collapse",
    " ┊  Our log included ▾ Processes · 1 running · 2 done",
    " ┊  ▾ 4 live agents · Ctrl+T expand · Ctrl+R collapse",
    "    ▸ 2 live agents · 1 procs · Ctrl+T expand",
    "   ├─ ● Terminal(\"echo ▾ Processes · 1 running\") (0.2s)",
    "    1 background task running",
  ]) {
    const screen = screenWith([], { above: [...TRANSCRIPT, quoted] });
    assert.equal(judge(screen).rule, "osc_title_idle", `CONTROL: ${quoted} is judged on an idle screen`);
    assert.equal(judge(screen).state, "idle", quoted);
  }
});

test("the dock where hermes draws it, one column in, still reads shell", () => {
  for (const dock of [
    [" ▾ 4 live agents · +1 more · Ctrl+T expand · Ctrl+R collapse"],
    [" ▸ 2 live agents · 1 procs · last: listening on :8080 · Ctrl+T expand · Ctrl+R restore"],
    [" ▾ Processes · 1 running · 2 done · Ctrl+T expand · Ctrl+R collapse"],
    [" 1 background task running"],
  ]) assert.equal(judge(screenWith(dock)).state, "shell", dock[0]);
});

test("mid-turn with live agents is working, not shell: the screenshot's own screen", () => {
  // The turn owns the subagents here; `shell` is only for an idle prompt.
  const screen = screenWith(["▾ 4 live agents · +1 more · Ctrl+T expand · Ctrl+R collapse"], { prompt: " ❯ Ctrl+C to interrupt…" });
  const verdict = judge(screen, WORKING_TITLE);
  assert.equal(verdict.state, "working");
});
