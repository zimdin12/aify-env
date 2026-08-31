// Where a keystroke goes: the dashboard, or the process in the pane.
//
// THE OPERATOR'S ASK was "a right-side per-terminal view with an input option". Input is the half that
// needs a decision on every byte, so the decision lives here as a PURE function -- state and a chunk
// in, a new state and a destination out. No terminal, no raw mode, no process: those belong to the
// caller, and keeping them out is what lets every routing rule be tested by calling a function.
//
// TWO MODES, because they want opposite things. In `dashboard` mode keys drive the view. In `pty` mode
// the pane is a terminal and virtually everything must reach the process -- including Ctrl+C, which an
// agent needs to interrupt its own work. A pane that swallowed Ctrl+C would be a worse terminal than
// the one it replaces.
//
// THE DETACH KEY IS Ctrl+] AND NOT ESCAPE, and that is not a style choice. ESC is the FIRST BYTE of
// every arrow, function and navigation key: the up arrow is ESC [ A. Detaching on a bare ESC would
// either fire whenever the operator pressed an arrow inside the pane, or need a timer to guess whether
// more bytes were coming -- the "escape ambiguity" every terminal program eventually meets. Ctrl+]
// (0x1d) is unambiguous, is what telnet used for the same job, and no agent TUI binds it.

/** 0x1d. Leaves `pty` mode and hands the keyboard back to the dashboard. */
export const DETACH = String.fromCharCode(29);

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);

/** The starting point: watching the dashboard, nothing selected yet. */
export function initialFocus(count = 0) {
  return { mode: "dashboard", selected: count > 0 ? 0 : -1, count: Math.max(0, count) };
}

/**
 * A selection that survives the list changing under it.
 *
 * PROCESSES COME AND GO WHILE THE PANE IS OPEN -- that is the normal case here, not an edge one, since
 * the whole point of the view is watching work start and finish. Clamping rather than resetting keeps
 * the operator near where they were looking; going back to the top on every spawn would make the pane
 * unusable on a busy host.
 */
export function reconcileFocus(state, count) {
  const n = Math.max(0, Math.floor(count) || 0);
  if (n === 0) return { mode: "dashboard", selected: -1, count: 0 };
  const selected = Math.min(Math.max(0, state?.selected ?? 0), n - 1);
  return { mode: state?.mode === "pty" ? "pty" : "dashboard", selected, count: n };
}

/**
 * Decide what one chunk of input means.
 *
 * A CHUNK, NOT A KEY. A terminal delivers whatever arrived since the last read: a paste is one chunk of
 * many characters, and an arrow key is three bytes that must not be read as ESC then `[` then `A`. So
 * this takes the raw string and, in `pty` mode, passes it through WHOLE.
 *
 * @returns {{state: object, toPty: string|null, action: string|null}}
 *   `action` is one of null | "quit" | "attach" | "detach" | "move".
 */
export function routeKey(data, state) {
  const chunk = String(data ?? "");
  const now = state && typeof state === "object" ? state : initialFocus(0);
  const stay = (extra = {}) => ({ state: now, toPty: null, action: null, ...extra });

  if (!chunk) return stay();

  if (now.mode === "pty") {
    // DETACH FIRST, and only when the chunk IS the detach byte -- not when it merely contains one.
    // A paste that happens to carry 0x1d is data the process asked for, and treating it as a command
    // would silently drop the rest of the paste.
    if (chunk === DETACH) {
      return { state: { ...now, mode: "dashboard" }, toPty: null, action: "detach" };
    }
    // EVERYTHING ELSE GOES THROUGH UNTOUCHED, Ctrl+C included. The process is the thing being typed
    // at; a router that filtered keys here would be deciding what an agent is allowed to be told.
    return { state: now, toPty: chunk, action: null };
  }

  // ── dashboard mode ────────────────────────────────────────────────────────────────────────────
  if (chunk === "q" || chunk === CTRL_C) {
    return { state: now, toPty: null, action: "quit" };
  }
  if (chunk === UP || chunk === "k") return move(now, -1);
  if (chunk === DOWN || chunk === "j") return move(now, +1);
  if (chunk === "\r" || chunk === "\n") {
    // NOTHING TO ATTACH TO IS NOT AN ERROR, it is an empty list. Entering `pty` mode with selected -1
    // would give the operator a pane that swallows their keys and sends them nowhere.
    if (now.selected < 0 || now.count === 0) return stay();
    return { state: { ...now, mode: "pty" }, toPty: null, action: "attach" };
  }
  return stay();
}

function move(state, delta) {
  if (state.count === 0) return { state, toPty: null, action: null };
  // WRAPS, because a list on a screen has no edges worth stopping at, and an operator holding a key
  // down should not have to notice they have hit the bottom.
  const next = (state.selected + delta + state.count) % state.count;
  return { state: { ...state, selected: next }, toPty: null, action: "move" };
}
