// The view's PROCESSES pane (the agents), its menus, its hints and the processes nobody could judge, moved verbatim out of lib/tui.mjs's drawDashboard (0.9.6).

import { SHUTDOWN, quitsOnQ } from "../keys.mjs";
import { menuActionsIn } from "../menu-actions.mjs";
import { paint } from "../paint.mjs";
import { offScreenNote, startListLines } from "../start-list.mjs";
import { wrapToWidth } from "../text-width.mjs";
import { ACTION_EFFECTS, fittedHints, heading, relativeAge, table } from "../tui-parts.mjs";
import { DEFAULT_AGENT_COLUMNS, agentColumns } from "./agent-columns.mjs";
import { COLLAPSED_MARK, NO_ROOM_MARK, PANE_KEYS } from "./names.mjs";

/**
 * @param {object} snapshot  what the view draws (lib/tui.mjs, drawDashboard)
 * @param {object} ctx  {on, wide, compact, keys, view, window, startWindow, noticeLimit, endsWithHerdr}
 * @returns {string[]} lines, unclipped: drawDashboard clips every line once
 */
export function draw(snapshot, ctx) {
  const { on, wide, keys, view, window, startWindow } = ctx;
  //: WHICH COLUMNS, by name (agent-columns.mjs): the layout's normal or extended set, the normal default when none.
  const columns = agentColumns(ctx.agentColumns ?? DEFAULT_AGENT_COLUMNS.normal, keys);
  const lines = [];
  // ── processes ───────────────────────────────────────────────────────────────────────
  const owned = snapshot.processes ?? [];
  // WHAT THE OPERATOR IS MOVING THROUGH, which is the filtered list once a picker is open. The
  // HEADING still counts what this environment OWNS -- narrowing a search must not read as processes
  // having disappeared.
  const all = Array.isArray(view?.rows) ? view.rows : owned;
  // THE WINDOW IS APPLIED HERE and nowhere else. Row numbers and the cursor are both ABSOLUTE --
  // positions in the whole visible list, not in the slice -- because `view.selected` is an absolute
  // index and `keys.mjs` jumps to absolute ones. Numbering the slice from 1 instead made the cursor
  // compare a slice position against an absolute one, and the selection glyph vanished entirely at
  // 30 processes. Two coordinate systems on one row is how that happens.
  const from = window ? window.start : 0;
  const shown = window ? all.slice(window.start, window.end) : all;
  const hiddenAbove = from;
  const hiddenBelow = window ? Math.max(0, all.length - window.end) : 0;
  const picking = view?.mode === "picker";
  // THE START LIST TAKES THE TABLE'S PLACE (v0.7.7). It shows agents with no process, so the table
  // is not what the keys move through while it is open; the whole height goes to the list.
  const starting = view?.mode === "start";
  if (starting) lines.push(...startListLines(view.start, wide, on, startWindow));
  const heldCount = owned.length
    ? (picking ? `${all.length} of ${owned.length}` : `${owned.length} owned`)
    : "";
  if (!starting) lines.push(heading("PROCESSES", heldCount, wide, on));
  // THE SEARCH, ECHOED. A filter with no visible query is a screen that has silently changed what
  // every key means. The trailing block is a cursor: an empty query must still look like an open
  // prompt rather than like nothing happened.
  if (picking) {
    lines.push(`  ${paint("find", ["bold"], on)} ${paint(`${view.query ?? ""}▌`, ["bold"], on)}`
      + (shown.length ? "" : paint("   no match", ["yellow"], on)));
  }
  if (starting) {
    // Drawn above; nothing of the table under it.
  } else if (!owned.length && snapshot.answered === false) {
    // NOT EMPTY: UNKNOWN (v0.7 scan, F16). The list is empty because nothing answered, and saying
    // what this environment has or has not started would be a claim about one nobody heard from.
    // `=== false` so a snapshot built without the flag -- older callers, tests -- reads as before.
    lines.push(`  ${paint("?", ["yellow"], on)} ${paint("unknown — the environment is not answering", ["dim"], on)}`);
  } else if (!owned.length) {
    // WHICH KIND OF EMPTY. The operator hit this: an empty panel beside a dashboard listing
    // nineteen managed agents, read as a fault. It was idle -- managed workers are started on
    // demand and this environment owned nothing at that instant. The panel gave them no way to
    // tell that from a broken environment, so they reported a bug that was not one.
    //
    // Answered from this environment's OWN counters. It must not fetch a service's agent list to
    // explain itself; that inverts the boundary and was reverted once already.
    const started = snapshot.history?.startedTotal ?? 0;
    const sinceExit = relativeAge(snapshot.history?.lastExitAtMs, snapshot.nowMs);
    if (started > 0) {
      const tail = sinceExit ? `, last exited ${sinceExit}` : "";
      const text = `nothing running now — ${started} started since this environment came up${tail}`;
      lines.push(`  ${paint("idle", ["green"], on)} ${paint(text, ["dim"], on)}`);
    } else {
      // Genuinely different, and worth a different colour: nothing has ever been asked of this
      // environment. Delegation not reaching it looks exactly like this.
      const text = "nothing started since this environment came up — no spawn has reached it yet";
      lines.push(`  ${paint("◌", ["yellow"], on)} ${paint(text, ["dim"], on)}`);
    }
  } else {
    // COLLAPSED (the pane menu, 0.9.6): the table goes, and the menus, questions and hints below stay.
    if (!ctx.collapsed) lines.push(...table(
      // THE NUMBER COLUMN EXISTS BECAUSE THE HINT PROMISES IT. "1-9 jump" against a table with no
      // row numbers makes the operator count rows, which at nine agents is the work the jump was
      // supposed to remove. Shown only with a keyboard: a piped render has nothing to jump with.
      //
      // The cursor rides in the same cell rather than taking its own column. `dashboard` and `pty`
      // mode looked identical before -- nothing rendered `pane.attached` -- so an operator below the
      // pane's minimum width had no way to tell that Enter had put their keyboard inside an agent.
      // NO PHANTOM COLUMN. An empty header still costs its two-space separator, so a piped render
      // carried a dead column plus its gap on every row.
      // `out` NAMES THE DOT COLUMN, which was headed by an empty string. The operator read a grey
      // circle as "this agent is offline" and reported it as a bug: "claude agents status dot is
      // not green even tho they are online". It was not a bug -- measured 2026-09-08 against the
      // live daemon, every working row had output 0.0-1.6s old across 12 samples and the one grey
      // row had been silent 308 seconds, so the mark was right and the column was mute. A column
      // of symbols with no header invites the reader to supply their own meaning, and liveness is
      // the meaning they will reach for. This one is about OUTPUT: filled means it printed
      // something in the last three seconds, hollow means it went quiet, blank means nothing has
      // been measured yet.
      // WHICH ONES, AND IN WHAT ORDER, is the layout's (agent-columns.mjs, 0.9.6); each cell is the one drawn here before.
      columns.map((column) => column.header),
      // Named fields ONLY. `label` and `title` are strings the caller supplied and the process set, not judgements.
      //
      // TWO JUDGEMENTS, both this environment's own. The STATUS is its word for the agent (`/agents/state`): since the
      // 0.9.8 switch aify-env decides it and comms only shows it, so it is drawn in the dashboard's colour. The
      // operator, 2026-10-25: "statuses are just white dots, not yellow or cyan or blue or green or red". The
      // ACTIVITY MARK says only that the process printed in the last three seconds, which is not working.
      shown.map((proc, at) => columns.map((column) => column.cell(proc, { at: from + at, view, on, snapshot }))),
      wide, on,
    ));
    // THE ACTIONS MENU, drawn where the operator is already looking: directly under the row it acts
    // on. A modal in the middle of the screen would cover the list they used to choose the agent.
    //
    // IT NAMES ITS TARGET. "stop" with no subject is the shape of every incident where somebody
    // ended the wrong thing, and the row above may have scrolled out of the window by now.
    if (view?.mode === "menu" || (view?.mode === "confirm" && view.confirming !== SHUTDOWN)) {
      // THE BOUND TARGET, NOT THE CURSOR. The menu is about the agent it was OPENED on, and the
      // executor already resolves it that way -- but this did not, so the prompt and the action could
      // name different agents. Review measured it: after a row above it exited, the prompt read
      // "stop charlie?" while `y` stopped bravo. An operator reading the wrong name and confirming is
      // worse than either half alone, because the confirmation is the thing that is supposed to make
      // it safe.
      //
      // FALLING BACK TO THE CURSOR ONLY WHERE NOTHING IS BOUND, which is a menu that has not been
      // opened through the session -- a render test, or a caller that builds a view by hand.
      const bound = view.actionTargetId
        ? (all.find((row) => row?.id === view.actionTargetId) ?? null)
        : (all[view.selected] ?? null);
      // GONE IS SAID, not silently replaced. The executor refuses a target that has disappeared, so
      // the prompt must not offer to stop something else -- and must not read as though it will.
      const name = bound
        ? String(bound.label || bound.id)
        : (view.actionTargetId ? `${view.actionTargetId} (gone)` : "this process");
      if (view.mode === "confirm") {
        // ONE LINE, AND IT ASKS. A confirmation that scrolls is one an operator answers without
        // reading; a confirmation that states the verb and the subject is one they can refuse.
        lines.push(`  ${paint(`${view.confirming} ${name}? `, ["bold", "yellow"], on)}`
          + paint("y to confirm, any other key cancels", ["dim"], on));
        // AND WHAT IT WILL DO, which the verb alone does not say (F17). ITS OWN LINE, so a narrow
        // terminal clips the explanation and never the words that say how to refuse.
        if (ACTION_EFFECTS[view.confirming]) {
          lines.push(`    ${paint(ACTION_EFFECTS[view.confirming], ["yellow"], on)}`);
        }
      } else {
        lines.push(`  ${paint(`actions for ${name}`, ["bold"], on)}`);
        // WHAT THIS CALLER OFFERS, not the vocabulary. A row for an action nobody wired would be
        // a control that does nothing when chosen.
        for (const [at, action] of menuActionsIn(view).entries()) {
          const here = at === (view.menuAt ?? 0);
          const effect = ACTION_EFFECTS[action] ? `  — ${ACTION_EFFECTS[action]}` : "";
          const row = `${here ? "❯" : " "} ${action}${effect}`;
          lines.push(`  ${here ? paint(row, ["bold"], on) : paint(row, ["dim"], on)}`);
        }
      }
    }
    // WHAT TO PRESS, beside the thing it acts on.
    //
    // The operator ran the view, saw the table, and asked how to switch between agents -- because
    // nothing on screen said, and on the daemon's own view the answer was "you cannot". Bindings
    // that are not written down are bindings nobody has.
    //
    // ONLY WHEN THERE IS A KEYBOARD. `--once`, a pipe and a test have none, and printing keys there
    // would promise something the view cannot do. `q` appears only where quitting is offered: in the
    // daemon's terminal leaving the view would mean stopping the environment, so it is not bound.
    // WHAT IS OFF SCREEN. A table silently showing 9 of 30 agents is a table that lies by omission,
    // and the operator would arrow down past the end and see nothing move.
    lines.push(...offScreenNote(hiddenAbove, hiddenBelow, on));
  }

  // THE QUESTION Ctrl+C ASKS IN THE DAEMON'S OWN TERMINAL, drawn whether or not anything is running:
  // it is about the environment, not a row. It says what is at stake, which one keystroke used to
  // end without a word.
  if (view?.mode === "confirm" && view.confirming === SHUTDOWN) {
    const workers = `${owned.length} worker${owned.length === 1 ? "" : "s"}`;
    lines.push(`  ${paint(`stop the environment and its ${workers}? `, ["bold", "yellow"], on)}`
      + paint("y to confirm, any other key cancels", ["dim"], on));
  }

  // MODE-AWARE, because the same key does three different things. It said "enter attach" while
  // ATTACHED -- where Enter is a newline into the agent -- and while the picker was open, where
  // Enter accepts the search. A hint that is wrong two thirds of the time teaches the operator to
  // stop reading it.
  // OUTSIDE the empty check, because an IDLE environment is the state an operator is most likely
  // sitting in and it taught them nothing at all: no `g find`, no `q quit`. This file's own comment
  // says bindings that are not written down are bindings nobody has, and the emptiest screen was the
  // one enforcing that. The bindings that need a row to act on are dropped when there is none.
  // THE PANE MENU (`c`, 0.9.6), one row per pane like the actions menu, so no pane is lost to a narrow hint line: its
  // letter, ▾ open, ▸ collapsed or ▹ no room (0.9.10), and its name. Hidden panes are not offered; there is nothing on
  // screen to collapse.
  if (view?.mode === "panes") {
    lines.push(`  ${paint("panes", ["bold"], on)}`);
    for (const [name, letter] of Object.entries(PANE_KEYS)) {
      if (ctx.hiddenPanes?.has(name)) continue;
      const shut = ctx.collapsedPanes?.has(name);
      const [mark, note] = shut ? [COLLAPSED_MARK, "  collapsed"]
        : ctx.noRoom?.has(name) ? [NO_ROOM_MARK, "  no room on this screen"] : ["▾", ""];
      lines.push(`    ${paint(letter, ["bold"], on)} ${mark} ${name}${note ? paint(note, ["dim"], on) : ""}`);
    }
  }
  if (keys.enabled) {
    const key = (text) => paint(text, ["bold"], on);
    const rows_ = shown.length;
    const hints = view?.mode === "confirm"
      // NOTHING ELSE IS OFFERED HERE, because nothing else is accepted: this mode takes three keys
      // and every one that is not `y` cancels. Listing `move` or `find` would be a hint that lies.
      ? [`${key("y")} do it`, `${key("any other key")} cancel`]
      : view?.mode === "menu"
      ? [`${key("↑↓")} choose`, `${key("enter")} run it`, `${key("ctrl+]")} back`]
      : view?.mode === "pty"
      // NOT "keys go to this agent" while they are being dropped (v0.7 scan, F6).
      ? [`${key("ctrl+]")} back to the list`, view?.inputPaused
        ? `${key("input paused")} until the pane shows the agent`
        : `${key("keys")} go to this agent`]
      : view?.mode === "start"
      // ITS OWN LINE, because the keys here are not the dashboard's. An operator reading "1-9 jump"
      // while a list of agents is open would press a digit and watch nothing happen.
      ? [`${key("type")} filter`, `${key("↑↓")} choose`, `${key("enter")} start it`, `${key("tab")} herdr space`, `${key("ctrl+]")} back`]
      : view?.mode === "picker"
        ? [`${key("type")} filter`, `${key("↑↓")} move`, `${key("enter")} choose`, `${key("ctrl+]")} cancel`]
      : view?.mode === "panes"
      ? [`${key("letter")} collapses or expands that pane`, `${key("ctrl+]")} back`]
      : rows_
        ? [
          // `drop` RISES WITH DISCOVERABILITY. Arrows and digits are how every list works and go
          // first; the lettered features exist nowhere else on the screen and go last.
          `${key("↑↓")} move`,
          // ONLY WHERE THE ROWS ARE NUMBERED: a jump hint over a table with no numbers makes the operator count.
          ...(columns.some((column) => column.name === "#") ? [`${key("1-9")} jump`] : []),
          `${key("g")} find`,
          // SAYS WHAT PRESSING IT WILL DO, not what the pane currently is. "p console" would leave
          // the operator to guess which way it goes, and the pane defaults to hidden -- so the first
          // thing this hint is ever read for is finding the console, which it should answer outright.
          // NOT WHERE THERE IS NO CONSOLE: inside `herdr-aify env` every worker has its own space.
          ...(view?.withoutConsole || view?.paneDrawable === false ? [] : [
            view?.paneHidden === false ? `${key("p")} hide console` : `${key("p")} show console`,
            `${key("enter")} attach`,
          ]),
          `${key("m")} actions`,
          // SAYS WHICH WAY IT GOES, like `p`: the operator reads it to find the hidden columns.
          `${key("v")} ${ctx.extended ? "fewer" : "more"} columns`,
          // SAYS WHICH WAY IT GOES, like `v`: the order pressing it gives, not the one on screen.
          `${key("o")} by ${ctx.sort === "attention" ? "name" : "attention"}`,
          `${key("c")} panes`,
          `${key("s")} start`,
        ]
        // NOTHING SELECTED IS NOT NOTHING TO DO. With no processes the list is empty, so `find` was
        // the only thing offered -- on exactly the host where every agent needs starting. `s` is the
        // one key that acts on something the list is not showing.
        : [`${key("g")} find`, `${key("s")} start`];
    // ONLY WHERE LEAVING IS ON OFFER, and never in a mode that does something else with `q`: in the
    // pane it is the letter q, in a menu it is swallowed so the list behind cannot be acted on, and
    // at a confirmation it is one of the keys that CANCELS. Naming it in those three would be a hint
    // that lies -- which this file's own header says is how an operator learns to stop reading them.
    // ASKED OF THE ROUTER. A hand list here missed the finder, where `q` types into the search
    // (external review, T1); `the-keys-are-documented.test.js` presses every key the hint names.
    const qMeansQuit = quitsOnQ(String(view?.mode ?? "dashboard"));
    if (keys.canQuit && qMeansQuit) hints.push(`${key("q")} quit`);
    // WHERE Ctrl+C STOPS EVERYTHING, THE SCREEN SAYS SO. The daemon's own view asks first, but an
    // operator should know before pressing it what the question will be about.
    if (view?.confirmInterrupt === true && String(view?.mode ?? "dashboard") === "dashboard") {
      hints.push(`${key("ctrl+c")} stops everything`);
    }
    // WHOLE ITEMS OR NONE. See `fittedHints`: the clip at the end of drawDashboard takes the TAIL,
    // and the tail is where `q quit` sits.
    //
    // The priority is read off the hint's own text rather than carried alongside it, because a
    // parallel array of numbers is a second thing to keep in step with a list that changes per mode.
    // Anything not named here is kept as long as possible, which is the safe default: a new hint is
    // one somebody thought was worth saying.
    // THE LAST OUTCOME, ABOVE THE HINT (v0.7.7). NOTICES is the first section fitting trims, so a
    // start or stop result used to vanish at 24 rows; this line is not trimmed. NOTICES keeps the history.
    // WRAPPED, AND THE TAIL KEPT (2026-09-29): a refusal's reason is its tail, and the clip cut
    // "start of comms-senior-dev refused: …409…" before the part that said why. At most 4 lines so
    // one runaway message cannot take the agent rows; a longer one keeps its opening and its last
    // two lines and says how much it left out (review: a head-only cut hid the cause again).
    const outcome = wrapToWidth(view?.outcome, wide - 2);
    const outcomeLines = outcome.length <= 4
      ? outcome
      : [outcome[0], `… ${outcome.length - 3} lines left out …`, ...outcome.slice(-2)];
    for (const part of outcomeLines) lines.push(`  ${paint(part, ["yellow"], on)}`);
    // `v`, `o` AND `c` BEFORE `enter attach` (0.9.6 review): attaching is what the list is for, and the columns, the
    // order and the pane menu are settings an operator uses once and then remembers. Attach stays on a 100-column line in either
    // set of columns, as it was before `v` and `c`.
    const DROP_FIRST = [[" jump", 5], [" move", 4], [" columns", 3], [" name", 3], [" attention", 3], [" panes", 2], [" attach", 1]];
    const fitted = fittedHints(
      hints.map((text) => ({
        text,
        drop: (DROP_FIRST.find(([suffix]) => text.endsWith(suffix)) ?? [null, 0])[1],
      })),
      wide,
      paint("  ·  ", ["grey"], on),
    );
    lines.push(`  ${paint(fitted, ["dim"], on)}`);
  }

  if (snapshot.unknown?.length) {
    lines.push("");
    lines.push(`  ${paint(
      `${snapshot.unknown.length} process${snapshot.unknown.length === 1 ? "" : "es"} whose liveness could not be determined:`,
      ["yellow"], on)}`);
    for (const entry of snapshot.unknown) {
      lines.push(`    ${entry.id} (pid ${entry.pid}) ${paint(
        "— kept rather than reaped, on no evidence", ["dim"], on)}`);
    }
  }
  return lines;
}
