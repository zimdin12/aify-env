// What the dashboard shows: one snapshot of this environment, its services and its agents (0.9.8, moved verbatim
// out of lib/dashboard.mjs, which draws it). ITS OWN MODULE because collecting is a question about the host and
// drawing is a question about a terminal: a reader that wants the facts needs none of the keyboard or the frame.
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
import { homedir } from "node:os";
import { join } from "node:path";

import { readServices, probeService, serviceIdentity } from "./services.mjs";
import { collectEnvironmentChecks } from "./environment-report.mjs";
import { liveInvocationRegistries } from "./serving-endpoint.mjs";
import { credentialRoot, listCredentialStore } from "./credential-fs.mjs";
import { terminalSupport } from "./runner.mjs";

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
    // THE STATUS TRAVELS. It was dropped, and the doctor's own checks need it: `looksLikeEnvironment`
    // requires a 2xx, so an answer with no status reads as 0 and a healthy environment is reported
    // FAILED. Measured the moment this view started collecting those checks -- the panel said the
    // environment was down while the rows above it listed four processes it owned. A reader that
    // holds a fact and hands on less than it holds is a lossy reader.
    //
    // ONLY WHEN THERE IS ONE. A `status: undefined` key is not a status, and absence stays absence
    // here as everywhere else: a response that never carried one must not read as "carried nothing",
    // which is a fact a caller could act on.
    return Number.isFinite(response?.status)
      ? { ok: true, status: response.status, body }
      : { ok: true, body };
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
  // AND THE CREDENTIAL STORE, for the same reason and a sharper one: it is an AMBIENT INPUT. Left
  // hardcoded, every test of this function reads the operator's real `~/.aify` and its result is
  // decided by whatever that host happens to hold -- so a check would pass here and fail on a
  // machine with one extra credential, for reasons no test could see. A test that cannot seal an
  // input is a test whose result the host decides.
  readCredentialStore = () => listCredentialStore(credentialRoot()),
  // The same, for the herdr-aify env daemons' own registry copies the credentials row holds (liveInvocationRegistries).
  readInvocationRegistries = () => liveInvocationRegistries(join(homedir(), ".aify", "herdr")),
} = {}) {
  // EVERY ANSWER IS KEPT, so the health panel costs no extra requests. The doctor's collector asks
  // for exactly the URLs this function already asks for -- the environment's `/health` and each
  // registered service's -- so it is handed a `knock` that REPLAYS them. Asking twice would double
  // the traffic of a view that refreshes on a timer, and worse, could show a panel disagreeing with
  // the rows above it because the two reads happened at different moments.
  const answers = new Map();
  const ask = async (url) => {
    if (!answers.has(url)) answers.set(url, await knock(url, { timeoutMs: probeTimeoutMs, fetchImpl }));
    return answers.get(url);
  };
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
  for (const entry of readServices(registryText)) {
    // The view names and knocks on the service as every other decision does (`serviceIdentity`).
    const { name, endpoint } = serviceIdentity(entry);
    const check = probeService(entry, await ask(`${endpoint}/health`));
    services.push({ ...entry, name, endpoint, state: check.state, detail: check.detail });
  }

  // WHAT THE DOCTOR WOULD SAY, from the answers already in hand. A3, the operator, 2026-08-24: the
  // TUI should show what the doctor shows. It is collected here rather than rendered from a shelled
  // -out binary because a display parsing another display's output is a contract nobody declared.
  //
  // BEST-EFFORT: a view that cannot draw because a check threw is worse than a view with no health
  // panel. An empty list renders as "not collected" rather than as "everything is fine".
  let checks = [];
  try {
    checks = await collectEnvironmentChecks({
      endpoint,
      knock: ask,
      readRegistry: () => ({ text: registryText }),
      terminalSupport,
      readCredentialStore,
      readInvocationRegistries,
    });
  } catch {
    checks = [];
  }

  return {
    //: WHETHER THE ENVIRONMENT ANSWERED AT ALL (v0.7 scan, F16). Every field below has a default for
    //: when it did not, and a renderer that cannot tell a default from an answer states facts about
    //: an environment nobody heard from.
    answered: env.ok === true,
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
    // EACH AGENT'S STATUS, this environment's own word since the 0.9.8 switch (`/agents/state`), by agent id.
    // Empty when it did not answer: a row with no word draws none rather than a guessed one.
    agentRecords: env.ok ? agentRecordsById(await ask(`${endpoint}/agents/state`)) : {},
    unknown: env.ok && Array.isArray(env.body?.unknown) ? env.body.unknown : [],
    // WHAT THIS ENVIRONMENT HAS DONE, so the view can say which kind of empty an empty list is.
    history: (env.ok && env.body?.history) || { startedTotal: 0, lastExitAtMs: null },
    // The reference point for "last exited N ago". Read ONCE here and handed down, so the renderer
    // stays a pure function of its snapshot -- a clock inside it would make its tests flaky and the
    // screen flicker between frames that are otherwise identical.
    nowMs: nowMs(),
    traffic: env.ok && env.body?.traffic ? env.body.traffic : { requests: 0, bytesOut: 0 },
    // The doctor's verdicts, in reading order. The view renders them; it does not judge them.
    checks,
  };
}

/**
 * `{agentId: record}` from a `/agents/state` answer, or {} for any other answer. PURE.
 *
 * THE WHOLE RECORD, NOT ITS WORD (0.9.7). Until 0.9.7 this kept `state` alone, so the view could not say how long an
 * agent had been working or why it was blocked, though the environment had already said both: `turn` and
 * `stateCause` were dropped here.
 */
export function agentRecordsById(answer) {
  const agents = Array.isArray(answer?.body?.agents) ? answer.body.agents : [];
  return Object.fromEntries(agents
    .filter((agent) => typeof agent?.agentId === "string" && typeof agent.state === "string")
    .map((agent) => [agent.agentId, agent]));
}
