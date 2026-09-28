// An idle prompt that still has background work running: Claude Code's background shells, hermes'
// background subagents, processes and /bg tasks.
//
// THE OPERATOR'S ASK, 2026-09-17: a status between working and online for an agent that is "basically
// running a shell", shown in cyan on every surface. Claude Code says so itself: while a background
// shell runs, its footer carries `· 1 shell ·` (cyan in its own UI), and the prompt is otherwise idle.
// 2026-09-28, for hermes, "the same cyan status rather than a new one": hermes runs every top-level
// delegation in the background (tools/delegate_tool.py) and keeps `terminal(background=true)` processes
// after the call, so its prompt is idle while its dock still counts them.
//
// AN AIFY RULE, APPLIED AFTER HERDR'S. The manifests beside this file are Herdr's, vendored with
// provenance, and Herdr has no such state, so this does not edit them. It only refines an `idle`
// verdict: a working or blocked screen is never touched.

/** The rule names reported with the state, so the service can say why an agent reads `shell`. */
export const BACKGROUND_SHELL_RULE = "aify_background_shell";
export const BACKGROUND_WORK_RULE = "aify_background_work";

/**
 * Per runtime: how many non-empty rows at the bottom of the screen are read, and what in them says
 * background work is live. Every count is at least 1, so a finished item never reads as live.
 */
const BACKGROUND_SIGNS = {
  // THE FOOTER'S SHAPE, NOT THE WORD. The transcript above the prompt also says `· 1 shell still
  // running` after a turn, and that line must not count. The footer's item is followed by another `·`
  // item or the end of the line; the transcript's is followed by "still running". The footer is the
  // last row.
  claude: { rule: BACKGROUND_SHELL_RULE, rows: 2, signs: [/·\s+[1-9]\d*\s+shells?\s*(?:·|$)/m] },
  // THE DOCK ABOVE THE PROMPT, from hermes' ui-tui (components/agentsPanel.tsx, appLayout.tsx, read
  // 2026-09-28): collapsed, one `▸ 2 live agents · 1 procs · …` line; expanded, `▾ 2 live agents · …`
  // and `▾ Processes · 1 running · 3 done` headers over at most five rows each (lib/agentRows.ts
  // PANEL_MAX_ROWS), two lines per agent; and `1 background task running` for a /bg prompt. Below it
  // sit the status rule, the composer and the status bar, so the header can be twenty-odd rows up.
  // AT THE START OF A ROW, column 0 or 1, where hermes draws the dock. The transcript can QUOTE a dock
  // line, glyphs and all, and its rows start with `┊`, `├─` or a four-space continuation, so a sign
  // matched anywhere in a row read a quote as live work (review of a441dab, 2026-09-28).
  hermes: {
    rule: BACKGROUND_WORK_RULE,
    rows: 30,
    signs: [
      /^ ?[▸▾] [1-9]\d* live agents\b/m,
      /^ ?▸ (?:[1-9]\d* live agents · )?[1-9]\d* procs\b/m,
      /^ ?▾ Processes · [1-9]\d* running\b/m,
      /^ ?[1-9]\d* background tasks? running\s*$/m,
    ],
  },
};

/** The bottom `count` non-empty lines of screen text, joined by newlines. */
function bottomLines(screen, count) {
  const lines = String(screen ?? "").split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-count).join("\n");
}

/**
 * The detection, refined: an idle screen that shows live background work becomes `shell`.
 *
 * @param manifestId  the id of the manifest that judged the screen (`claude`, `hermes`, ...)
 * @param detection   what `evaluateScreen` returned
 * @param screen      the screen text it judged
 */
export function withBackgroundShell(manifestId, detection, screen) {
  const signs = BACKGROUND_SIGNS[manifestId];
  if (!signs || detection?.state !== "idle") return detection;
  // A RULE HAD TO MATCH. `screen-rules.mjs` answers `idle` with `rule: null` when NOTHING matched,
  // which is the absence of evidence rather than a prompt -- a mid-turn repaint reads exactly like
  // that. Refining it would put a name and a state on a screen nobody recognised (external review
  // 2026-09-21, finding F).
  if (!detection.rule) return detection;
  const bottom = bottomLines(screen, signs.rows);
  if (!signs.signs.some((sign) => sign.test(bottom))) return detection;
  // `visibleIdle` IS CARRIED, NOT CLAIMED. Setting it here asserted the screen visibly showed an
  // idle prompt, which is the observer's evidence for skipping its pending-idle debounce -- so a
  // verdict that had not earned that treatment was given it, and an agent that was generating could
  // be reported as `shell` from one repaint.
  return { ...detection, state: "shell", rule: signs.rule };
}
