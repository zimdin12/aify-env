// The view's SERVICES pane, moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { paint } from "../paint.mjs";
import { STATE_STYLE, heading, table, withoutLeadingEndpoint } from "../tui-parts.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, compact } = ctx;
  const lines = [];
  // ── services ────────────────────────────────────────────────────────────────────────
  if (compact) {
    // EVERY SERVICE STAYS NAMED, with its mark, so one that stopped answering is still visible.
    lines.push(heading("SERVICES", (snapshot.services ?? []).map((service) =>
      `${(STATE_STYLE[service.state] ?? STATE_STYLE.unanswered).mark} ${service.name}`).join("  ")
      || "none registered", wide, on));
  } else {
    lines.push(heading("SERVICES", "", wide, on));
    if (!snapshot.services?.length) {
      lines.push(`  ${paint("no services registered on this host", ["dim"], on)}`);
    } else {
      lines.push(...table(
        ["", "state", "name", "endpoint", "detail"],
        snapshot.services.map((service) => {
          const style = STATE_STYLE[service.state] ?? STATE_STYLE.unanswered;
          return [
            paint(style.mark, style.codes, on),
            paint(style.word, style.codes, on),
            paint(service.name, ["bold"], on),
            paint(service.endpoint, ["dim"], on),
            withoutLeadingEndpoint(service.detail, service.endpoint),
          ];
        }),
        wide, on,
      ));
    }
  }
  return lines;
}
