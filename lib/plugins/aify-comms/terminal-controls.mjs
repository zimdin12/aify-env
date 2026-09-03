// Running the processes aify-comms asks for — the half that makes this host the process host.
//
// WHY THIS EXISTS. Claiming a spawn registers a WARM agent and starts nothing; the worker process
// comes later, when work actually arrives. Until now the only tier that could start one was the
// aify-comms environment BRIDGE, so a host running aify-env alone claimed six spawns on 2026-09-03
// and started none of them. The operator's reasoning for moving it is exact: aify-comms is a
// container service, so it cannot hold the agents — they would be in the container's environment
// rather than on the host.
//
// IT RUNS WHAT IT IS TOLD AND COMPOSES NOTHING. The service sends the program, its `argv` and the
// aify-owned environment (`GET /terminals/{id}/launch`); this adds only what the service cannot
// know — this machine's own environment. That split is the whole design: a second implementation of
// "what does a claude worker need" living here is exactly what the plugin seam exists to prevent,
// and the one file that used to do it has a defect recorded against nearly every line.
//
// EVERY CLAIMED CONTROL IS REPORTED, on every path. A control the service never hears about again
// is one it hands to nobody else: the dashboard shows a terminal that is neither running nor
// failed, and the agent waits for ever. That is the same shape as the spawn claim, and it is the
// failure this tier keeps producing.
//
// EVERY DEPENDENCY IS INJECTED. No network, no clock, no filesystem of its own — so the paths that
// only happen when something is already wrong can be tested rather than reasoned about.

export const CONTROL_COMPLETED = "completed";
export const CONTROL_FAILED = "failed";

/** Terminal states this reports back, named so a typo is a reference error here rather than a row
 *  in a state the service does not recognise. */
export const TERMINAL_ATTACHED = "attached";
export const TERMINAL_STOPPED = "stopped";

/**
 * What this host started, by the name the SERVICE calls it.
 *
 * TWO TIERS NAME THE SAME THING DIFFERENTLY, and only one of them can be right for the runner. The
 * service addresses a terminal by ITS id; the runner answers only to the id it returned from
 * `start`. Subscribing with the service's name found no stream, `subscribe` answered `null`
 * silently, and a healthy worker's console stayed empty in the dashboard — measured 2026-09-03.
 *
 * THE MAP LIVES HERE BECAUSE THIS HOST IS THE ONLY THING THAT KNOWS IT. The service cannot supply
 * the runner's id on a control: it has no reason to hold one, and depending on it would make every
 * write and stop contingent on a field an older service does not send. This host started the
 * process, so this host remembers what it started.
 *
 * An UNKNOWN terminal answers "" rather than falling back to the terminal id. The fallback looks
 * harmless and is not: the runner would refuse an id it has never seen, and the action would be
 * reported as failed for the wrong reason — "no such process" instead of "this host never started
 * that terminal", which sends a reader somewhere else entirely.
 */
export function createHandleBook() {
  const handles = new Map();
  return {
    remember(terminalId, handle) {
      if (terminalId && handle) handles.set(String(terminalId), String(handle));
    },
    forget(terminalId) { handles.delete(String(terminalId)); },
    handleFor(terminalId) { return handles.get(String(terminalId)) || ""; },
    get size() { return handles.size; },
  };
}

/**
 * One control, carried out and reported.
 *
 * SEPARATE FROM THE LOOP so a single control can be driven in a test without a queue, a clock or a
 * service. The loop below is then only ordering and error containment.
 *
 * @returns {{outcome: string, controlId?: string, detail?: string}}
 */
