// An idle Claude Code prompt that still has background shells running.
//
// THE OPERATOR'S ASK, 2026-09-17: a status between working and online for an agent that is "basically
// running a shell", shown in cyan on every surface. Claude Code says so itself: while a background
// shell runs, its footer carries `· 1 shell ·` (cyan in its own UI), and the prompt is otherwise idle.
//
// AN AIFY RULE, APPLIED AFTER HERDR'S. The manifests beside this file are Herdr's, vendored with
// provenance, and Herdr has no such state, so this does not edit them. It only refines an `idle`
// verdict: a working or blocked screen is never touched.
//
// THE FOOTER'S SHAPE, NOT THE WORD. The transcript above the prompt also says `· 1 shell still
// running` after a turn, and that line must not count. The footer's item is followed by another `·`
// item or the end of the line; the transcript's is followed by "still running".

/** The rule name reported with the state, so the service can say why an agent reads `shell`. */
export const BACKGROUND_SHELL_RULE = "aify_background_shell";

/** How many non-empty rows at the bottom of the screen are read: the footer is the last one. */
const FOOTER_ROWS = 2;
const FOOTER_SHELLS = /·\s+[1-9]\d*\s+shells?\s*(?:·|$)/m;

/** The bottom `count` non-empty lines of screen text, joined by newlines. */
function bottomLines(screen, count) {
  const lines = String(screen ?? "").split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-count).join("\n");
}

/**
 * The detection, refined: an idle Claude screen whose footer shows background shells becomes `shell`.
 *
 * @param manifestId  the id of the manifest that judged the screen (`claude`, `codex`, ...)
 * @param detection   what `evaluateScreen` returned
 * @param screen      the screen text it judged
 */
export function withBackgroundShell(manifestId, detection, screen) {
  if (manifestId !== "claude" || detection?.state !== "idle") return detection;
  // A RULE HAD TO MATCH. `screen-rules.mjs` answers `idle` with `rule: null` when NOTHING matched,
  // which is the absence of evidence rather than a prompt -- a mid-turn repaint reads exactly like
  // that. Refining it would put a name and a state on a screen nobody recognised (external review
  // 2026-09-21, finding F).
  if (!detection.rule) return detection;
  if (!FOOTER_SHELLS.test(bottomLines(screen, FOOTER_ROWS))) return detection;
  // `visibleIdle` IS CARRIED, NOT CLAIMED. Setting it here asserted the screen visibly showed an
  // idle prompt, which is the observer's evidence for skipping its pending-idle debounce -- so a
  // verdict that had not earned that treatment was given it, and an agent that was generating could
  // be reported as `shell` from one repaint.
  return { ...detection, state: "shell", rule: BACKGROUND_SHELL_RULE };
}
