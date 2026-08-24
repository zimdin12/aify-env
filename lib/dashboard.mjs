// Collecting what the dashboard shows, and driving it — with no lifecycle of its own.
//
// This moved out of bin/aify-env-tui.mjs so the DAEMON can render the same view in its own terminal.
// The script version owned its refresh timer AND its SIGINT handler, and that handler called
// process.exit(0) directly. Embedding it in the daemon would have put a second exit path beside the
// one in lib/shutdown.mjs -- which is the exact defect just removed from this repo, where two handlers
// raced and the one that stopped nothing usually won.
//
// So nothing here registers a signal handler or exits. `startDashboard` returns a `stop()` and the
// caller decides what a signal means: the script exits, the daemon tears its processes down first.
//
// It computes nothing about agents. Rows are relayed from each service and attributed to it; see
// lib/agents-relay.mjs for why, and lib/tui.mjs for the assertion that a live process cannot change
// what an agent row says.

import { readFileSync } from "node:fs";

import { readServices, probeService } from "./services.mjs";
import { agentsTheServiceCallsLive, relayedAgents, remainderNote } from "./agents-relay.mjs";
import { renderDashboard } from "./tui.mjs";

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
// The agent list is ~60 KB against a health payload's ~200 bytes, and aify-comms serves it from a
// single-worker process that also derives status. Measured at ~100ms idle. Borrowing the probe budget
// made the first frame read "timed out" against a service that was answering perfectly well.
export const DEFAULT_AGENTS_TIMEOUT_MS = 6000;

/**
 * One HTTP question, with its own budget.
 *
 * Every failure is reported as a REASON rather than as an empty answer. "Did not reply" and "replied
 * with nothing" are different facts and only one of them is a statement about agents.
 */
export async function knock(url, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "TimeoutError" ? "timed out" : (error.cause?.code ?? error.message),
    };
  }
}

/**
 * Everything the view needs, gathered by asking rather than by inspecting.
 *
 * @param {{endpoint: string, registryPath: string, fetchImpl?: typeof fetch,
 *          readFile?: (p: string) => string, probeTimeoutMs?: number, agentsTimeoutMs?: number}} options
 */
export async function collectSnapshot({
  endpoint,
  registryPath,
  fetchImpl = fetch,
  readFile = (path) => readFileSync(path, "utf8"),
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  agentsTimeoutMs = DEFAULT_AGENTS_TIMEOUT_MS,
} = {}) {
  const ask = (url, timeoutMs) => knock(url, { timeoutMs, fetchImpl });
  const env = await ask(`${endpoint}/health`, probeTimeoutMs);

  let registryText = "";
  try {
    registryText = readFile(registryPath);
  } catch {
    // Absent and unreadable both mean "cannot list services here". The doctor draws that distinction;
    // a view drawing it too would be a second opinion.
    registryText = "";
  }

  const services = [];
  const agents = [];
  const agentsUnavailable = [];
  let agentsAnswered = 0;

  for (const service of readServices(registryText)) {
    const health = await ask(`${service.endpoint}/health`, probeTimeoutMs);
    const check = probeService(service, health);
    services.push({ ...service, state: check.state, detail: check.detail });

    const listed = await ask(`${service.endpoint}/api/v1/agents`, agentsTimeoutMs);
    if (!listed.ok) {
      agentsUnavailable.push({ service: service.name, reason: listed.error });
      continue;
    }
    if (listed.body === null) {
      agentsUnavailable.push({ service: service.name, reason: "answered with something unreadable" });
      continue;
    }
    agentsAnswered += 1;
    agents.push(...relayedAgents(listed.body, service.name));
  }

  // Every LIVE agent, with its mode shown, rather than managed-only. Filtering to managed renders an
  // empty view whenever delegation is off -- which is today -- while residents are working, and an
  // empty view is accurate and useless. The mode column keeps the distinction: managed is this
  // environment's business, resident connects straight to the service and is not.
  const shown = agentsTheServiceCallsLive(agents);

  return {
    version: env.ok ? env.body?.version ?? "?" : "?",
    endpoint: env.ok ? endpoint : `${endpoint} (not answering: ${env.error})`,
    terminals: env.ok
      ? { available: Boolean(env.body?.terminals), reason: "reported by the environment" }
      : { available: false, reason: "no environment answered" },
    services,
    processes: env.ok && Array.isArray(env.body?.processes) ? env.body.processes : [],
    unknown: env.ok && Array.isArray(env.body?.unknown) ? env.body.unknown : [],
    agents: shown,
    agentsAnswered,
    agentsNote: remainderNote(agents, shown),
    agentsUnavailable,
    traffic: env.ok && env.body?.traffic ? env.body.traffic : { requests: 0, bytesOut: 0 },
  };
}

/**
 * Draw once, then keep drawing.
 *
 * NO SIGNAL HANDLER AND NO EXIT. Returns `{ stop }`; what an interrupt means belongs to the caller,
 * and in the daemon it means "take the managed processes with you", which this module must not
 * pre-empt.
 *
 * @returns {Promise<{stop: () => void}>} resolved after the FIRST frame, so a caller can await a
 *   visible screen before doing anything else.
 */
export async function startDashboard({
  endpoint,
  registryPath,
  write = (text) => process.stdout.write(text),
  clearScreen = true,
  intervalMs = 2000,
  once = false,
  ...collectOptions
} = {}) {
  const draw = async () => {
    const lines = renderDashboard(
      await collectSnapshot({ endpoint, registryPath, ...collectOptions }),
    );
    // The escape is built rather than typed so a stray literal cannot end up in a piped log.
    if (clearScreen) write(`${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[H`);
    write(`${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
  };

  await draw();
  if (once) return { stop: () => {} };

  // A frame that throws must not kill the loop: the usual reason to have this open is watching for
  // the moment something comes back.
  const timer = setInterval(() => { draw().catch(() => {}); }, intervalMs);
  // Never hold the process open on its own account. A daemon exits when its own work says so.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
