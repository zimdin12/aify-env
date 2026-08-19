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
// test flaky, which is the early warning that one crept in.

const PAD = (text, width) => String(text).padEnd(width);

const STATE_MARK = {
  passed: " ok ",
  failed: "FAIL",
  unanswered: " ?? ",
};

/** Whole minutes; a view that re-renders on a second boundary is a view that never sits still. */
function uptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * @param {{version: string, endpoint: string, terminals: {available: boolean, reason: string},
 *          services: object[], processes: object[], unknown: object[],
 *          traffic: {requests: number, bytesOut: number}}} snapshot
 * @returns {string[]} lines
 */
export function renderDashboard(snapshot) {
  const lines = [];

  lines.push(`aify-env ${snapshot.version}  ${snapshot.endpoint}`);
  lines.push(
    snapshot.terminals?.available
      ? "terminals  available"
      : `terminals  UNAVAILABLE — ${snapshot.terminals?.reason ?? "unknown"}`,
  );
  lines.push("");

  lines.push("SERVICES");
  if (!snapshot.services?.length) {
    lines.push("  no services registered on this host");
  } else {
    for (const service of snapshot.services) {
      lines.push(
        `  [${STATE_MARK[service.state] ?? " ?? "}] ${PAD(service.name, 18)}`
        + `${PAD(service.endpoint, 30)}${service.state}: ${service.detail ?? ""}`,
      );
    }
  }
  lines.push("");

  lines.push("PROCESSES");
  if (!snapshot.processes?.length) {
    lines.push("  no processes owned by this environment");
  } else {
    for (const proc of snapshot.processes) {
      // Named fields ONLY. Spreading the row here is how an agent field would reach the screen.
      lines.push(
        `  ${PAD(proc.id, 6)}pid ${PAD(proc.pid, 8)}${PAD(proc.service, 18)}`
        + `${proc.terminal ? "pty " : "pipe"}  up ${uptime(proc.uptimeMs)}`,
      );
    }
  }

  if (snapshot.unknown?.length) {
    lines.push("");
    lines.push(`  ${snapshot.unknown.length} process(es) whose liveness could not be determined:`);
    for (const entry of snapshot.unknown) {
      lines.push(`    ${entry.id} (pid ${entry.pid}) — kept rather than reaped, on no evidence`);
    }
  }

  lines.push("");
  lines.push(
    `TRAFFIC  ${snapshot.traffic?.requests ?? 0} requests handled, `
    + `${snapshot.traffic?.bytesOut ?? 0} bytes streamed out (this environment's own io)`,
  );

  return lines;
}