export async function runOneControl({
  control, api, processes, cwdRoots = [], windows = false, log = () => {},
  withinRoots,
  buildSpec,
  resolveCandidates,
  handles,
  baseEnv = process.env,
}) {
  const controlId = String(control?.id || "").trim();
  const terminalId = String(control?.terminalId || "").trim();
  if (!controlId) return { outcome: "ignored", detail: "control carried no id" };
  if (!terminalId) {
    await report(api, controlId, CONTROL_FAILED, "control names no terminal");
    return { outcome: "failed", controlId, detail: "control names no terminal" };
  }

  const action = String(control?.action || "").trim();
  // NAMED ONCE, so every action that addresses the process reads the same value and a terminal this
  // host never started is refused with THAT reason rather than with the runner's "no such process".
  const requireHandle = () => {
    const handle = handles.handleFor(terminalId);
    if (!handle) {
      throw new Error(
        `this environment has no process for terminal "${terminalId}" — it was started elsewhere, `
        + "or this daemon has restarted since",
      );
    }
    return handle;
  };
  try {
    if (action === "start") {
      return await startTerminal({
        api, processes, control, controlId, terminalId, cwdRoots, windows, log, withinRoots,
        buildSpec, resolveCandidates, handles, baseEnv,
      });
    }
    if (action === "input") {
      // Raw passthrough: the caller owns newline semantics. Interpreting them here would make this
      // host a participant in a conversation it is only carrying.
      // BY THE RUNNER'S HANDLE, which the service returns to us on the control. Addressing the
      // runner by terminal id is what left every started terminal unsubscribed and silent.
      processes.write(requireHandle(), String(control.body ?? ""));
      await report(api, controlId, CONTROL_COMPLETED, "", TERMINAL_ATTACHED);
      return { outcome: "completed", controlId };
    }
    if (action === "resize") {
      processes.resize(requireHandle(), Number(control.cols) || 0, Number(control.rows) || 0);
      await report(api, controlId, CONTROL_COMPLETED, "", TERMINAL_ATTACHED);
      return { outcome: "completed", controlId };
    }
    if (action === "stop") {
      // `stop` takes OPTIONS, not a reason string: passing one silently became a
      // `phase` callback that was never a function, and the terminal would not stop.
      const stopping = requireHandle();
      await processes.stop(stopping);
      handles.forget(terminalId);
      await report(api, controlId, CONTROL_COMPLETED, "", TERMINAL_STOPPED);
      return { outcome: "completed", controlId };
    }
    // NAMED, not ignored. An action this host does not implement is a control the service is
    // waiting on, and silently dropping it is indistinguishable from being slow.
    const detail = `unsupported terminal control action "${action}"`;
    await report(api, controlId, CONTROL_FAILED, detail);
    return { outcome: "failed", controlId, detail };
  } catch (error) {
    const detail = String(error?.message || error);
    // `.catch` on the report: if the service cannot be told, the loop must still continue to the
    // next control. Failing to report is not a reason to stop running things.
    await report(api, controlId, CONTROL_FAILED, detail).catch(() => {});
    log(`terminal control ${controlId} failed: ${detail}`);
    return { outcome: "failed", controlId, detail };
  }
}

