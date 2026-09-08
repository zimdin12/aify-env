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
//: Ctrl+L. The universal "redraw this screen" key, and the only recovery from a display
//: smeared by something outside this program -- a scroll, a resize nobody reported, another
//: writer. `frameUpdate` diffs against its own model of the screen and cannot notice.
const REPAINT = String.fromCharCode(12);

/** The key that opens the picker. `g` for goto, which is what herdr binds it to. */
const PICKER_KEY = "g";

/**
 * The key that opens the ACTIONS menu for the selected agent. `m` for menu.
 *
 * A MENU RATHER THAN A KEY PER ACTION, and that is the safety argument rather than a tidiness one.
 * Stop kills a live worker mid-turn; restart discards its context. Neither may be one keystroke away
 * on a list an operator navigates with arrows, because the 2026-07-02 incident was exactly that --
 * a sweep over a live ops UI fired real Stop controls and killed three workers. Two deliberate steps
 * to reach a destructive action, and a third to confirm it.
 */
const MENU_KEY = "m";

/** What the menu offers, in order. The CALLER performs them; this file only says which was chosen. */
export const MENU_ACTIONS = Object.freeze(["attach", "restart", "stop"]);

//: The ones that need a yes before they happen. Derived from a property -- "does this end work the
//: operator cannot get back" -- rather than listed twice, so adding a destructive action to the menu
//: above cannot quietly skip the confirmation.
const DESTRUCTIVE = Object.freeze(new Set(["restart", "stop"]));

/** Whether choosing this action must be confirmed before it is reported. */
export function needsConfirming(action) {
  return DESTRUCTIVE.has(String(action || ""));
}

/**
 * The key that shows or hides the right-hand pane. `p` for pane.
 *
 * THE OPERATOR ASKED FOR THIS AND SAID WHY: "I would rather see more agents and less notices, the
 * most useful thing in this is that I see what agent is working and what not." The pane takes HALF
 * the width, and on their screen the left column could not show all their agents while the right
 * showed one process's output. So the pane is a thing you ask for, not a thing you dismiss.
 *
 * WHICH IS WHY IT DEFAULTS TO HIDDEN -- see `initialFocus`. That is the half of this change that is
 * a decision rather than a mechanism, and it is theirs: statistics first, one keystroke to the
 * console. Attaching still opens it, because typing into a pane nobody can see is not a feature.
 */
const PANE_KEY = "p";

/**
 * The starting point: watching the dashboard, nothing selected yet, PANE HIDDEN.
 *
 * HIDDEN IS THE DEFAULT because the operator's stated priority for this view is seeing which agents
 * are working -- and the pane costs half the width to show one process. `p` brings it back and Enter
 * opens it on the way to attaching, so nothing is lost; what changes is which of the two you get
 * without asking.
 */
export function initialFocus(count = 0) {
  return {
    mode: "dashboard",
    selected: count > 0 ? 0 : -1,
    count: Math.max(0, count),
    query: "",
    paneHidden: true,
  };
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
    return {
      mode: state?.mode === "picker" ? "picker" : "dashboard",
      selected: -1,
      count: 0,
      query: state?.query ?? "",
      // CARRIED, and this is where a new field goes to die. Both returns here rebuild the state as a
      // literal, so a flag not named in BOTH is silently reset on the next snapshot -- and this view
      // reconciles every two seconds, so the operator would see their pane toggle itself back within
      // one refresh and read it as the key not working.
      paneHidden: paneHiddenIn(state),
    };
  }
  // COERCED, not merely defaulted. `?? 0` catches null and undefined and NOT NaN, and
  // `Math.min(Math.max(0, NaN), n-1)` is NaN -- so a poisoned selection survived every refresh and
  // every arrow key, permanently. A focus that cannot be recovered by the thing whose job is
  // reconciling it is worse than one that resets.
  const requested = Number(state?.selected);
  const selected = Number.isFinite(requested) ? Math.min(Math.max(0, requested), n - 1) : 0;
  const mode = state?.mode === "pty" || state?.mode === "picker" ? state.mode : "dashboard";
  // ATTACHED MEANS VISIBLE, whatever the flag says. `pty` mode with a hidden pane is a keyboard
  // pointed into a terminal nobody can see -- the operator types and the screen does not move.
  // Reconciling is where this is enforced rather than only at the moment of attaching, because the
  // mode can also survive a refresh that arrives with the flag set from anywhere else.
  const paneHidden = mode === "pty" ? false : paneHiddenIn(state);
  return { mode, selected, count: n, query: state?.query ?? "", paneHidden };
}

/**
 * Whether this state hides the pane, defaulting to HIDDEN for a state that has never heard of it.
 *
 * A CALLER'S OWN OBJECT REACHES THIS. `reconcileFocus` is documented as taking any state, the daemon
 * builds one, and the tests hand it literals -- so `state.paneHidden` is `undefined` on every one
 * written before this field existed. Defaulting to the same value `initialFocus` chooses keeps those
 * agreeing with a fresh session rather than quietly getting the other layout.
 */
