// What this host started, by the name the service calls it, and which of those it still holds.
//
// Moved out of terminal-controls.mjs, which runs the controls, because the plugin's heartbeat needs the
// same book and the same predicate; terminal-controls.mjs re-exports both for its existing importers.

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
  //: WHEN EACH TERMINAL LAST PRODUCED OUTPUT, and it is a SAFETY signal, not telemetry.
  //:
  //: A terminal the service calls finished while its process is still writing is a CONTRADICTION,
  //: and the right answer to a contradiction is never to kill. Measured on the operator's host
  //: 2026-09-03: `sc-coder`'s terminal read `failed` at 06:47:45 while that same second carried a
  //: claude session mid-task. An end-status rule without this veto would have stopped a working
  //: agent, which is the regression that destroyed four sessions earlier the same night.
  //:
  //: THIS HOST IS THE ONLY TIER THAT CAN SEE IT. The service knows what it BELIEVES; only the
  //: process's owner knows whether bytes are still coming out of it.
  const lastOutputAt = new Map();
  //: HOW TO DETACH EACH TERMINAL'S LISTENER. Held so `forget` is a complete teardown rather than a
  //: bookkeeping delete: a forgotten terminal whose listener is still attached goes on POSTing to a
  //: terminal nobody is reading.
  const carriers = new Map();
  //: WHAT EACH TERMINAL'S SCREEN SHOWS (`screen-observer.mjs`), disposed with the terminal.
  const observers = new Map();
  const markers = new Set();
  return {
    remember(terminalId, handle, agentId = "", at = Date.now()) {
      if (!terminalId || !handle) return;
      handles.set(String(terminalId), String(handle));
      if (agentId) agents.set(String(terminalId), String(agentId));
      // Started counts as produced. A worker that has not spoken yet is not evidence of death --
      // it is the shape of every fresh spawn, and of a worker parked at its first prompt.
      lastOutputAt.set(String(terminalId), Number(at) || 0);
    },
    /** Remember how to STOP carrying this terminal, so `forget` can detach its listener.
     *
     *  WITHOUT THIS AN ADOPTION LEAKS THE OLD LISTENER, and the leak is not quiet: the process would
     *  keep reporting into the terminal the service has already ended, on every chunk, for the life
     *  of the host -- and into the new one as well, so the console would double every byte. */
    carriedBy(terminalId, release) {
      if (terminalId && typeof release === "function") carriers.set(String(terminalId), release);
    },
    observedBy(terminalId, observer) { if (terminalId && observer) observers.set(String(terminalId), observer); },
    /** The terminal's current screen observation, or null. Repeated on every liveness frame. */
    activityFor(terminalId) { return observers.get(String(terminalId))?.current() ?? null; },
    /** This terminal just produced output. Called from the stream, so it costs one map write. */
    noteOutput(terminalId, at = Date.now()) {
      if (!terminalId) return;
      if (handles.has(String(terminalId))) lastOutputAt.set(String(terminalId), Number(at) || 0);
    },
    /** Milliseconds since this terminal last produced anything, or Infinity if unknown. */
    quietFor(terminalId, now = Date.now()) {
      const at = lastOutputAt.get(String(terminalId));
      return at ? Math.max(0, (Number(now) || 0) - at) : Infinity;
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
      const id = String(terminalId);
      const release = carriers.get(id);
      if (release) {
        // ITS OWN CATCH. A disposer that throws must not stop the rest of the teardown, or a
        // terminal stays in the book and is reported alive for ever.
        try { release(); } catch { /* the listener is going away either way */ }
        carriers.delete(id);
      }
      observers.get(id)?.dispose();
      observers.delete(id);
      handles.delete(id);
      agents.delete(id);
      lastOutputAt.delete(id);
    },
    /** An exit marker on its way to the service. Kept until it settles, so a stopping host can wait
     *  for it: the terminal leaves this book the instant its process ends, and a daemon that exits
     *  before the marker lands leaves the service believing the terminal is still attached. */
    noteExitMarker(sending) {
      const settled = Promise.resolve(sending).catch(() => {}).finally(() => markers.delete(settled));
      markers.add(settled);
    },
    /** Resolves once every exit marker noted so far has landed or failed. */
    exitMarkersSettled() { return Promise.all([...markers]); },
    handleFor(terminalId) { return handles.get(String(terminalId)) || ""; },
    /** Every terminal this host is currently running, so their liveness can be reported. */
    terminalIds() { return [...handles.keys()]; },
    get size() { return handles.size; },
  };
}

/**
 * The terminals this host holds a LIVE process for: the handle book intersected with what the runner
 * is running now.
 *
 * ONE PREDICATE FOR BOTH THINGS THIS HOST SAYS ABOUT IT -- the liveness frame per terminal and the
 * heartbeat's `heldTerminals` -- so the two claims cannot disagree. The book alone is not the answer:
 * it forgets a terminal only when an exit listener or a stop tells it to, and a process can leave the
 * runner without either (a shutdown's stops, a listener that never attached). The runner is the only
 * thing that knows what is actually running.
 *
 * A TERMINAL ENTERS BEFORE THE SERVICE IS TOLD IT STARTED: `startTerminal` registers the process in
 * the runner, remembers the handle, and only then reports the control complete. So a heartbeat built
 * after that report was sent always names the terminal.
 */
export function heldTerminalIds(handles, processes) {
  const live = new Set((processes?.list?.() ?? []).map((entry) => String(entry?.id ?? "")));
  return (handles?.terminalIds?.() ?? []).filter((terminalId) => live.has(handles.handleFor(terminalId)));
}
