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
 * The states in which the SERVICE considers a terminal over.
 *
 * A process this host is still running for one of these is an orphan by definition: the control
 * plane will hand it no work, address it with no control and report it to nobody. Measured on the
 * operator's host 2026-09-03 -- `term_1788414394995_c339d2b4` read `stopped` with `process_id`
 * 250952, and 250952 was alive, holding a claude worker and a model session for nothing.
 *
 * MIRRORS `_TERMINAL_END_STATUSES` IN THE SERVICE, which is the tier that owns the vocabulary. A
 * name that drifts apart here means an orphan this host cannot recognise, so the list is short and
 * conservative on purpose: a state NOT in it is simply not acted on.
 */
export const TERMINAL_ENDED = Object.freeze(["stopped", "failed", "exited", "killed"]);

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
  //: WHICH AGENT EACH TERMINAL IS FOR, so this host can refuse to run two workers for one agent.
  //: Kept beside the handles rather than derived from a label, because a label is display text and
  //: nothing should make a safety guard depend on how something is shown.
  const agents = new Map();
  return {
    remember(terminalId, handle, agentId = "") {
      if (!terminalId || !handle) return;
      handles.set(String(terminalId), String(handle));
      if (agentId) agents.set(String(terminalId), String(agentId));
    },
    /** The terminals this host is running for an agent, other than the one being started. */
    otherTerminalsFor(agentId, exceptTerminalId = "") {
      const wanted = String(agentId || "");
      if (!wanted) return [];
      return [...agents.entries()]
        .filter(([id, owner]) => owner === wanted && id !== String(exceptTerminalId))
        .map(([id]) => id);
    },
    forget(terminalId) {
      handles.delete(String(terminalId));
      agents.delete(String(terminalId));
    },
    handleFor(terminalId) { return handles.get(String(terminalId)) || ""; },
    /** Every terminal this host is currently running, so their liveness can be reported. */
    terminalIds() { return [...handles.keys()]; },
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

  // ONE WORKER PER AGENT — AND THE LIVE ONE WINS.
  //
  // THIS REFUSES. An earlier version REPLACED, and that was the wrong way round: it destroyed four
  // working sessions on the operator's fleet within ten minutes on 2026-09-03, including a lead
  // mid-design-note. The sequence was: a message arrives for a lane whose claude is idle at its own
  // prompt, the service concludes there is no worker and asks for a new terminal, this host stopped
  // the RUNNING one to honour the request, and the replacement then parked on a first-run dialog.
  // The lane's context was gone. Before the rule existed both ran, which was bad; with it, the
  // working one died, which is worse.
  //
  // THE ASYMMETRY IS THE WHOLE POINT. Refusing a start is recoverable -- the service is told, and
  // can stop the old worker explicitly and ask again. Killing a live session is not: its context is
  // unrecoverable, and no later correctness makes it come back. When one side of a decision is
  // reversible and the other is not, a host that cannot tell which side is right must take the
  // reversible one.
  //
  // A RESTART STILL WORKS, and this does not block it. A real restart stops the worker first -- an
  // explicit stop control, or the process exiting -- and either way this host has forgotten the
  // terminal by the time the start arrives. What is refused is only "start a second worker for an
  // agent that already has a live one", which no correct caller asks for.
  const live = handles.otherTerminalsFor(launch.agentId, terminalId);
  if (live.length) {
    const detail =
      `this host is already running a worker for "${launch.agentId}" on terminal ${live[0]} `
      + `(process ${handles.handleFor(live[0])}). Refusing to start a second one: stopping the live `
      + "session would lose its context, and that cannot be undone. Stop it explicitly and ask again "
      + "if a replacement is really wanted.";
    await report(api, controlId, CONTROL_FAILED, detail);
    log(`refused a second worker for "${launch.agentId}": ${live[0]} is already live here`);
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
  handles.remember(terminalId, handle, String(launch.agentId || ""));
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
      // FORGOTTEN ON EXIT, not only on an explicit stop. Without this the liveness report keeps
      // insisting a dead worker is running -- a ghost console nothing else in the system can
      // contradict, which is strictly worse than the reaping this host is trying to prevent.
      // Its own test caught it: a natural exit left the terminal in the book for ever.
      handles.forget(terminalId);
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
  // SAY THAT WHAT WE STARTED IS STILL ALIVE, every pass, whether or not there is work.
  //
  // A WORKER THAT IS QUIET IS NOT A WORKER THAT IS DEAD, and the service cannot tell the difference
  // on its own. Its reconciler reaps a managed console when all three of its signals are absent --
  // no claimer sidecar, no wrapper child, no output in 90 seconds -- and for a worker parked at its
  // first-run prompt all three are absent while the process is perfectly alive. Measured 2026-09-03:
  // the console attached, carried the prompt, went quiet, and was declared a dead ghost two minutes
  // later; `comms_console_input` then refused to send the Enter that would have freed it, because
  // the terminal was "not live". The reconciler was not wrong -- nothing had told it.
  //
  // THIS HOST IS THE ONLY THING THAT KNOWS. It holds the process. So it says so, using the mechanism
  // that already exists: an empty output frame bumps `updated_at` and appends nothing -- no event,
  // no screen feed, both guarded on a non-empty chunk. And it carries NO status, so it can never
  // resurrect a terminal the service has deliberately stopped.
  await touchLiveTerminals({ api, processes, handles, log });

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

/**
 * Report that every terminal this host started is still running.
 *
 * ONE SMALL POST PER TERMINAL PER PASS. The pass is gated by a long-poll, so this is at most every
 * `CLAIM_WAIT_MS` -- comfortably inside the service's 90-second reap window, and cheap enough that
 * fourteen workers cost fourteen empty frames a minute.
 *
 * FAILURES ARE LOGGED, NEVER THROWN. A liveness report that could take down the control loop would
 * trade a reaped console for a host that stops running anything at all.
 */
async function touchLiveTerminals({ api, processes, handles, log }) {
  for (const terminalId of handles?.terminalIds?.() ?? []) {
    try {
      // NO `status`. The service only transitions status when one is sent, so an empty frame cannot
      // reopen a terminal an operator or a reconciler deliberately closed.
      const answer = await api.terminalOutput(terminalId, { output: "" });

      // AN END STATUS IS THE SECOND ANSWER, and it is the one the 404 rule below could not give.
      //
      // A 404 means the row is GONE. This means the row is THERE and the service considers the
      // terminal over -- `comms_remove_agent` issuing a stop before the cascade, a reconciler
      // declaring the console dead, an operator stopping it from the dashboard. Every one of those
      // leaves a process nothing can address, and the reconcile written for the first case walked
      // straight past all of them: measured on the operator's host, a worker had been running for
      // two hours against a terminal that read `stopped`, through hundreds of these passes.
      //
      // THE SERVICE'S JUDGEMENT, NOT THIS HOST'S. It is asked, not inferred from quiet -- quiet is
      // what a worker between turns looks like, and killing on quiet is how four working sessions
      // were destroyed earlier the same night. A state the service does not call ended is left
      // alone.
      const reported = String(answer?.terminal?.status || answer?.status || "").toLowerCase();
      if (reported && TERMINAL_ENDED.includes(reported)) {
        log(
          `stopping the worker for terminal ${terminalId}: the service reports it ${reported}, `
          + "so nothing can address this process any more",
        );
        await stopOrphan({ processes, handles, terminalId, log });
        continue;
      }
    } catch (error) {
      // A 404 IS AN ANSWER, NOT AN OUTAGE, and acting on it is what stops this host outliving the
      // work it was given.
      //
      // THE RACE IT CLOSES, measured 2026-09-03. `comms_remove_agent` does the right thing: it
      // issues a stop control for the agent's terminals BEFORE tombstoning. But deleting the agent
      // cascades agents -> sessions -> terminals -> terminal_controls, so the control is deleted
      // milliseconds later -- long before any host polling for work could claim it. It only ever
      // worked because the bridge was in-process and won that race. A live worker was left running
      // that nothing could address, because its agent id no longer existed.
      //
      // STATE, NOT AN EVENT. This repo's own rule: cleanup that must hold on ALL paths keys on the
      // state, because an event can be lost -- and this one is deleted by design. "I am holding a
      // process for a terminal the service does not have" is a state, and it covers every route to
      // it: remove, cascade, a database restored from backup, an operator deleting a row.
      //
      // It costs nothing extra: the liveness report is already asking, so it is a probe as well as
      // a statement.
      if (Number(error?.status) === 404) {
        log(
          `stopping the worker for terminal ${terminalId}: the service no longer has that terminal, `
          + "so nothing can address this process any more",
        );
        await stopOrphan({ processes, handles, terminalId, log });
        continue;
      }
      log(`could not report terminal ${terminalId} alive: ${error?.message || error}`);
    }
  }
}

/**
 * Stop the worker behind an orphaned terminal and forget it, whatever answered.
 *
 * ONE BODY FOR BOTH ANSWERS -- the row is gone, or the row says the terminal is over. They are the
 * same conclusion reached two ways, and writing the teardown twice is how one of them ends up
 * forgetting the handle and the other not.
 *
 * NEVER THROWS. This runs inside the control pass; a failure to stop one orphan must not cost the
 * host every control after it.
 */
async function stopOrphan({ processes, handles, terminalId, log }) {
  const handle = handles.handleFor(terminalId);
  try {
    if (handle) await processes.stop(handle);
  } catch (stopError) {
    log(`could not stop the orphaned worker for ${terminalId}: ${stopError?.message || stopError}`);
  }
  // FORGOTTEN EVEN IF THE STOP FAILED. Keeping it would retry the same stop on every pass for the
  // life of the host; the process is reported by `aify-env doctor`'s process listing either way.
  handles.forget(terminalId);
}