function paneHiddenIn(state) {
  return state?.paneHidden !== false;
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
 *   "picker-open" | "picker-accept" | "picker-close" | "query" | "repaint".
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
    if (chunk === REPAINT) return { state: now, toPty: null, action: "repaint" };
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

  // ── confirm mode ──────────────────────────────────────────────────────────────────────────────
  //
  // FIRST, and it takes exactly three keys. A confirmation that also moved a cursor, opened a picker
  // or typed into a filter would be a prompt an operator can walk away from without answering -- and
  // the thing it is guarding is a live worker's turn.
  //
  // ANYTHING THAT IS NOT YES IS NO. `y` confirms; `n`, Ctrl+] and every other key cancel. A guard
  // whose default is "do it" is not a guard, and an operator who mistypes at a stop prompt must get
  // the harmless outcome.
  if (now.mode === "confirm") {
    if (chunk === "y" || chunk === "Y") {
      return {
        state: { ...now, mode: "dashboard", confirming: null },
        toPty: null,
        action: `confirmed:${now.confirming}`,
      };
    }
    return {
      state: { ...now, mode: "dashboard", confirming: null },
      toPty: null,
      action: "confirm-cancel",
    };
  }

  // ── menu mode ─────────────────────────────────────────────────────────────────────────────────
  //
  // A CURSOR OF ITS OWN. The dashboard's `selected` is an index into the PROCESS list and must not
  // move while a menu is open: the menu acts on the agent it was opened for, and an arrow key that
  // moved the selection underneath it would apply `stop` to whichever row the cursor drifted onto.
  if (now.mode === "menu") {
    if (chunk === DETACH) {
      return { state: { ...now, mode: "dashboard", menuAt: 0 }, toPty: null, action: "menu-close" };
    }
    if (chunk === CTRL_C) return { state: now, toPty: null, action: "interrupt" };
    if (chunk === UP || chunk === "k") return moveMenu(now, -1);
    if (chunk === DOWN || chunk === "j") return moveMenu(now, +1);
    if (chunk === "\r" || chunk === "\n") {
      const chosen = MENU_ACTIONS[now.menuAt] ?? MENU_ACTIONS[0];
      // A DESTRUCTIVE CHOICE BECOMES A QUESTION, not an action. The caller never sees `stop` until a
      // `y` has been pressed, so there is no path where a menu keystroke alone ends somebody's work.
      if (needsConfirming(chosen)) {
        return {
          state: { ...now, mode: "confirm", confirming: chosen, menuAt: 0 },
          toPty: null,
          action: `confirm:${chosen}`,
        };
      }
      return {
        state: { ...now, mode: "dashboard", menuAt: 0 },
        toPty: null,
        action: `chose:${chosen}`,
      };
    }
    // EVERY OTHER KEY IS IGNORED rather than falling through to the dashboard. A menu that let `q`
    // quit or a digit jump would act on the list behind it while the operator was reading the menu.
    return stay();
  }

  // ── dashboard mode ────────────────────────────────────────────────────────────────────────────
  //
  // TWO DIFFERENT ACTIONS, not one. See the header: the daemon renders this same view and must keep
  // Ctrl+C meaning "stop the environment", while `q` must not be able to do that by accident.
  if (chunk === CTRL_C) return { state: now, toPty: null, action: "interrupt" };
  // NOT IN `pty` MODE: inside a pane Ctrl+L belongs to the process, which clears its own screen
  // with it. Intercepting it there would take a key an agent uses from the agent.
  if (chunk === REPAINT) return { state: now, toPty: null, action: "repaint" };
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
  if (chunk === MENU_KEY) {
    // NOTHING SELECTED IS NOT AN ERROR, it is an empty list -- and a menu whose actions all name a
    // process that does not exist would offer to stop nothing.
    if (!(now.selected >= 0) || now.count === 0) return stay();
    return { state: { ...now, mode: "menu", menuAt: 0 }, toPty: null, action: "menu-open" };
  }
  if (chunk === PANE_KEY) {
    // A VIEW KEY, so it stays in `dashboard` mode: nothing about the selection or the picker changes,
    // only whether the console beside the list is drawn. In `pty` mode `p` is the letter p and reaches
    // the process, and in the picker it is a character of the query -- both handled above, which is
    // the reason those modes return before this point rather than checking a flag here.
    return {
      state: { ...now, paneHidden: !paneHiddenIn(now) },
      toPty: null,
      action: "pane-toggle",
    };
  }
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
    // ATTACHING SHOWS THE PANE. Enter with the pane hidden would otherwise hand the keyboard to a
    // process whose output is not on screen: every key goes somewhere real and nothing visibly
    // happens, which is indistinguishable from a frozen view and is how an operator ends up typing
    // into an agent they cannot read.
    return { state: { ...now, mode: "pty", paneHidden: false }, toPty: null, action: "attach" };
  }
  return stay();
}

/** The menu's own cursor, which WRAPS like the list's and never touches `selected`. */
function moveMenu(state, delta) {
  const n = MENU_ACTIONS.length;
  const at = Number.isFinite(state.menuAt) ? state.menuAt : 0;
  return {
    state: { ...state, menuAt: (at + delta + n) % n },
    toPty: null,
    action: "menu-move",
  };
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
