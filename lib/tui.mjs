// The view: what this environment is, what it owns, and who it can see.
//
// A pure function from a snapshot to lines. Not ceremony: it is what makes the one rule here testable
// rather than a review comment. THE VIEW MAY NOT CLAIM ANYTHING ABOUT AGENTS. aify-env knows which
// processes it started and whether they are alive; alive is not working, and an AGENT status column
// here would make this a second place answering a question that already has an owner.
//
// So the renderer reads named fields only. Handing it a snapshot with agent fields in it renders
// nothing extra, which is the difference between a boundary and a promise.
//
// ── THE ACTIVITY MARK IS THE ONE EXCEPTION, and it is drawn on the near side of that line.
//
// Added 2026-09-06 on the operator's ask: "how can i switch between agent tuis from within the
// aify-env. i asked herdr like usability" -- and the thing that makes herdr's sidebar usable at nine
// agents is that each row says whether it is doing anything.
//
// WHY IT IS NOT THE RULE ABOVE BEING BROKEN. An agent's status is a SERVICE'S JUDGEMENT, derived
// from a dispatch turn, a worker lease, a heartbeat and a screen model -- six states, computed
// somewhere that knows what an agent IS. The mark here is this daemon's OWN observation of a PTY it
// owns: bytes arrived, or they did not. It asks nobody, it names no agent concept, and it is exactly
// what herdr calls the working authority. `lib/activity.mjs` holds the derivation and the argument.
//
// IT IS A GLYPH AND NOT A WORD, deliberately. Printing `working` in a row that also carries a
// `service` column invites reading it as that service's status for that agent, which is a different
// claim computed from more evidence. A mark says "this lane is producing" and cannot be mistaken for
// a verdict. `unknown` renders as nothing at all rather than as a third symbol competing for the eye.
//
// Nothing time-derived either. A clock inside would make the view flicker for no reason and make its
// test flaky, which is the early warning that one crept in. Uptime arrives already computed.
//
// ON COLOUR AND WIDTH. Colour is a parameter, never read from the environment here, so the same
// snapshot renders identically in a test and the decision about whether a terminal wants escapes is
// made once by the caller. Every colour carries meaning -- state, or the difference between a value
// and the label naming it -- and nothing is coloured for decoration. Columns are measured from the
// content rather than padded to a guess, because a fixed width is wrong for every row that is not the
// one it was chosen for.


// MEASURING AND CUTTING TERMINAL TEXT IS ITS OWN SUBJECT, and it moved out when `width()` had to
// learn East Asian widths. Re-exported because `panes.mjs` and the pane code already import these
// names from here, and one implementation is the whole point.
import { clip, clipToWidth, pad, width } from "./text-width.mjs";
export { clip, clipToWidth, pad, width };
// THE PIECES AND THE PANES (0.9.6): the helpers live in tui-parts.mjs and each section in tui-panes/, moved verbatim.
// `shortHandle` and `ACTION_EFFECTS` stay exported from here, where their importers already look.
import { ACTION_EFFECTS, shortHandle } from "./tui-parts.mjs";
export { ACTION_EFFECTS, shortHandle };
import { draw as drawHeader } from "./tui-panes/header.mjs";
import { draw as drawServices } from "./tui-panes/services.mjs";
import { draw as drawHealth } from "./tui-panes/health.mjs";
import { draw as drawProcesses } from "./tui-panes/processes.mjs";
import { draw as drawExits } from "./tui-panes/exits.mjs";
import { draw as drawNotices } from "./tui-panes/notices.mjs";
import { draw as drawTraffic } from "./tui-panes/traffic.mjs";

/**
 * @param {{version: string, endpoint: string, terminals: {available: boolean, reason: string},
 *          services: object[], processes: object[], unknown: object[],
 *          traffic: {requests: number, bytesOut: number}}} snapshot
 * @param {{columns?: number, color?: boolean}} options
 * @returns {string[]} lines
 */
