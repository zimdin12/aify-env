// The view's header (version, terminals, the Herdr warning), moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { paint } from "../paint.mjs";
import { clip } from "../text-width.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, endsWithHerdr } = ctx;
  const lines = [];
  // ── header ──────────────────────────────────────────────────────────────────────────
  // THE BUILD SITS BESIDE THE VERSION because the version alone could not answer the question it
  // was being asked. An operator restarted to pick up a shutdown fix and reported "still same old
  // version" -- correctly: `VERSION` had not changed, because a bug fix is not a release.
  //
  // ABSENT RENDERS NOTHING. A daemon too old to report a build is not a daemon with build "?", and
  // a placeholder in a field somebody is about to compare by eye is worse than a shorter line.
  const build = String(snapshot.build ?? "").trim();
  const stamp = build
    ? `aify-env ${snapshot.version} · build ${build}`
    : `aify-env ${snapshot.version}`;
  const title = paint(stamp, ["bold"], on);
  lines.push(`${title}  ${paint(snapshot.endpoint, ["dim"], on)}`);
  // AND WHICH KILL PATH, but only when it is the non-default one. `AIFY_ENV_CONPTY_DLL=1` selects the
  // node-pty backend whose `kill()` never enumerates a console, and it is set by an operator running an
  // experiment against a live fleet. An experiment whose setting cannot be observed is not an
  // experiment: setting the variable in the wrong shell looks exactly like setting it correctly and the
  // deaths continuing. Silent when off, so the normal case gains no furniture.
  const conptyNote = snapshot.terminals?.conptyDll
    ? ` ${paint("· conpty DLL backend (AIFY_ENV_CONPTY_DLL=1)", ["yellow"], on)}`
    : "";
  // CLIPPED, like every other line. A real node-pty failure reason runs to 91 columns and this line
  // had no budget at all, so it wrapped on any terminal narrower than the message.
  lines.push(clip(snapshot.terminals?.available
    ? `${paint("●", ["green"], on)} terminals available${conptyNote}`
    : `${paint("●", ["red"], on)} terminals UNAVAILABLE ${paint(
      `— ${snapshot.terminals?.reason ?? "unknown"}`, ["dim"], on)}`, wide));
  // WHAT LEAVING DOES, where it stays on screen (v0.7 scan, F21). In a `herdr-aify env` instance a
  // Herdr detach -- harmless in the resident `herdr-aify` -- ends every worker, and the launcher's
  // own warning went to stderr just before the Herdr TUI covered it.
  if (endsWithHerdr) {
    const count = (snapshot.processes ?? []).length;
    lines.push(paint(`! leaving this Herdr session ends this environment and its ${count} worker${count === 1 ? "" : "s"}`,
      ["yellow"], on));
  }
  return lines;
}
