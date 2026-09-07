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

import { activityOf, QUIET, WORKING } from "./activity.mjs";

const ESC = String.fromCharCode(27);
const SGR = {
  reset: "0", bold: "1", dim: "2",
  red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", grey: "90",
};

/** Style text, or return it untouched when colour is off. One place, so nothing leaks an escape. */
function paint(text, codes, on) {
  if (!on || !codes.length) return String(text);
  return `${ESC}[${codes.map((c) => SGR[c]).join(";")}m${text}${ESC}[${SGR.reset}m`;
}

/**
 * Printable width: escapes occupy no columns, so padding must not count them.
 *
 * EXPORTED for `panes.mjs`, which lays two views side by side and therefore has to pad the left one
 * to an exact column. A second implementation there would agree with this one until the day somebody
 * taught one of them about a new escape -- and the visible symptom would be a divider that wanders
 * by a character or two on coloured rows only, which is a maddening thing to chase.
 */
export function width(text) {
  return String(text).replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").length;
}

/** Pad to a column width, measuring what will actually be seen. Exported for the same reason. */
export function pad(text, size) {
  const gap = size - width(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : String(text);
}

/**
 * A handle, narrowed for a column, without narrowing the handle.
 *
 * A handle is `<uuid>-p<n>`: the uuid says which INSTANCE of this environment minted it, so a
 * consumer holding one across a restart cannot match a process the next instance happened to number
 * the same. Thirty-nine characters is right for identity and wrong for a table, and the fix is a
 * projection here rather than a shorter identity there -- an id trimmed to fit a column is an id that
 * collides to fit a column.
 *
 * The LAST four of the uuid, not the first: two boots differ everywhere, and the tail sits next to the
 * process number where a reader is already looking.
 *
 * THE PROJECTION IS NOT AN IDENTITY and must never be compared as one. Four hex characters collide
 * once in 65,536, which is fine for telling two rows apart on a screen and useless for deciding
 * whether two handles are the same. Nothing but the renderer may call this.
 */
export function shortHandle(id) {
  const value = String(id ?? "");
  const cut = value.lastIndexOf("-p");
  if (cut <= 0) return value;
  return `${value.slice(Math.max(0, cut - 4), cut)}${value.slice(cut)}`;
}

const SGR_PATTERN = `${ESC}\\[[0-9;]*m`;
const SGR_RESET = `${ESC}[0m`;

/**
 * Shorten to a COLUMN COUNT, without cutting an escape sequence in half.
 *
 * THE NAIVE VERSION CUT COLOURED TEXT MID-STYLE. It sliced by `.length`, and every last-column cell
 * reaches it already painted -- a process title is dim, a health detail is coloured, a notice is
 * coloured. So the opening `ESC[2m` survived the cut and its closing `ESC[0m` did not, and the dim
 * bled into every row after it. Measured across widths 55-130 against title lengths 8-60: 1855 of
 * 4028 rendered rows left an SGR open.
 *
 * It also charged the escape BYTES against the column budget, so a coloured table showed four fewer
 * characters of title than the same table with colour off -- the same snapshot measured 80 columns
 * uncoloured and 76 coloured.
 *
 * THIS IS `panes.mjs`'s `clipToWidth`, MOVED HERE rather than reimplemented. That module already had
 * the correct one, with a comment explaining this exact failure, and imported `width`/`pad` from
 * here -- so the fix could not be an import in the other direction without a cycle. One
 * implementation, beside the two functions it belongs with; `panes.mjs` now imports it back.
 */
export function clipToWidth(text, size) {
  const value = String(text ?? "");
  const budget = Math.max(0, Math.floor(size) || 0);
  if (budget === 0) return "";
  if (width(value) <= budget) return value;

  const escape = new RegExp(SGR_PATTERN, "g");
  let out = "";
  let seen = 0;
  let at = 0;
  while (at < value.length && seen < budget) {
    escape.lastIndex = at;
    const m = escape.exec(value);
    if (m && m.index === at) {
      out += m[0];               // an escape costs no columns and is copied whole
      at = escape.lastIndex;
      continue;
    }
    out += value[at];
    seen += 1;
    at += 1;
  }
  // RESET AFTER A CUT, if anything was left open. A clipped line that ends mid-colour tints every
  // row below it, the divider, and the pane beside it.
  return new RegExp(SGR_PATTERN).test(out) ? `${out}${SGR_RESET}` : out;
}

/**
 * The same cut, with an ellipsis, for a TABLE CELL.
 *
 * TWO BEHAVIOURS, NOT ONE, and conflating them broke three pane tests on the first attempt. A pane
 * LINE is truncated to fit -- it is a slice of somebody's terminal and an ellipsis would be a
 * character the process never printed. A table CELL says it was shortened, because a title cut
 * without a mark reads as the whole title.
 */
export function clip(text, size) {
  const budget = Math.max(0, Math.floor(size) || 0);
  const value = String(text ?? "");
  if (budget === 0) return "";
  if (width(value) <= budget) return value;
  return `${clipToWidth(value, Math.max(0, budget - 1))}…`;
}

// A GLYPH AND THE WORD, never the glyph alone. Colour and shape both fail -- a piped view, a
// colour-blind reader, a terminal without the font -- and the distinction between "did not answer" and
// "answered badly" is the one a viewer acts on: silent may mean switched off, and showing it as broken
// sends somebody to debug a service that is simply not running today.
const STATE_STYLE = {
  passed: { mark: "●", word: "ok", codes: ["green"] },
  failed: { mark: "●", word: "failed", codes: ["red"] },
  unanswered: { mark: "◌", word: "unanswered", codes: ["yellow"] },
};

/**
 * The activity mark for one row: producing, quiet, or nothing measured.
 *
 * NOTHING AT ALL FOR `unknown`, rather than a third symbol. A process that has not emitted yet and a
 * daemon too old to report the field are both "no evidence", and a glyph for that would compete for
 * the eye with the two that mean something. The column still holds its width, so the table does not
 * jump when a lane's first frame arrives.
 */
/**
 * The row's number, and whether the keyboard is sitting on it.
 *
 * `❯` MEANS SELECTED AND `▶` MEANS ATTACHED, and the difference is the one an operator most needs:
 * attached, every subsequent keystroke -- Ctrl+C included -- goes into a live agent's PTY. Nothing
 * said so before, because `pane.attached` had no reader and the pane itself is hidden below 80
 * columns, so a narrow terminal gave no signal at all that Enter had handed the keyboard away.
 *
 * PAST NINE THERE IS NO NUMBER, because there is no key to press. Printing `10` beside rows nothing
 * can jump to would promise a binding that does not exist.
 */
function rowMarker(at, view, on) {
  const selected = at === view?.selected;
  const cursor = selected ? (view?.mode === "pty" ? "▶" : "❯") : " ";
  const number = at < 9 ? String(at + 1) : " ";
  const text = `${cursor}${number}`;
  return selected ? paint(text, [view?.mode === "pty" ? "green" : "cyan", "bold"], on) : paint(text, ["dim"], on);
}

function activityMark(state, on) {
  if (state === WORKING) return paint("●", ["green"], on);
  if (state === QUIET) return paint("○", ["grey"], on);
  return " ";
}

/** Whole minutes; a view that re-renders on a second boundary is a view that never sits still. */
function uptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * How long ago, in words. Null when there is no timestamp OR no reference point -- a view that
 * invents "just now" from a missing clock is worse than one that says nothing.
 *
 * The reference time is PASSED IN for the same reason uptime arrives pre-computed: a clock inside a
 * renderer makes the same snapshot render differently in a test than on a screen.
 */
function relativeAge(atMs, nowMs) {
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null;
  const seconds = Math.floor((nowMs - atMs) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
}

/**
 * A section heading with a rule to the full width, so sections separate without boxing everything.
 */
/**
 * One phrase for how a process ended, and the three answers stay apart.
 *
 * A SIGNAL means something killed it, and is worth the operator's attention -- painted, not dimmed.
 * A CODE means it stopped on its own; zero is a clean exit and the most common value there is, so it
 * is reported rather than dropped by a truthiness test. NEITHER means nobody observed the exit -- a
 * reaper found a corpse, or a caller asked for a stop -- and saying so plainly is the honest answer,
 * not a gap to fill with a zero.
 */
function exitDescription(exit, on) {
  const signal = String(exit?.exitSignal ?? "").trim();
  if (signal) return paint(`killed by ${signal}`, ["red"], on);
  const code = exit?.exitCode;
  if (code === null || code === undefined) {
    // NOT A BLANK. The first real reading of this panel showed two deaths as "no exit reported",
    // which already proved they were REMOVED rather than observed exiting -- a process that ends on
    // its own always arrives through the close event with a code or a signal. What it could not say
    // was by whom, and "somebody asked for a stop" and "the sweep found a corpse" are different
    // incidents. So the reason is the answer here, not a footnote.
    const reason = String(exit?.reason ?? "");
    if (reason === "stopped") return paint("stopped on request", ["yellow"], on);
    if (reason === "reaped") return paint("found already gone", ["yellow"], on);
    return paint("no exit reported", ["dim"], on);
  }
  return Number(code) === 0
    ? paint("exited cleanly (0)", ["dim"], on)
    : paint(`exited ${Number(code)}`, ["yellow"], on);
}

/**
 * A service's detail, minus the endpoint this row has already drawn in its own column.
 *
 * `probeService` builds "<endpoint> reports healthy version 0.6.1 build b7d77fdf", and it is RIGHT
 * to: `aify-env doctor` prints the same string with no endpoint column, so the address has to be in
 * the sentence there. Here it is the fourth column of the same row.
 *
 * IT COSTS THE INFORMATION, NOT JUST THE SPACE. `table` gives the LAST column whatever width is
 * left and clips it, so on a narrow terminal the part that gets cut is the version and build --
 * exactly what somebody checking whether a deploy landed is reading the row for -- while the
 * duplicate address survives. Twenty-two characters of `http://127.0.0.1:8800 ` in front of it.
 *
 * PREFIX ONLY, deliberately. The unanswered details read "no answer from <endpoint>: ECONNREFUSED",
 * where the address is inside a sentence; cutting it there would leave "no answer from : ..." and
 * trade a duplicate for a mangling.
 */
function withoutLeadingEndpoint(detail, endpoint) {
  const text = String(detail ?? "");
  const address = String(endpoint ?? "");
  if (!address || !text.startsWith(`${address} `)) return text;
  return text.slice(address.length + 1);
}

function heading(title, note, columns, on) {
  const label = paint(title, ["bold"], on);
  const tail = note ? ` ${paint(note, ["dim"], on)}` : "";
  const used = width(label) + width(tail) + 1;
  const rule = columns > used ? paint("─".repeat(columns - used), ["grey"], on) : "";
  return `${label}${tail} ${rule}`;
}

/**
 * Render aligned rows under dim headers. Widths come from the content, and the LAST column absorbs
 * whatever is left so a long detail truncates instead of wrapping.
 */
function table(headers, rows, columns, on) {
  if (!rows.length) return [];
  const sizes = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => width(String(r[i] ?? "")))));
  // Two spaces between columns; the last one takes the remainder.
  const fixed = sizes.slice(0, -1).reduce((sum, s) => sum + s + 2, 0);
  const last = Math.max(8, columns - fixed - 2);
  const out = [`  ${headers.map((h, i) =>
    paint(pad(h.toUpperCase(), i === headers.length - 1 ? h.length : sizes[i]), ["dim"], on),
  ).join("  ")}`];
  for (const row of rows) {
    const cells = row.map((cell, i) => (i === headers.length - 1
      ? clip(String(cell ?? ""), last)
      : pad(String(cell ?? ""), sizes[i])));
    out.push(`  ${cells.join("  ")}`);
  }
  return out;
}

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
} = {}) {
  const on = color === true;
  const lines = [];
  const wide = Math.max(60, columns);

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
  const title = paint(stamp, ["bold", "cyan"], on);
  lines.push(`${title}  ${paint(snapshot.endpoint, ["dim"], on)}`);
  // AND WHICH KILL PATH, but only when it is the non-default one. `AIFY_ENV_CONPTY_DLL=1` selects the
  // node-pty backend whose `kill()` never enumerates a console, and it is set by an operator running an
  // experiment against a live fleet. An experiment whose setting cannot be observed is not an
  // experiment: setting the variable in the wrong shell looks exactly like setting it correctly and the
  // deaths continuing. Silent when off, so the normal case gains no furniture.
  const conptyNote = snapshot.terminals?.conptyDll
    ? ` ${paint("· conpty DLL backend (AIFY_ENV_CONPTY_DLL=1)", ["yellow"], on)}`
    : "";
  lines.push(snapshot.terminals?.available
    ? `${paint("●", ["green"], on)} terminals available${conptyNote}`
    : `${paint("●", ["red"], on)} terminals UNAVAILABLE ${paint(
      `— ${snapshot.terminals?.reason ?? "unknown"}`, ["dim"], on)}`);
  lines.push("");

  // ── services ────────────────────────────────────────────────────────────────────────
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
  lines.push("");

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
  lines.push("");

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
  const heldCount = owned.length
    ? (picking ? `${all.length} of ${owned.length}` : `${owned.length} owned`)
    : "";
  lines.push(heading("PROCESSES", heldCount, wide, on));
  // THE SEARCH, ECHOED. A filter with no visible query is a screen that has silently changed what
  // every key means. The trailing block is a cursor: an empty query must still look like an open
  // prompt rather than like nothing happened.
  if (picking) {
    lines.push(`  ${paint("find", ["bold"], on)} ${paint(`${view.query ?? ""}▌`, ["cyan"], on)}`
      + (shown.length ? "" : paint("   no match", ["yellow"], on)));
  }
  if (!owned.length) {
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
    lines.push(...table(
      // THE NUMBER COLUMN EXISTS BECAUSE THE HINT PROMISES IT. "1-9 jump" against a table with no
      // row numbers makes the operator count rows, which at nine agents is the work the jump was
      // supposed to remove. Shown only with a keyboard: a piped render has nothing to jump with.
      //
      // The cursor rides in the same cell rather than taking its own column. `dashboard` and `pty`
      // mode looked identical before -- nothing rendered `pane.attached` -- so an operator below the
      // pane's minimum width had no way to tell that Enter had put their keyboard inside an agent.
      [keys.enabled ? "#" : "", "", "id", "pid", "agent", "service", "io", "up", "title"],
      // Named fields ONLY. Spreading the row here is how an agent status would reach the screen --
      // `label` and `title` are strings the caller supplied and the process set, not judgements.
      //
      // THE ONE JUDGEMENT IS THE ACTIVITY MARK, and it is this environment's OWN observation: it
      // started the process and every byte it emits passes through this daemon. That is not asking
      // a service what its agents are doing, which is the boundary the header of this file draws.
      // It is deliberately not a word: `working` beside a `service` column invites reading it as
      // the service's own agent status, which is a different thing computed from more evidence.
      shown.map((proc, at) => [
        keys.enabled ? rowMarker(from + at, view, on) : "",
        activityMark(activityOf(proc, snapshot.nowMs), on),
        paint(shortHandle(proc.id), ["cyan"], on),
        String(proc.pid ?? "-"),
        proc.label ? paint(proc.label, ["bold"], on) : paint("—", ["dim"], on),
        paint(proc.service ?? "", ["dim"], on),
        proc.terminal ? paint("pty", ["green"], on) : paint("pipe", ["yellow"], on),
        uptime(proc.uptimeMs),
        paint(proc.title || "", ["dim"], on),
      ]),
      wide, on,
    ));
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
    if (hiddenAbove || hiddenBelow) {
      const parts = [];
      if (hiddenAbove) parts.push(`${hiddenAbove} above`);
      if (hiddenBelow) parts.push(`${hiddenBelow} below`);
      lines.push(`  ${paint(`… ${parts.join(", ")} — the window follows the selection`, ["dim"], on)}`);
    }
  }

  // MODE-AWARE, because the same key does three different things. It said "enter attach" while
  // ATTACHED -- where Enter is a newline into the agent -- and while the picker was open, where
  // Enter accepts the search. A hint that is wrong two thirds of the time teaches the operator to
  // stop reading it.
  // OUTSIDE the empty check, because an IDLE environment is the state an operator is most likely
// sitting in and it taught them nothing at all: no `g find`, no `q quit`. This file's own comment
// says bindings that are not written down are bindings nobody has, and the emptiest screen was the
// one enforcing that. The bindings that need a row to act on are dropped when there is none.
if (keys.enabled) {
    const key = (text) => paint(text, ["bold"], on);
  const rows_ = shown.length;
  const hints = view?.mode === "pty"
      ? [`${key("ctrl+]")} back to the list`, `${key("keys")} go to this agent`]
      : view?.mode === "picker"
        ? [`${key("type")} filter`, `${key("↑↓")} move`, `${key("enter")} choose`, `${key("ctrl+]")} cancel`]
      : rows_
        ? [
          `${key("↑↓")} move`,
          `${key("1-9")} jump`,
          `${key("g")} find`,
          `${key("enter")} attach`,
        ]
        : [`${key("g")} find`];
    // ONLY WHERE LEAVING IS ON OFFER, and never while attached: in the pane `q` is the letter q.
    if (keys.canQuit && view?.mode !== "pty") hints.push(`${key("q")} quit`);
    lines.push(`  ${paint(hints.join(paint("  ·  ", ["grey"], on)), ["dim"], on)}`);
  }

  if (snapshot.unknown?.length) {
    lines.push("");
    lines.push(`  ${paint(
      `${snapshot.unknown.length} process(es) whose liveness could not be determined:`,
      ["yellow"], on)}`);
    for (const entry of snapshot.unknown) {
      lines.push(`    ${entry.id} (pid ${entry.pid}) ${paint(
        "— kept rather than reaped, on no evidence", ["dim"], on)}`);
    }
  }

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
  if (exits.length) {
    lines.push("");
    lines.push(heading("RECENT EXITS", `${exits.length} remembered`, wide, on));
    lines.push(...table(
      ["id", "agent", "ago", "how"],
      // NEWEST FIRST here, unlike the stored order: a panel is read from the top and the death being
      // asked about is the most recent one.
      [...exits].reverse().map((exit) => [
        paint(exit.id ?? "", ["cyan"], on),
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
  const notices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
  if (notices.length) {
    lines.push("");
    lines.push(heading("NOTICES", `${notices.length} recent`, wide, on));
    lines.push(...table(
      ["ago", "n", "message"],
      // NEWEST FIRST: a panel is read from the top and the message being asked about is the last one.
      [...notices].reverse().map((notice) => [
        relativeAge(notice.atMs, snapshot.nowMs) || paint("—", ["dim"], on),
        notice.count > 1 ? paint(`x${notice.count}`, ["yellow"], on) : paint("—", ["dim"], on),
        paint(String(notice.text ?? ""), ["yellow"], on),
      ]),
      wide, on,
    ));
  }

  lines.push("");
  lines.push(heading("TRAFFIC", "this environment's own io", wide, on));
  lines.push(`  ${snapshot.traffic?.requests ?? 0} requests handled, `
    + `${snapshot.traffic?.bytesOut ?? 0} bytes streamed out`);

  return lines;
}

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
  if (all.length <= 1) return drawn;

  let keep = all.length;
  let out = drawn;
  // AT MOST A FEW PASSES. Narrowing the table adds one line (the "N above, N below" note) the first
  // time, so the second pass can still overshoot by one; beyond that it is converged.
  for (let attempt = 0; attempt < 4 && out.length > limit; attempt += 1) {
    keep = Math.max(1, keep - (out.length - limit));
    out = drawDashboard(snapshot, {
      ...options,
      window: windowAround(options.view?.selected ?? 0, all.length, keep),
    });
  }
  return out;
}