async function startTerminal({
  api, processes, control, controlId, terminalId, cwdRoots, windows, log, withinRoots,
  buildSpec, resolveCandidates, handles, baseEnv,
}) {
  const answer = await api.launch(terminalId);
  const launch = answer?.launch || {};
  const argv = Array.isArray(launch.argv) ? launch.argv.filter((part) => typeof part === "string") : [];
  const cwd = String(launch.cwd || "");

  // THE RISKIEST STEP IN THE WHOLE PASS, and the reason it is checked here rather than trusted from
  // the wire: this is what stops a service launching a process anywhere on this machine. It is
  // answered against the roots THIS environment advertised.
  if (!withinRoots(cwd, cwdRoots, { windows })) {
    const detail = `Workspace "${cwd}" is outside this environment's advertised roots`;
    await report(api, controlId, CONTROL_FAILED, detail);
    log(`refused terminal ${terminalId}: ${detail}`);
    return { outcome: "refused", controlId, detail };
  }

  // AN EMPTY ARGV IS A REAL ANSWER meaning "not ours to run" — an operator-supplied command has no
  // structural form, and splitting a human's shell string is the quoting bug this design avoids.
  // Refusing names it; starting something invented from the string would be worse than not starting.
  if (argv.length === 0) {
    const detail = `Terminal "${terminalId}" carries no argv, only a command string, so this host `
      + "cannot run it without splitting a shell string";
    await report(api, controlId, CONTROL_FAILED, detail);
    return { outcome: "refused", controlId, detail };
  }

  // THE SERVICE NAMES A PROGRAM; THIS HOST FINDS THE FILE. It cannot know where this machine keeps
  // `claude-aify`, or that on Windows the name resolves to a `.cmd` shim that carries no marker and
  // the allowlist correctly refuses. Every candidate is tried through the SAME spec builder the HTTP
  // endpoint uses, so the allowlist stays the single authority on what may run here — a second
  // marker test in this path would be a copy of it that agreed until one was corrected.
  const candidates = resolveCandidates(argv[0]);
  if (candidates.length === 0) {
    const detail = `"${argv[0]}" does not resolve to a file on this host`;
    await report(api, controlId, CONTROL_FAILED, detail);
    return { outcome: "refused", controlId, detail };
  }
  // THE SERVICE'S OVERLAY OVER THIS MACHINE'S OWN ENVIRONMENT, in that order. The service sends only
  // the aify-owned variables — it must never send a process environment, which would carry whatever
  // the sender happened to hold — and this host supplies the rest. Merging the other way round would
  // let an inherited value win over a value the spawn chose, which is the bug class the overlay was
  // written to close.
  const env = { ...baseEnv, ...(launch.env && typeof launch.env === "object" ? launch.env : {}) };
  let built = null;
  const rejected = [];
  for (const candidate of candidates) {
    const attempt = buildSpec({
      service: "aify-comms",
      launcher: candidate,
      args: argv.slice(1),
      cwd,
      env,
      label: String(launch.agentId || terminalId),
    });
    if (!attempt.error) { built = attempt; break; }
    rejected.push(`${candidate}: ${attempt.error.detail}`);
  }
  if (!built) {
    // NAMES EVERY FILE IT LOOKED AT. "The agent did not start" is what this used to be, minutes
    // later, with each candidate's own reason discarded — and the reasons differ: "cannot read"
    // and "refused by the allowlist" send an operator to two different places.
    const detail = `no launcher for "${argv[0]}" could be run — ${rejected.join("; ")}`;
    await report(api, controlId, CONTROL_FAILED, detail);
    log(`refused terminal ${terminalId}: ${detail}`);
    return { outcome: "refused", controlId, detail };
  }

  const started = await processes.start({
    ...built.spec,
    id: terminalId,
    cols: Number(control.cols) || Number(launch.cols) || 0,
    rows: Number(control.rows) || Number(launch.rows) || 0,
  });

  // AND THEN LISTEN TO IT, which is the half that turned a working fleet into a duplicated one.
  //
  // MEASURED 2026-09-03: fourteen workers ran perfectly and the service received not one byte from
  // any of them, so its reconciler correctly called each terminal a dead ghost, marked it stopped,
  // and issued a NEW start control. This host obeyed and started a second process beside the first,
  // which nothing then stopped. Two `sc-lead`s, two `sc-coder`s — and the agent ids were unique the
  // whole time. What duplicated was the process, because starting one and saying nothing about it
  // afterwards is indistinguishable from never starting it.
  //
  // SUBSCRIBED BEFORE THE CONTROL IS REPORTED COMPLETE, so there is no window in which the service
  // believes a terminal is attached and nothing is carrying its output.
  const handle = String(started?.id ?? "");
  // REMEMBERED BEFORE THE SUBSCRIPTION, so a control arriving in the same tick can address it.
  handles.remember(terminalId, handle);
  // SUBSCRIBED BY THE ID THE RUNNER RETURNED, not by the terminal id. The runner keys its streams by
  // its OWN process id (`<instance>-p1`); `spec.id` is not that key. Subscribing with the terminal id
  // found no stream and `subscribe` answered `null` — SILENTLY — so nothing was carried and the
  // dashboard console for a healthy worker stayed empty. Measured 2026-09-03, and it is the second
  // time this exact gap has produced a duplicated fleet: the service hears nothing, reconciles the
  // terminal as dead, and asks for another worker.
  const carried = processes.subscribe(
    handle,
    (chunk) => {
      // Fire-and-forget with its own catch: a failed POST must not stop the next chunk, and there is
      // nobody above this to hand the error to — it is a listener, not a request.
      void api.terminalOutput(terminalId, { output: String(chunk ?? ""), status: TERMINAL_ATTACHED })
        .catch((error) => log(`terminal ${terminalId} output not delivered: ${error?.message || error}`));
    },
    (code, signal) => {
      // HOW IT ENDED, not merely THAT it did. An exit code alone cannot tell a crash from a kill on
      // Windows, where an externally terminated process and a program returning 1 are the same
      // number — so the signal travels as its own field, and an ABSENT field means nobody said
      // rather than zero. A clean exit is code 0 and the most common value there is, which is why
      // this tests the type rather than truthiness.
      const body = { status: TERMINAL_STOPPED, output: `${String.fromCharCode(10)}[terminal exited]${String.fromCharCode(10)}` };
      if (typeof code === "number" && Number.isFinite(code)) body.exitCode = code;
      const named = signal == null ? "" : String(signal).trim();
      if (named) body.exitSignal = named;
      void api.terminalOutput(terminalId, body)
        .catch((error) => log(`terminal ${terminalId} exit not delivered: ${error?.message || error}`));
    },
  );

  // A SUBSCRIPTION THAT ATTACHED TO NOTHING IS A FAILURE, not a detail. `subscribe` returns null for
  // an id it does not know, and taking that as success is exactly how the empty console shipped: the
  // control reported `attached`, the service believed it, and no byte ever arrived. Reported as a
  // failed control so the service can act, rather than waiting three minutes to conclude it itself.
  if (!carried) {
    const detail = `started ${handle} but could not subscribe to its output, so nothing would carry `
      + "this terminal and the service would reconcile it as dead";
    await report(api, controlId, CONTROL_FAILED, detail);
    log(`terminal ${terminalId}: ${detail}`);
    return { outcome: "failed", controlId, detail };
  }

  await report(api, controlId, CONTROL_COMPLETED, "", TERMINAL_ATTACHED, {
    // THE HOST'S OWN HANDLE AND PID. Without the handle the service knows a terminal is running and
    // has no way to write to it or stop it; without the pid nothing can match this terminal against
    // a process actually alive on this machine.
    handle: String(started?.id ?? ""),
    processId: started?.pid != null ? String(started.pid) : "",
  });
  log(`started terminal ${terminalId} for "${launch.agentId || "(no agent)"}" as ${handle}`);
  return { outcome: "started", controlId, terminalId };
}

