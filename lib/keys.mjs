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
//
// Ctrl+] IS THE ONE WAY BACK, from every mode. It leaves the pane, and it closes the picker. An
// operator learns one key rather than one per mode, and the picker cannot use ESC for the same
// reason the pane cannot.
//
// ── QUIT AND INTERRUPT ARE DIFFERENT ACTIONS, and conflating them would have reaped a fleet.
//
// Both `q` and Ctrl+C used to return "quit", which is right for `aify-env tui` -- a client, where
// leaving costs nothing. The DAEMON renders this same view in its own terminal, and there Ctrl+C
// means "stop the environment and take its managed processes with it". Handing that screen a
// keyboard while the two share one action leaves two ways to be wrong: swallow Ctrl+C in raw mode
// and the operator can no longer stop the daemon, or honour it for `q` too and one stray keystroke
// ends every agent on the host.
//
// So the CALLER decides what each means, and this file only says which key was pressed. `tui` treats
// both as leave; the daemon maps "interrupt" to its shutdown and ignores "quit" entirely.

/** 0x1d. Leaves `pty` mode, and closes the picker. The one way back, from anywhere. */
export const DETACH = String.fromCharCode(29);

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);
const BACKSPACE_ALT = String.fromCharCode(8);

/** The key that opens the picker. `g` for goto, which is what herdr binds it to. */
const PICKER_KEY = "g";

/** The starting point: watching the dashboard, nothing selected yet. */
export function initialFocus(count = 0) {
  return { mode: "dashboard", selected: count > 0 ? 0 : -1, count: Math.max(0, count), query: "" };
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
  // THE PICKER SURVIVES AN EMPTY LIST and the pane does not. A pane with nothing under it swallows
  // keys and sends them nowhere; a picker with nothing to show is a search that currently matches
  // nothing, which is a legitimate thing to be looking at while a host is starting work.
  if (n === 0) {
    return { mode: state?.mode === "picker" ? "picker" : "dashboard", selected: -1, count: 0, query: state?.query ?? "" };
  }
  // COERCED, not merely defaulted. `?? 0` catches null and undefined and NOT NaN, and
  // `Math.min(Math.max(0, NaN), n-1)` is NaN -- so a poisoned selection survived every refresh and
  // every arrow key, permanently. A focus that cannot be recovered by the thing whose job is
  // reconciling it is worse than one that resets.
  const requested = Number(state?.selected);
  const selected = Number.isFinite(requested) ? Math.min(Math.max(0, requested), n - 1) : 0;
  const mode = state?.mode === "pty" || state?.mode === "picker" ? state.mode : "dashboard";
  return { mode, selected, count: n, query: state?.query ?? "" };
}