function drawDashboard(snapshot, {
  columns = 100,
  color = false,
  // WHETHER THIS VIEW HAS A KEYBOARD, and whether leaving it is a thing the caller offers. Both
  // default to OFF: `--once`, a pipe and every test render without one, and a view that advertised
  // keys it cannot receive would be worse than one that says nothing. The caller that owns the
  // terminal knows the answer to both and says so, exactly as it already does for colour and width.
  keys = { enabled: false, canQuit: false },
  // WHAT THE KEYBOARD IS CURRENTLY DOING, so the screen and the keys cannot disagree.
  //
  // The picker was invisible without this: `ConsoleSession` narrowed its own list and moved the
  // selection through it, while this function drew `snapshot.processes` unfiltered. So typing in the
  // picker changed the pane and nothing else -- no query echo, no shortened table, no cursor -- which
  // is a filter the operator cannot see working. `rows` is what they are moving through, `selected`
  // is where they are in it, and `mode` says which keys are live.
  view = null,
  //: Which slice of the process list to draw, or null for all of it. Set by the fitting pass.
  window = null,
  //: Which slice of the START list to draw, or null for all of it. Set by the same pass.
  startWindow = null,
  //: How many notice rows to draw. The fitting loop lowers this before it touches the process
  //: table, because a burst of notices must not cost the operator the agent list.
  noticeLimit = DEFAULT_NOTICE_ROWS,
  //: Whether this environment ends when its Herdr session does (a `herdr-aify env` instance).
  endsWithHerdr = false,
  //: SERVICES, HEALTH, RECENT EXITS and TRAFFIC as one line each, set by the fitting pass before it
  //: touches the agent table (v0.7.7): at 100x24 with 12 agents they left the table one row.
  compact = false,
} = {}) {
  const on = color === true;
  const lines = [];
  // THE TERMINAL'S WIDTH, not a floor under it. `Math.max(60, columns)` rendered a 60-column frame
  // into a 40-column window -- 13 of 19 lines over, every one wrapping, and one wrapped row shifts
  // every row below it out from under `frameUpdate`'s absolute addressing. A 40-column terminal is
  // not exotic; it is a split pane. Narrow is a layout to respect, not an input to override.
  const wide = Math.max(20, columns);

  const ctx = { on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr };

  lines.push(...drawHeader(snapshot, ctx));
  //: The blank lines between sections go first when collapsed; each costs a row an agent could have.
  const gap = () => { if (!compact) lines.push(""); };
  gap();

  lines.push(...drawServices(snapshot, ctx));
  gap();

  lines.push(...drawHealth(snapshot, ctx));
  gap();

  lines.push(...drawProcesses(snapshot, ctx));

  lines.push(...drawExits(snapshot, ctx));

  lines.push(...drawNotices(snapshot, ctx));

  gap();
  lines.push(...drawTraffic(snapshot, ctx));
  // ONE GUARANTEE AT THE END, rather than a budget on each of a dozen line kinds.
  //
  // Clipping line by line left whole classes unbudgeted -- the title, the health lines, the hint
  // that teaches the keys, the traffic footer -- and the TABLE could overflow even when every cell
  // was clipped, because its FIXED columns alone can exceed a narrow terminal. Measured at 40
  // columns: six lines over, from five different code paths.
  //
  // A line wider than the terminal wraps, and one wrapped row shifts every row below it out from
  // under `frameUpdate`'s absolute addressing -- so this is not cosmetic, it is the difference
  // between a diff that describes the screen and one that does not. Chasing each producer would
  // leave the next one to be found by an operator.
  return lines.map((line) => clip(line, wide));
}

//: How many notice rows a full-height view shows. TEN, because a glance panel is for noticing that
//: something is wrong, not for reading the history -- the ring behind it still holds twenty, and a
//: repeating failure is one row with a count on it either way. The operator asked for this number
//: after twenty rows left a three-agent fleet showing one.
export const DEFAULT_NOTICE_ROWS = 10;

/**
 * A slice of `total` rows, `keep` long, that contains `selected`.
 *
 * CENTRED, THEN CLAMPED. Keeping the selection in the middle means an operator arrowing down sees the
 * list move under a steady cursor rather than the cursor walking to the bottom and sticking there;
 * clamping at both ends means the first and last screens are full rather than half empty.
 */
export function windowAround(selected, total, keep) {
  const size = Math.max(1, Math.min(Math.floor(keep) || 1, total));
  const at = Number.isFinite(selected) && selected >= 0 ? Math.min(selected, total - 1) : 0;
  let start = at - Math.floor((size - 1) / 2);
  start = Math.max(0, Math.min(start, total - size));
  return { start, end: start + size };
}