function report(api, controlId, status, error = "", terminalStatus = "", extra = {}) {
  const patch = { status, ...extra };
  if (terminalStatus) patch.terminalStatus = terminalStatus;
  if (error) patch.error = error;
  return api.reportControl(controlId, patch);
}

/**
 * One pass: ask for controls, carry each out, report each.
 *
 * ONE BAD CONTROL DOES NOT STOP THE REST. The bridge learned this the hard way in a different loop —
 * a single broken item hid every item behind it — so each control is contained and the pass reports
 * a summary rather than throwing.
 *
 * @returns {{outcome: string, handled?: number, detail?: string}} `idle` means the service had
 *   nothing, which is the usual case.
 */
export async function runTerminalControlPass({
  api, processes, environmentId, cwdRoots = [], windows = false, log = () => {},
  withinRoots,
  buildSpec,
  resolveCandidates,
  handles,
  baseEnv = process.env,
}) {
  let claimed;
  try {
    claimed = await api.claimControls({ environmentId });
  } catch (error) {
    // A service that is down or refusing us is not something this host can act on, and must not
    // stop the next pass from trying. Reported, never thrown.
    return { outcome: "unreachable", detail: String(error?.message || error) };
  }
  const controls = Array.isArray(claimed?.controls) ? claimed.controls : [];
  if (controls.length === 0) return { outcome: "idle", handled: 0 };

  let failed = 0;
  for (const control of controls) {
    const result = await runOneControl({
      control, api, processes, cwdRoots, windows, log, withinRoots, buildSpec, resolveCandidates,
      handles, baseEnv,
    });
    if (result.outcome === "failed" || result.outcome === "refused") failed += 1;
  }
  return { outcome: failed ? "partial" : "handled", handled: controls.length, failed };
}
