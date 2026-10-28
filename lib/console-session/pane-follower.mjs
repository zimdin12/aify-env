// The console pane's stream: which process it follows, whether the terminal can draw it, and what the last frame
// drawn of it showed. ConsoleSession decides WHICH process; this owns the connection to it and the evidence that the
// operator can see it, which is what input is gated on.
//
// A FOLLOWER IS A CONNECTION, so swapping one is not free and must not happen by accident. `follow` is the only thing
// that opens or closes a stream; a refresh that names the same process must not churn it, or an operator scrolling a
// busy host would open and abandon a connection per keypress.

import { MIN_COLUMNS_FOR_PANE } from "../console-view.mjs";
import { FAILED, OutputFollower, STREAMING } from "../output-follower.mjs";
import { paintedRowCount } from "../screen-render.mjs";

export class PaneFollower {
  #makeFollower;
  #onProgress;
  #now;
  #retryMs;
  #follower = null;
  #watchedId = null;
  #openedAt = 0;
  //: Unknown until a caller says so, and unknown means NOT drawable. See `canDraw`.
  #columns = null;
  //: Whether the LAST draw actually put a pane on the screen. False until something says so -- readiness is an
  //: observation, and an unobserved pane is not a readable one.
  #rendered = false;
  //: WHAT THE FRAME THAT WAS DRAWN ACTUALLY SHOWED, captured with it.
  //:
  //: `#rendered` says a frame reached the screen; it does not say WHICH. Reading the follower's current problem
  //: beside a cached "a frame was drawn" mixes an observation of the past with a reading of the present, and the two
  //: disagree exactly where it matters: a refusal is drawn, the stream then recovers, nothing is drawn again, and the
  //: gate reports the pane readable while the operator is still looking at "waiting for the first full repaint".
  //:
  //: Empty means the last frame showed the process. Non-empty means it showed a notice about it, and typing into
  //: that is typing at a screen the operator has been told they are not seeing.
  #renderedProblem = "";
  //: AND WHETHER THAT FRAME WAS A STREAMING ONE, which the problem alone cannot say. A pane that is still CONNECTING
  //: has an empty buffer, so `paneProblem()` returns "" and the frame records as clean -- it has nothing wrong with
  //: it, it simply is not the process yet. Readiness then combined that clean record with the LIVE status, so the
  //: instant the stream opened, input was granted against a frame drawn before it did. Measured: the last frame
  //: written still said "connecting..." while a keystroke reached the process. (External review of `25818dc`.)
  #renderedStreaming = false;

  /**
   * `makeFollower` is injected so the whole lifecycle is testable without a daemon: the default builds a real
   * `OutputFollower`, and a test hands in something that records what it was asked for.
   * @param {{endpoint?: string, fetchImpl?: Function, makeFollower?: Function|null, onProgress?: Function|null,
   *   now: () => number, retryMs: number}} deps
   */
  constructor({ endpoint = "", fetchImpl = undefined, makeFollower = null, onProgress = null, now, retryMs }) {
    this.#onProgress = onProgress;
    this.#now = now;
    this.#retryMs = retryMs;
    this.#makeFollower = makeFollower || ((id) => new OutputFollower({ endpoint, id, ...(fetchImpl ? { fetchImpl } : {}) }));
  }

