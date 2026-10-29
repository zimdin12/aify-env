// The panes the view can show, in their default order: the one list every layout name is checked against.
//
// THE NAMES ARE DERIVED FROM HERE, never typed elsewhere. ~/.aify/tui.json (lib/tui-layout.mjs) may only name a pane
// in this list, so a pane added here is configurable the day it lands and a name with no pane is refused.
//
// THE BLANK LINES TRAVEL WITH THE PANE. Before 0.9.6 drawDashboard put a blank line after SERVICES and HEALTH and
// before TRAFFIC, and RECENT EXITS and NOTICES drew their own. `gapAfter` and `gapBefore` keep exactly that, so the
// default order draws what it always drew and a reordered one still separates its sections once.
//
// AGENTS CANNOT BE HIDDEN: it carries the keys' hint line, the actions menu and the Ctrl+C question, and a view whose
// keys work on a list nobody can see is worse than one that shows too much.
//
// COLLAPSED, a pane is its heading line alone, marked ▸, drawn from its compact form (the one-line summaries the fitting
// pass already uses). AGENTS COLLAPSES ITSELF (`ctx.collapsed`): its table goes, and its hint line, menus and questions
// stay, because they are how the operator gets anything back.
//
// A PANE ADDED LATER CAN START COLLAPSED (`startsCollapsed`, 0.9.9): DETAIL is one heading line until `c` then `d`
// opens it, and a tui.json written before it existed gets it collapsed too (lib/tui-layout.mjs, `expanded`).
//
// ONE PANE GIVES WAY AT A TIME (`givesWay`, 0.9.10), lowest first, when the frame is taller than the terminal: it is
// drawn as one line marked ▹, "no room", which is not ▸, "collapsed". Before, every side pane went to one line at once,
// so on the operator's 129x40 pane (2026-10-29) a twenty-row ROSTER took HEALTH's FAIL rows and TRAFFIC with it and
// left 25 rows blank. HEALTH goes last: a failing check is what the view exists to show. A pane with no rank never
// gives way like this (AGENTS windows its table; NOTICES is trimmed first).
//
// AND IT STAYS UNDER WHAT IT DESCRIBES (`follows`): a `panes` order that leaves it out puts it right after the pane it
// follows, where any other left-out pane goes after everything named.

import { draw as drawServices } from "./services.mjs";
import { draw as drawHealth } from "./health.mjs";
import { draw as drawProcesses } from "./processes.mjs";
import { draw as drawDetail } from "./detail.mjs";
import { draw as drawRoster } from "./roster.mjs";
import { draw as drawExits } from "./exits.mjs";
import { draw as drawNotices } from "./notices.mjs";
import { draw as drawTraffic } from "./traffic.mjs";

export const PANES = Object.freeze([
  Object.freeze({ name: "services", draw: drawServices, gapAfter: true, givesWay: 4 }),
  Object.freeze({ name: "health", draw: drawHealth, gapAfter: true, givesWay: 6 }),
  Object.freeze({ name: "agents", draw: drawProcesses, required: true, collapsesItself: true }),
  Object.freeze({ name: "detail", draw: drawDetail, startsCollapsed: true, follows: "agents", givesWay: 5 }),
  Object.freeze({ name: "roster", draw: drawRoster, givesWay: 2 }),
  Object.freeze({ name: "exits", draw: drawExits, givesWay: 3 }),
  Object.freeze({ name: "notices", draw: drawNotices }),
  Object.freeze({ name: "traffic", draw: drawTraffic, gapBefore: true, givesWay: 1 }),
]);

/** The panes that give way for room, in the order they do: derived from `givesWay`, never listed twice. */
export const GIVES_WAY = Object.freeze(PANES.filter((pane) => Number.isInteger(pane.givesWay))
  .sort((a, b) => a.givesWay - b.givesWay).map((pane) => pane.name));
