// The view: what this environment is, what it owns, and who it can see.
//
// A pure function from a snapshot to lines. Not ceremony: it is what makes the one rule here testable
// rather than a review comment. THE VIEW MAY NOT CLAIM ANYTHING ABOUT AGENTS. aify-env knows which
// processes it started and whether they are alive; alive is not working, and a status column here
// would make this a second place answering a question that already has an owner.
//
// So the renderer reads named fields only. Handing it a snapshot with agent fields in it renders
// nothing extra, which is the difference between a boundary and a promise.
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

/** Printable width: escapes occupy no columns, so padding must not count them. */
function width(text) {
  return String(text).replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").length;
}

/** Pad to a column width, measuring what will actually be seen. */
function pad(text, size) {
  const gap = size - width(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : String(text);
}

/** Shorten with an ellipsis rather than letting a long value break the layout. */
function clip(text, size) {
  const value = String(text ?? "");
  if (size <= 1 || value.length <= size) return value;
  return `${value.slice(0, size - 1)}…`;
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
export function renderDashboard(snapshot, { columns = 100, color = false } = {}) {
  const on = color === true;
  const lines = [];
  const wide = Math.max(60, columns);

  // ── header ──────────────────────────────────────────────────────────────────────────
  const title = paint(`aify-env ${snapshot.version}`, ["bold", "cyan"], on);
  lines.push(`${title}  ${paint(snapshot.endpoint, ["dim"], on)}`);
  lines.push(snapshot.terminals?.available
    ? `${paint("●", ["green"], on)} terminals available`
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
          service.detail ?? "",
        ];
      }),
      wide, on,
    ));
  }
  lines.push("");

  // ── processes ───────────────────────────────────────────────────────────────────────
  const owned = snapshot.processes ?? [];
  lines.push(heading("PROCESSES", owned.length ? `${owned.length} owned` : "", wide, on));
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
      ["id", "pid", "agent", "service", "io", "up", "title"],
      // Named fields ONLY. Spreading the row here is how an agent status would reach the screen --
      // `label` and `title` are strings the caller supplied and the process set, not judgements.
      owned.map((proc) => [
        paint(proc.id, ["cyan"], on),
        String(proc.pid ?? "-"),
        proc.label ? paint(proc.label, ["bold"], on) : paint("—", ["dim"], on),
        paint(proc.service ?? "", ["dim"], on),
        proc.terminal ? paint("pty", ["green"], on) : paint("pipe", ["yellow"], on),
        uptime(proc.uptimeMs),
        paint(proc.title || "", ["dim"], on),
      ]),
      wide, on,
    ));
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

  lines.push("");
  lines.push(heading("TRAFFIC", "this environment's own io", wide, on));
  lines.push(`  ${snapshot.traffic?.requests ?? 0} requests handled, `
    + `${snapshot.traffic?.bytesOut ?? 0} bytes streamed out`);

  return lines;
}