  /** The open stream, or null. */
  get follower() { return this.#follower; }
  /** The process the open stream follows, or null. */
  get watchedId() { return this.#watchedId; }
  /** Whether the last frame drawn put a pane on the screen. */
  get rendered() { return this.#rendered; }

  /**
   * Follow `target` (a process id), or nothing when it is null.
   *
   * A FAILED STREAM IS OPENED AGAIN, after a pause (v0.7 scan, F7). This used to return whenever the target was
   * unchanged, so a daemon restart or a dropped connection left the pane reading `unavailable` until the operator
   * moved off the row and back. EXITED and GONE are facts about the process and stay final; FAILED is a fact about the
   * connection.
   */
  follow(target) {
    if (target === this.#watchedId && !(target && this.#retryIsDue())) return;

    // THE OLD STREAM IS CLOSED BEFORE THE NEW ONE OPENS. Leaving it running would keep a connection and a growing
    // buffer alive for a process nobody is looking at, once per selection move.
    this.close();
    // READINESS BELONGS TO THE FRAME, AND THE FRAME IS ABOUT A PROCESS. Switching agents kept the previous pane's
    // `#rendered`, so the first keystroke after attaching to a NEW process was forwarded before anything of that
    // process had been drawn -- review measured input reaching bravo while the captured frame count stayed at three.
    // An observation about alpha is not evidence about bravo.
    this.#rendered = false;
    if (!target) return;
    this.#watchedId = target;
    this.#openedAt = this.#now();
    const follower = this.#makeFollower(target);
    this.#follower = follower;
    // BOUND TO THIS FOLLOWER, and checked against the CURRENT one before it is passed on. A follower whose stream is
    // still draining after the operator moved on will keep reporting progress, and a repaint driven by it would be
    // drawing one process's arrival into another process's pane. Comparing identity is the check; a flag would have
    // to be cleared correctly on every path out, and one of those paths is a rejected promise.
    follower.onProgress = () => {
      if (this.#follower === follower) this.#onProgress?.();
    };
    // Deliberately not awaited: the render loop must not block on a connection, and the follower reports its own
    // state through `status` rather than through a rejection.
    Promise.resolve(follower.start?.()).catch(() => {});
  }

  /** Close the stream, if one is open. Safe to call twice. */
  close() {
    try {
      this.#follower?.stop?.();
    } catch {
      // A follower that throws on stop has already stopped mattering.
    }
    this.#follower = null;
    this.#watchedId = null;
  }

  /** How wide the terminal is. A width that is not a number is unknown, and unknown is not drawable. */
  noteColumns(columns) {
    const width = Number(columns);
    this.#columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : null;
  }

  /**
   * Whether a pane can actually be put on this terminal.
   *
   * FAILS CLOSED ON AN UNREPORTED WIDTH. A caller that never said how wide it is cannot be shown to be drawable, and
   * the cost of guessing wrong is blind typing into a live agent. Refusing is the recoverable direction: a caller that
   * forgets to report loses attach VISIBLY, where a permissive default would hand it invisible input. A guard that
   * passes when its input is missing is decoration.
   */
  canDraw() {
    return this.#columns !== null && this.#columns >= MIN_COLUMNS_FOR_PANE;
  }

  /**
   * A pane frame actually reached the screen, or did not. Returns whether it did.
   *
   * TOLD BY THE THING THAT DREW IT, because nothing else can know. `canDraw` proves the layout would PERMIT a pane;
   * it cannot prove one was rendered, and review reproduced the difference: input forwarded while the follower was
   * still connecting, while it had failed with a 503 or a 404, after the process had exited, and into a one-row screen
   * carrying only a header. In every one of those the operator is typing at something they cannot read.
   */
  noteRendered(rendered) {
    this.#rendered = rendered === true;
    // CAPTURED WITH THE FRAME, not read later. This is the whole of the correction: readiness is an observation about
    // the frame that WAS written, and the follower's problem is part of what that frame said.
    //
    // THE `: ""` BRANCH IS NOT REACHABLE BY ANY READER TODAY, and that is stated rather than tested: `inputIsLive`
    // consults `#rendered` first, which is false in exactly that case, so no mutant can tell a cleared record from a
    // stale one. It is kept so the field never holds a claim about a frame that was not drawn -- a reader added later
    // would have no way to know it might be lying.
    this.#renderedProblem = this.#rendered ? String(this.#follower?.paneProblem?.() || "") : "";
    // AND THE STREAMING STATE OF THE FRAME, for the same reason and a case the problem cannot see. "Nothing is wrong"
    // and "this is the process" are different claims, and a connecting pane satisfies the first while failing the
    // second.
    this.#renderedStreaming = this.#rendered && this.#follower?.status === STREAMING;
    return this.#rendered;
  }

  /**
   * Whether a keystroke may reach the process right now.
   *
   * THREE THINGS, AND ALL OF THEM ARE ABOUT WHAT THE OPERATOR CAN SEE: the terminal is wide enough, a pane frame
   * actually rendered, and the stream is LIVE. A pane showing "connecting", an exit notice or a failure is a rendered
   * frame and still not a place to type -- the keys would go nowhere and the screen would not move, which is
   * indistinguishable from the view being frozen.
   */
  inputIsLive() {
    return this.canDraw()
      && this.#rendered === true
      && this.#follower?.status === STREAMING
      // AND WHAT WAS DRAWN IS THE PROCESS, not a notice about it. A pane can be current, wide enough and streaming
      // while what it SHOWS is "waiting for the first full repaint" -- and typing into that is typing at a screen the
      // operator has explicitly been told they are not seeing.
      //
      // BOTH READINGS, AND THAT IS THE FIX RATHER THAN A BELT-AND-BRACES. The first asks what the frame on screen
      // shows; the second asks whether anything has gone wrong since it was drawn. Asking only the second passed the
      // moment a stream recovered, because a cached "a frame was drawn" was being read beside a live problem -- so
      // input flowed while the refusal was still the last thing written. Asking only the first would miss a stream
      // that broke after a good frame. They are different questions about different moments and both have to be clear.
      && !this.#renderedProblem
      // AND THE FRAME THAT WAS DRAWN WAS A STREAMING ONE. `#renderedProblem` cannot answer this: a connecting pane
      // holds no bytes, so it reports no problem, and a clean record drawn before the stream opened was being read
      // beside a live `STREAMING` status. The two together said "a good frame is on screen and the stream is up" about
      // two different moments.
      && this.#renderedStreaming === true
      && !this.#follower?.paneProblem?.();
  }

  /**
   * What `composeConsole` needs for `process_`, or null when there is no process or no stream.
   * @param {object|null} process_ the selected process
   * @param {{attached: boolean}} how whether the keyboard is on the pane
   */
  pane(process_, { attached }) {
    const follower = this.#follower;
    if (!process_ || !follower) return null;
    return {
      id: process_.id,
      label: process_.label,
      status: follower.status,
      exit: follower.exit,
      attached,
      //: WHY KEYS ARE BEING DROPPED WHILE ATTACHED, or "" when they reach the process (v0.7 scan, F6). The mode stays
      //: `pty` while the pane shows a refusal notice or a stream that is not live, and the title and hint said
      //: "typing here" over keys that went nowhere.
      inputPaused: attached ? this.#inputPauseReason() : "",
      //: The width the process actually paints at, so the title can say when the pane is showing only part of it. 0
      //: when the producer never said -- an older daemon, or a piped process -- and 0 means "do not claim anything",
      //: not "80".
      screenCols: follower.meta?.cols ?? 0,
      //: HOW MANY ROWS THE SCREEN HAS PAINTED, so the title can say when some are above the pane's live edge. Not the
      //: PTY's height: a tall PTY with a short screen shows all of it (v0.7.1 review, E4). A getter, so the screen is
      //: read only by the title that asks.
      get paintedRows() { return paintedRowCount(follower.screen?.rows?.() ?? []); },
      //: WHICH UNICODE VERSION THE SCREEN MEASURES WITH. `@xterm/addon-unicode11` is separately optional, and without
      //: it a bare headless terminal measures at version 6 -- where an emoji is ONE cell rather than two, so every
      //: character after one sits in a different column. Measured: at five columns `123<emoji>X` wraps X to row 2 at
      //: version 11 and leaves it on row 1 at version 6, where a narrow pane crops it away entirely. That is a
      //: different screen, not a cosmetic difference, so it is said rather than absorbed.
      screenUnicode: follower.screen?.unicodeVersion ?? "",
      //: The stream open WHEN THE LINES ARE ASKED FOR, as it always was, not the one this pane was built from.
      lines: (opts) => this.#follower.lines(opts),
    };
  }

  /** Whether the open stream has FAILED and has been failed for long enough to try again. */
  #retryIsDue() {
    return this.#follower?.status === FAILED
      && this.#now() - this.#openedAt >= this.#retryMs;
  }

  /**
   * What the pane about to be drawn says instead of the process, or "" when it shows the process.
   *
   * THE SAME TWO FACTS `inputIsLive` READS about the live stream: its status and its problem. Asked of the frame being
   * drawn, so the title is right on the frame that grants input, not one late.
   */
  #inputPauseReason() {
    const status = String(this.#follower?.status ?? "");
    if (status !== STREAMING) return status || "no stream";
    return String(this.#follower?.paneProblem?.() || "");
  }
}
