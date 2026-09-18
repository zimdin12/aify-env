// One managed terminal's screen, watched: what it shows now, and a report when that changes.
//
// WHAT IT KEEPS. The current observation -- `{state, rule, observedAt}`, where `observedAt` is when
// this host first saw the state -- which every liveness frame repeats, and which a change reports at
// once through `report`. `idle`, `working`, `blocked` and `shell` are the only states it reports; a rule that
// asks for no update (Herdr's `skip_state_update`, e.g. a transcript viewer) changes nothing.
//
// WHEN IT LOOKS. Output schedules an evaluation at most every THROTTLE_MS (a spinner repaints many
// times a second, and a debounce that restarts on every chunk would never fire while an agent works).
// A chunk that sets a title looks sooner -- as soon as the throttle allows -- because the title is
// the strongest signal Claude and Codex give. A screen that is not changing is never read.
//
// HERDR'S PENDING-IDLE HOLD (pane/agent_detection.rs): `working` to an idle that nothing on screen
// shows (no visible idle, no visible blocker) is published only after three more confirmations 100ms
// apart, or 700ms, whichever comes first -- the gap between two tool calls is not an idle agent.
//
// NO SCREEN, NO CLAIM. When the host cannot read the screen (no checkpoint, or it went away) the
// observation is dropped, so liveness frames stop repeating something nobody is looking at any more.

import { evaluateScreen, manifestForRuntime, screenText } from "./screen-rules.mjs";
import { withBackgroundShell } from "./background-shell.mjs";

export const THROTTLE_MS = 250;
export const PENDING_IDLE_RECHECK_MS = 100;
export const PENDING_IDLE_CAP_MS = 700;
const PENDING_IDLE_CONFIRMATIONS = 3;
const REPORTED = new Set(["idle", "working", "blocked", "shell"]);
// Herdr's name for "no rule matched on a known runtime", so the service can say why a state is idle.
const FALLBACK_RULE = "default_known_agent_idle_fallback";
const OSC = `${String.fromCharCode(27)}]`;

/**
 * Watch one terminal, or null when its runtime has no manifest (nothing is evaluated for it).
 *
 * @param runtime  the runtime the launch answer named
 * @param read     () => Promise<{rows, title, progress}|null>, the host's screen text for the process
 * @param report   (activity) => Promise, sends a transition; failures are logged, never thrown
 */
export function observeScreen({
  runtime, read, report, log = () => {},
  now = Date.now, schedule = setTimeout, cancel = clearTimeout, throttleMs = THROTTLE_MS,
}) {
  const manifest = manifestForRuntime(runtime);
  if (!manifest || typeof read !== "function" || typeof report !== "function") return null;

  let current = null;
  let disposed = false;
  let timer = null;
  let due = Infinity;
  let reading = false;
  let again = false;
  let lastReadAt = -Infinity;
  let holdStartedAt = null;
  let confirmations = 0;
  let sending = false;
  let queued = null;

  const wake = (delay) => {
    if (disposed) return;
    if (reading) { again = true; return; }
    const at = now() + delay;
    if (timer && due <= at) return;
    if (timer) cancel(timer);
    due = at;
    timer = schedule(evaluate, Math.max(0, delay));
    timer?.unref?.();
  };

  async function evaluate() {
    timer = null;
    due = Infinity;
    reading = true;
    lastReadAt = now();
    let seen = null;
    try { seen = await read(); } catch { seen = null; }
    reading = false;
    if (disposed) return;
    if (!seen) {
      current = null;
      holdStartedAt = null;
    } else {
      const screen = screenText(seen.rows);
      settle(withBackgroundShell(manifest.id, evaluateScreen(manifest, { screen, title: seen.title, progress: seen.progress }), screen));
    }
    if (again) {
      again = false;
      wake(throttleMs);
    }
  }

  function settle(detection) {
    if (detection.skipStateUpdate || !REPORTED.has(detection.state)) return;
    const plainIdle = current?.state === "working" && detection.state === "idle"
      && !detection.visibleIdle && !detection.visibleBlocker;
    if (plainIdle) {
      if (holdStartedAt === null) {
        holdStartedAt = now();
        confirmations = 0;
        wake(PENDING_IDLE_RECHECK_MS);
        return;
      }
      if (now() - holdStartedAt < PENDING_IDLE_CAP_MS && ++confirmations < PENDING_IDLE_CONFIRMATIONS) {
        wake(PENDING_IDLE_RECHECK_MS);
        return;
      }
    }
    holdStartedAt = null;
    confirmations = 0;
    const rule = detection.rule ?? FALLBACK_RULE;
    if (current?.state === detection.state) {
      if (current.rule !== rule) current = { ...current, rule };
      return;
    }
    current = { state: detection.state, rule, observedAt: new Date(now()).toISOString() };
    send(current);
  }

  // ONE TRANSITION IN FLIGHT PER TERMINAL, AND THE LATEST WINS. Two POSTs racing could land in the
  // wrong order and leave the service holding the older state until the next liveness frame.
  function send(activity) {
    queued = activity;
    if (sending) return;
    sending = true;
    (async () => {
      while (queued && !disposed) {
        const next = queued;
        queued = null;
        try {
          await report(next);
        } catch (error) {
          try { log(`screen state ${next.state} not delivered: ${error?.message || error}`); } catch { /* nothing left to tell */ }
        }
      }
      sending = false;
    })();
  }

  return {
    /** The process produced output. Cheap: at most it arms a timer. */
    noteOutput(chunk) {
      const sooner = String(chunk ?? "").includes(OSC);
      wake(sooner ? lastReadAt + throttleMs - now() : throttleMs);
    },
    /** The current observation, or null when there is none. */
    current: () => (current ? { ...current } : null),
    dispose() {
      disposed = true;
      if (timer) cancel(timer);
      timer = null;
      current = null;
    },
  };
}
