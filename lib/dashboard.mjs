// Collecting what the dashboard shows, and driving it — with no lifecycle of its own.
//
// This moved out of bin/aify-env-tui.mjs so the DAEMON can render the same view in its own terminal.
// The script version owned its refresh timer AND its SIGINT handler, and that handler called
// process.exit(0) directly. Embedding it in the daemon would have put a second exit path beside the
// one in lib/shutdown.mjs -- the exact defect removed from this repo today, where two handlers raced
// and the one that stopped nothing usually won.
//
// So nothing here registers a signal handler or exits. `startDashboard` returns a `stop()` and the
// caller decides what a signal means: the script exits, the daemon tears its processes down first.
//
// IT ASKS A SERVICE EXACTLY ONE QUESTION: are you answering. Operator ruling, 2026-08-24 -- "aify-env
// should not ask stuff from aify-comms, there should not be requirement, it is not aify-env's
// concern." A first version of this file fetched each service's AGENT LIST to display, which inverted
// the rule in docs/AIFY_ENV_BOUNDARY.md: a managed-agent list may show what aify-env OWNS, annotated
// by what a service reports, and what I built was a list of the service's agents instead. Reachability
// stays because the registry is this environment's own and "which services are registered and
// answering" is assigned to it; the domain data behind those services is not.
//
// The consequence is deliberate: what this view shows about running work is aify-env's PROCESS list,
// which is ground truth because it started them. That list is empty until spawning is delegated here.

import { readFileSync } from "node:fs";

import { readServices, probeService } from "./services.mjs";
import { renderDashboard } from "./tui.mjs";

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/**
 * One HTTP question, with its own budget.
 *
 * Every failure is reported as a REASON rather than as an empty answer. "Did not reply" and "replied
 * with nothing" are different facts, and a view that renders them the same way is lying about one.
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
 * Everything the view needs: this environment's own state, plus whether each registered service is
 * answering. Nothing about what those services contain.
 *
 * @param {{endpoint: string, registryPath: string, fetchImpl?: typeof fetch,
 *          readFile?: (p: string) => string, probeTimeoutMs?: number}} options
 */
export async function collectSnapshot({
  endpoint,
  registryPath,
  fetchImpl = fetch,
  readFile = (path) => readFileSync(path, "utf8"),
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  // Injected rather than called inline, so a test can pin the moment and assert the exact words.
  nowMs = () => Date.now(),
} = {}) {
  const ask = (url) => knock(url, { timeoutMs: probeTimeoutMs, fetchImpl });
  const env = await ask(`${endpoint}/health`);

  let registryText = "";
  try {
    registryText = readFile(registryPath);
  } catch {
    // Absent and unreadable both mean "cannot list services here". The doctor draws that distinction;
    // a view drawing it too would be a second opinion.
    registryText = "";
  }

  const services = [];
  for (const service of readServices(registryText)) {
    const check = probeService(service, await ask(`${service.endpoint}/health`));
    services.push({ ...service, state: check.state, detail: check.detail });
  }

  return {
    version: env.ok ? env.body?.version ?? "?" : "?",
    // Empty, never "?", when the daemon reports none: an older daemon has no build to give, and
    // the banner renders nothing rather than a placeholder that looks like a value.
    build: env.ok ? String(env.body?.build ?? "") : "",
    endpoint: env.ok ? endpoint : `${endpoint} (not answering: ${env.error})`,
    // PASSED THROUGH, NOT REBUILT. This read `available: Boolean(env.body?.terminals)` -- and
    // `env.body.terminals` is an OBJECT, `{available, reason, conptyDll}`, so `Boolean` of it is
    // ALWAYS TRUE. The panel said "terminals available" on a host reporting terminals UNAVAILABLE,
    // which is precisely the reading the boot line exists to prevent: every console renders nothing
    // and the one indicator says the machine is fine. It also discarded the real `reason` in favour
    // of the phrase "reported by the environment", which is not a reason, and dropped `conptyDll`
    // entirely -- so an operator running the conpty-DLL experiment could not see it had taken.
    //
    // Found 2026-08-26 when the flag was live on /health and the panel showed nothing.
    terminals: env.ok && env.body?.terminals && typeof env.body.terminals === "object"
      ? {
        available: env.body.terminals.available === true,
        reason: String(env.body.terminals.reason ?? ""),
        conptyDll: env.body.terminals.conptyDll === true,
      }
      : {
        available: false,
        reason: env.ok ? "the environment reported no terminal support block" : "no environment answered",
      },
    services,
    // GROUND TRUTH, and the only thing here that says what is running: this environment started these.
    processes: env.ok && Array.isArray(env.body?.processes) ? env.body.processes : [],
    unknown: env.ok && Array.isArray(env.body?.unknown) ? env.body.unknown : [],
    // WHAT THIS ENVIRONMENT HAS DONE, so the view can say which kind of empty an empty list is.
    history: (env.ok && env.body?.history) || { startedTotal: 0, lastExitAtMs: null },
    // The reference point for "last exited N ago". Read ONCE here and handed down, so the renderer
    // stays a pure function of its snapshot -- a clock inside it would make its tests flaky and the
    // screen flicker between frames that are otherwise identical.
    nowMs: nowMs(),
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
  // Defaults suit a pipe, not a terminal: no colour, a conservative width. The caller that knows it
  // owns a screen says so, and NO_COLOR is honoured there rather than sniffed here.
  columns = 100,
  color = false,
  ...collectOptions
} = {}) {
  const draw = async () => {
    // WIDTH AND COLOUR ARE DECIDED HERE, once, and handed to a pure renderer. Reading them inside the
    // view would make the same snapshot render differently in a test than on a screen.
    const lines = renderDashboard(
      await collectSnapshot({ endpoint, registryPath, ...collectOptions }),
      { columns, color },
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
