// The view's HEALTH pane, moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { paint } from "../paint.mjs";
import { heading, table } from "../tui-parts.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, compact, view } = ctx;
  const lines = [];
  // ── health ──────────────────────────────────────────────────────────────────────────
  //
  // A3, the operator, 2026-08-24: the TUI should show what the doctor shows. It could not, because
  // the doctor's collection lived inside a script and there was nothing to call; it now lives in
  // `lib/environment-report.mjs` and the snapshot carries its verdicts.
  //
  // RENDERED, NOT RE-JUDGED. The state and the words are the doctor's. A view that decided for
  // itself whether a check counted would be a second opinion, and the operator would then have two
  // tools that can disagree about one host -- which is the failure this repo has spent a night on
  // in three other forms.
  const checks = snapshot.checks ?? [];
  const failing = checks.filter((c) => c.state !== "passed");
  if (compact) {
    // THE COUNTS OF WHAT IS WRONG STAY, so a problem still shows on the one line.
    const failed = failing.filter((c) => c.state === "failed").length;
    const problems = [failed ? `${failed} failed` : "", failing.length - failed ? `${failing.length - failed} unknown` : ""]
      .filter(Boolean).join(", ");
    lines.push(heading("HEALTH", checks.length
      ? `${checks.length - failing.length}/${checks.length} passing${problems ? ` · ${problems}` : ""}`
      : "not collected", wide, on));
  } else {
    lines.push(heading(
      "HEALTH",
      checks.length ? `${checks.length - failing.length}/${checks.length} passing` : "",
      wide, on,
    ));
    if (!checks.length) {
      // NOT COLLECTED is not the same as HEALTHY, and rendering nothing would read as the second.
      lines.push(`  ${paint("not collected — this view could not run the checks", ["dim"], on)}`);
    } else if (!failing.length) {
      lines.push(`  ${paint("all checks pass", ["green"], on)}`);
    } else {
      // ONLY WHAT IS WRONG. A full pass list is eight rows of noise on a screen whose whole job is to
      // show what needs attention; the count above says the rest are fine, and `aify-env doctor` is
      // there for the reader who wants every row.
      lines.push(...table(
        ["", "check", "detail"],
        failing.map((check) => [
          check.state === "failed"
            ? paint("FAIL", ["bold", "red"], on)
            : paint("??", ["yellow"], on),
          paint(String(check.id ?? ""), ["bold"], on),
          paint(String(check.detail ?? ""), ["dim"], on),
        ]),
        wide, on,
      ));
    }
  }
  return lines;
}
