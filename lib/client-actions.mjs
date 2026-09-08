// What a VIEW does when the operator confirms an action, for a client that owns no processes.
//
// TWO TIERS, TWO EXECUTORS, ONE VOCABULARY. The daemon renders this same view and can call its own
// runner; `aify-env tui` is a client on the other side of HTTP and has to ask. The words mean the
// same thing to an operator and the mechanism is completely different, which is exactly the split
// `quit` and `interrupt` already use -- so the view says WHICH action was chosen and the caller
// decides what that means.
//
// EXTRACTED SO IT CAN FAIL A TEST. Inside `bin/aify-env-tui.mjs` this logic is unreachable: importing
// that file STARTS a view that talks to a daemon, so nothing there has ever been exercised except by
// reading it. A source regex would prove the line was written, which is not the same as proving it
// does the right thing -- and this repo has been caught by that difference before.

/** Actions a client can perform. Restart is absent from BOTH tiers -- see `performClientAction`. */
export const CLIENT_ACTIONS = Object.freeze(["attach", "stop"]);

/**
 * Perform a confirmed action, or do nothing.
 *
 * ALREADY CONFIRMED BY THE TIME IT ARRIVES. `keys.mjs` turns a destructive choice into a question and
 * reports nothing until `y`, and the session resolves the target by IDENTITY against the current list
 * -- so this is handed a process the operator chose and that still exists, or it is not called at all.
 * It does not re-ask, and it must not: a second confirmation in a different layer is a prompt nobody
 * designed.
 *
 * ONLY `stop` REACHES THE WIRE. `attach` is the view's own business -- it moves the keyboard, it does
 * not touch the daemon -- and `restart` is nobody's here: respawning a managed agent is the service's
 * work and neither tier has a primitive for it. Running the one branch for every verb is how a future
 * `restart` would silently become a stop, which is the worst possible way to be wrong about a word.
 *
 * DELETE, AND IDEMPOTENT BY DESIGN. The daemon's route says so in as many words: a caller retrying a
 * stop, or a reaper racing one, must not get an error for having been second.
 *
 * NEVER THROWS. This runs inside a keyboard handler, and a request that did not land must not take
 * the operator's screen down. A failed stop shows as the process still being listed on the next
 * refresh, which is the honest signal -- the pane's own status is what reports a daemon that has
 * stopped answering.
 *
 * @returns {Promise<boolean>} whether a request was actually sent and accepted
 */
export async function performClientAction({ action, process: target }, { endpoint, fetchImpl = fetch } = {}) {
  if (action !== "stop") return false;
  const id = String(target?.id ?? "");
  if (!id) return false;
  const base = String(endpoint || "").replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/processes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      // NEVER FOLLOWED, for the same reason every other request in this product refuses: a 302 would
      // re-send this DELETE to whatever it points at, and a delete is not something to repeat at an
      // address nobody chose.
      redirect: "manual",
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}
