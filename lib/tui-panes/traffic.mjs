// The view's TRAFFIC footer, moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { heading } from "../tui-parts.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, compact } = ctx;
  const lines = [];
  const traffic = `${snapshot.traffic?.requests ?? 0} requests handled, `
    + `${snapshot.traffic?.bytesOut ?? 0} bytes streamed out`;
  if (compact) {
    lines.push(heading("TRAFFIC", traffic, wide, on));
  } else {
    lines.push(heading("TRAFFIC", "this environment's own io", wide, on));
    lines.push(`  ${traffic}`);
  }
  return lines;
}
