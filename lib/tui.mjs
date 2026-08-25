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
 * A section heading with a rule to the full width, so sections separate without boxing everything.
 */
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
    lines.push(`  ${paint("no processes owned by this environment", ["dim"], on)}`);
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

  lines.push("");
  lines.push(heading("TRAFFIC", "this environment's own io", wide, on));
  lines.push(`  ${snapshot.traffic?.requests ?? 0} requests handled, `
    + `${snapshot.traffic?.bytesOut ?? 0} bytes streamed out`);

  return lines;
}