/**
 * Decide what one chunk of input means.
 *
 * A CHUNK, NOT A KEY. A terminal delivers whatever arrived since the last read: a paste is one chunk of
 * many characters, and an arrow key is three bytes that must not be read as ESC then `[` then `A`. So
 * this takes the raw string and, in `pty` mode, passes it through WHOLE.
 *
 * @returns {{state: object, toPty: string|null, action: string|null}}
 *   `action` is one of null | "quit" | "interrupt" | "attach" | "detach" | "move" |
 *   "picker-open" | "picker-accept" | "picker-close" | "query".
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

  // ── picker mode ───────────────────────────────────────────────────────────────────────────────
  //
  // A FILTER OVER THE SAME LIST, not a second list. `selected` stays an index into whatever the
  // caller is showing, so this file needs to know nothing about names, labels or agents -- the
  // session narrows the list and reconciles the count, exactly as it does when a process exits.
  // That is what keeps the picker free of any idea of what a process IS.
  if (now.mode === "picker") {
    if (chunk === DETACH) {
      // The query is DROPPED on the way out, so the list the operator returns to is the whole one.
      // A filter that survived its own picker would leave a host looking half-empty with nothing on
      // screen to say why.
      return { state: { ...now, mode: "dashboard", query: "" }, toPty: null, action: "picker-close" };
    }
    if (chunk === CTRL_C) return { state: now, toPty: null, action: "interrupt" };
    if (chunk === "\r" || chunk === "\n") {
      return { state: { ...now, mode: "dashboard", query: "" }, toPty: null, action: "picker-accept" };
    }
    // ARROWS ONLY. `j` and `k` are text here, which is the whole reason a picker needs its own mode
    // rather than a flag on the dashboard one.
    if (chunk === UP) return move(now, -1);
    if (chunk === DOWN) return move(now, +1);
    if (chunk === BACKSPACE || chunk === BACKSPACE_ALT) {
      return { state: { ...now, query: now.query.slice(0, -1) }, toPty: null, action: "query" };
    }
    // AN ESCAPE SEQUENCE IS DROPPED FROM WHEREVER IT STARTS, not merely when the chunk begins with
    // one. Filtering on "printable" removes the ESC and keeps `[` and `C`, so a right arrow types a
    // literal `[C` into the filter, matches nothing, and reads as a broken picker.
    //
    // TESTING ONLY THE FIRST BYTE was the first attempt at this and it covered only the case it was
    // written for: a read that coalesces a typed character with a following arrow -- ordinary on a
    // daemon redrawing every two seconds while streaming PTYs -- delivers `a<ESC>[C` as ONE chunk,
    // and the defect came straight back. Everything from the first ESC onward is the sequence and
    // whatever follows it; what precedes it is what the operator actually typed, so that is kept.
    const escapeAt = chunk.indexOf(ESC);
    const typable = escapeAt >= 0 ? chunk.slice(0, escapeAt) : chunk;
    // PRINTABLE ONLY otherwise, because one chunk may be a paste of several characters.
    const typed = [...typable].filter((ch) => ch >= " " && ch !== BACKSPACE).join("");
    if (!typed) return stay();
    return { state: { ...now, query: `${now.query}${typed}` }, toPty: null, action: "query" };
  }

  // ── dashboard mode ────────────────────────────────────────────────────────────────────────────
  //
  // TWO DIFFERENT ACTIONS, not one. See the header: the daemon renders this same view and must keep
  // Ctrl+C meaning "stop the environment", while `q` must not be able to do that by accident.
  if (chunk === CTRL_C) return { state: now, toPty: null, action: "interrupt" };
  if (chunk === "q") return { state: now, toPty: null, action: "quit" };
  if (chunk === UP || chunk === "k") return move(now, -1);
  if (chunk === DOWN || chunk === "j") return move(now, +1);
  // JUMP STRAIGHT TO ONE, which is herdr's `prefix+1..9` without a prefix to hold: this view has no
  // pane keys to collide with, because everything typed at a process goes through `pty` mode.
  //
  // IT SELECTS RATHER THAN ATTACHING. The pane already follows the selection, so a digit shows that
  // agent immediately; attaching as well would put the keyboard inside a process from a single
  // keystroke, which is not a thing to do by accident.
  // ONE CHARACTER, and the length test is the whole of it. `chunk >= "1" && chunk <= "9"` is a
  // LEXICOGRAPHIC comparison, so `"1abc"`, `"3rd"` and `"2026-09-07"` all satisfy it -- and
  // `Number("1abc")` is NaN, which propagates into `selected` and poisons the focus for good:
  // `reconcileFocus`'s `?? 0` does not catch NaN, `(NaN + d + n) % n` is NaN, so every arrow after
  // that does nothing and the pane goes blank with no way back except another bare digit.
  //
  // A CHUNK IS NOT A KEY -- this file's own header says so -- and a paste is the ordinary way a
  // multi-character chunk arrives. Pasting a date into this view should do nothing, not brick it.
  if (chunk.length === 1 && chunk >= "1" && chunk <= "9") return jumpTo(now, Number(chunk) - 1);
  if (chunk === PICKER_KEY) {
    return { state: { ...now, mode: "picker", query: "" }, toPty: null, action: "picker-open" };
  }
  if (chunk === "\r" || chunk === "\n") {
    // NOTHING TO ATTACH TO IS NOT AN ERROR, it is an empty list. Entering `pty` mode with selected -1
    // would give the operator a pane that swallows their keys and sends them nowhere.
    // FAILS CLOSED. `now.selected < 0` is FALSE for NaN, so a poisoned index attached to nothing:
    // `pty` mode with no process under it, where every key -- Ctrl+C included -- is handed to a
    // target that does not exist and dropped. That is the "cannot stop the daemon" state this
    // design exists to rule out, reachable from one pasted string. A guard that passes when its
    // input is missing is decoration.
    if (!(now.selected >= 0) || now.count === 0) return stay();
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

/**
 * Select one row outright.
 *
 * OUT OF RANGE IS NOT AN ERROR, it is a key with nothing behind it. Pressing 7 on a host running
 * three agents must leave the selection where it was rather than clamp to the last row -- clamping
 * would make 4, 5, 6, 7, 8 and 9 all silently mean "the third one", which is worse than nothing
 * happening because the operator would believe they had jumped somewhere.
 */
function jumpTo(state, index) {
  if (state.count === 0 || index < 0 || index >= state.count) {
    return { state, toPty: null, action: null };
  }
  return { state: { ...state, selected: index }, toPty: null, action: "move" };
}