/**
 * The view, guaranteed to fit the terminal it is going onto.
 *
 * THE FRAME WAS NEVER BOUNDED BY HEIGHT, and on the fleet this project actually runs that is not an
 * edge case. Measured: 30 processes on a 24-row terminal produced a 45-line frame. `frameUpdate`
 * addresses rows absolutely and the terminal clamps the cursor, so every line past 24 was written
 * onto line 24 in turn -- the bottom row churned through twenty-two different contents per poll,
 * while agents 12-30, the hint line and everything below the table never appeared at all.
 *
 * THE COST WAS THE SELECTION. With 30 agents the cursor sat on frame row 30 of 45: the operator
 * arrows down past agent 11 and NOTHING ON SCREEN MOVES. The feature this whole change exists for
 * stops working at exactly the fleet size that makes it worth having.
 *
 * MEASURED RATHER THAN PREDICTED. What else is on screen varies -- services, health rows, notices,
 * recent exits, the picker's query line -- so guessing a budget for the table would be wrong in both
 * directions. This draws, measures the overflow, and re-draws with the table narrowed by exactly
 * that much, repeating while it still does not fit. Each dropped process removes exactly one line,
 * so it converges in one step in the ordinary case; the loop is a bound, not an algorithm.
 *
 * `rows` ABSENT MEANS UNBOUNDED, which is what `--once`, a pipe and every test want: a caller that
 * does not own a screen has no height to fit, and truncating there would hide rows from a log.
 */
export function renderDashboard(snapshot, options = {}) {
  const limit = Math.floor(options.rows || 0);
  const drawn = drawDashboard(snapshot, options);
  if (!limit || drawn.length <= limit) return drawn;

  const all = Array.isArray(options.view?.rows) ? options.view.rows : (snapshot.processes ?? []);
  const start = options.view?.mode === "start" ? options.view.start : null;
  const starting = Array.isArray(start?.agents) ? start.agents.length : 0;

  // NOTICES GIVE WAY FIRST, AND ON EVERY HOST (v0.7 scan, F12). The early return for a list too short
  // to window used to sit above this loop, so an idle host -- the common case -- never trimmed its
  // notices, and the frame ran past the terminal and lost TRAFFIC off the bottom.
  //
  // They used to be untouchable while the process table absorbed the whole
  // overflow, so a burst of `output not delivered: fetch failed` -- which one restart produces in
  // seconds -- cost the operator every agent row but one. The agents are what the view is for.
  let noticeLimit = Number.isFinite(options.noticeLimit)
    ? Math.floor(options.noticeLimit)
    : DEFAULT_NOTICE_ROWS;
  let out = drawn;
  while (out.length > limit && noticeLimit > 0) {
    noticeLimit = Math.max(0, noticeLimit - (out.length - limit));
    out = drawDashboard(snapshot, { ...options, noticeLimit });
  }
  if (out.length <= limit) return out;
  // THEN THE SIDE SECTIONS COLLAPSE to one line each (v0.7.7), still before any agent row goes.
  const compact = true;
  out = drawDashboard(snapshot, { ...options, noticeLimit, compact });
  if (out.length <= limit) return out;
  // Only the table-windowing passes below need more than one row to window.
  if (all.length <= 1 && starting <= 1) return out;

  let keep = all.length;
  let window;
  // AT MOST A FEW PASSES. Narrowing the table adds one line (the "N above, N below" note) the first
  // time, so the second pass can still overshoot by one; beyond that it is converged.
  // NOT WHILE THE START LIST IS OPEN: it replaces the table, so windowing the table saves nothing.
  for (let attempt = 0; !start && all.length > 1 && attempt < 4 && out.length > limit; attempt += 1) {
    keep = Math.max(1, keep - (out.length - limit));
    window = windowAround(options.view?.selected ?? 0, all.length, keep);
    out = drawDashboard(snapshot, { ...options, noticeLimit, compact, window });
  }
  // THEN THE START LIST, the same way. It comes last because it is what the keys are moving through
  // in that mode, so it keeps its rows longest.
  let keepStart = starting;
  for (let attempt = 0; starting > 1 && attempt < 4 && out.length > limit; attempt += 1) {
    keepStart = Math.max(1, keepStart - (out.length - limit));
    out = drawDashboard(snapshot, {
      ...options, noticeLimit, compact, window, startWindow: windowAround(start.at ?? 0, starting, keepStart),
    });
  }
  return out;
}
