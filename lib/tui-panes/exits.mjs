// The view's RECENT EXITS pane, moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { paint } from "../paint.mjs";
import { clip } from "../text-width.mjs";
import { exitDescription, heading, relativeAge, table } from "../tui-parts.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, compact, window } = ctx;
  const lines = [];
  // HOW THE LAST ONES ENDED, in the window the operator is already watching.
  //
  // On 2026-08-26 seven managed workers died in two clusters and the panel above simply emptied. It
  // said WHEN the last one went and nothing about how, so the operator asked -- twice -- and every
  // answer had to be reconstructed from timestamps in another component's database. The registry
  // records the code and signal now; this puts them on screen.
  //
  // ONLY WHEN THERE IS SOMETHING TO SAY: an environment that has never lost a process shows nothing,
  // and this never grows past what the registry keeps.
  const exits = Array.isArray(snapshot.history?.recentExits) ? snapshot.history.recentExits : [];
  if (exits.length && compact) {
    const newest = exits[exits.length - 1];
    lines.push(heading("RECENT EXITS", `${exits.length} remembered · newest ${newest?.label || newest?.id || "?"}`
      + ` ${relativeAge(newest?.atMs, snapshot.nowMs)}`.trimEnd(), wide, on));
  } else if (exits.length) {
    lines.push("");
    lines.push(heading("RECENT EXITS", `${exits.length} remembered`, wide, on));
    lines.push(...table(
      ["id", "agent", "ago", "how"],
      // NEWEST FIRST here, unlike the stored order: a panel is read from the top and the death being
      // asked about is the most recent one.
      [...exits].reverse().map((exit) => [
        String(exit.id ?? ""),
        exit.label ? paint(exit.label, ["bold"], on) : paint("—", ["dim"], on),
        relativeAge(exit.atMs, snapshot.nowMs) || paint("—", ["dim"], on),
        exitDescription(exit, on),
      ]),
      wide, on,
    ));
    // THE LAST THING THE NEWEST CASUALTY SAID, on its own line because it does not fit a column.
    //
    // Only the newest, and only when there is something: an exit code cannot tell a crash from a kill
    // -- on Windows a terminated process and one that returned 1 are the same number -- and the final
    // bytes usually can. Repeating it for every row would turn a glance-panel into a log.
    const newest = [...exits].reverse().find((exit) => exit?.lastOutput);
    if (newest) {
      lines.push(`  ${paint("last words", ["dim"], on)} ${paint(
        clip(String(newest.lastOutput), Math.max(20, wide - 14)), ["dim"], on)}`);
    }
  }
  return lines;
}
