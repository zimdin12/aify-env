// The view's NOTICES pane, moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { paint } from "../paint.mjs";
import { heading, relativeAge, table } from "../tui-parts.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, view, noticeLimit } = ctx;
  const lines = [];
  // ── notices ─────────────────────────────────────────────────────────────────────────
  //
  // WHAT THE DAEMON HAS TO SAY, on the screen instead of through it. Reported by the operator
  // 2026-09-04: the plugin log sink wrote to stderr while this view wrote frames to stdout, and
  // `frameUpdate` addresses rows by cursor position -- so three `output not delivered: fetch failed`
  // lines landed between the header and the PROCESSES table and took the layout apart with them.
  //
  // ONLY WHEN THERE IS SOMETHING TO SAY, like RECENT EXITS above: a quiet environment shows no
  // section rather than an empty one. The COUNT is why this is readable at all -- the failure that
  // prompted it repeats every poll, so one row with "x37" carries what thirty-seven rows would.
  //
  // AND THEY YIELD SPACE BEFORE THE PROCESSES DO. The fitting loop below used to shrink only the
  // process table, so twenty notice rows -- which one failing poll produces in seconds -- pushed a
  // whole fleet down to a single line. The operator's words: "i would rather see more agents and less
  // notices, most useful thing in this is that i see what agent is working and what not." A repeating
  // failure is already one row with an `x38` on it; the agents are the reason the view is open.
  const allNotices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
  const noticeRoom = Math.max(0, Math.floor(noticeLimit) || 0);
  // NEWEST FIRST, so the cap keeps the ones being asked about rather than the oldest.
  const notices = [...allNotices].reverse().slice(0, noticeRoom);
  if (notices.length) {
    lines.push("");
    lines.push(heading(
      "NOTICES",
      allNotices.length > notices.length
        ? `${notices.length} of ${allNotices.length}`
        : `${notices.length} recent`,
      wide, on,
    ));
    lines.push(...table(
      ["ago", "n", "message"],
      notices.map((notice) => [
        relativeAge(notice.atMs, snapshot.nowMs) || paint("—", ["dim"], on),
        notice.count > 1 ? paint(`x${notice.count}`, ["yellow"], on) : paint("—", ["dim"], on),
        paint(String(notice.text ?? ""), ["yellow"], on),
      ]),
      wide, on,
    ));
  }
  return lines;
}
