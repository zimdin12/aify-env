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

import { draw as drawServices } from "./services.mjs";
import { draw as drawHealth } from "./health.mjs";
import { draw as drawProcesses } from "./processes.mjs";
import { draw as drawExits } from "./exits.mjs";
import { draw as drawNotices } from "./notices.mjs";
import { draw as drawTraffic } from "./traffic.mjs";

export const PANES = Object.freeze([
  Object.freeze({ name: "services", draw: drawServices, gapAfter: true }),
  Object.freeze({ name: "health", draw: drawHealth, gapAfter: true }),
  Object.freeze({ name: "agents", draw: drawProcesses, required: true, collapsesItself: true }),
  Object.freeze({ name: "exits", draw: drawExits }),
  Object.freeze({ name: "notices", draw: drawNotices }),
  Object.freeze({ name: "traffic", draw: drawTraffic, gapBefore: true }),
]);
