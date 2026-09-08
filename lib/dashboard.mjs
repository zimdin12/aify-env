// Collecting what the dashboard shows, and driving it — with no lifecycle of its own.
//
// This moved out of bin/aify-env-tui.mjs so the DAEMON can render the same view in its own terminal.
// The script version owned its refresh timer AND its SIGINT handler, and that handler called
// process.exit(0) directly. Embedding it in the daemon would have put a second exit path beside the
// one in lib/shutdown.mjs -- the exact defect removed from this repo today, where two handlers raced
// and the one that stopped nothing usually won.
//
// So nothing here registers a signal handler or exits. `startDashboard` returns a `stop()` and the
// caller decides what a signal means: the script exits, the daemon tears its processes down first.
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

import { readServices, probeService } from "./services.mjs";
import { collectEnvironmentChecks } from "./environment-report.mjs";
import { credentialRoot, listCredentialStore } from "./credential-fs.mjs";
import { terminalSupport } from "./runner.mjs";
import { frameUpdate } from "./frame.mjs";
import { renderDashboard } from "./tui.mjs";
import { composeConsole, dashboardColumns, paneWillBeDrawn } from "./console-view.mjs";
import { ConsoleSession } from "./console-session.mjs";

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
  for (const service of readServices(registryText)) {
    const check = probeService(service, await ask(`${service.endpoint}/health`));
    services.push({ ...service, state: check.state, detail: check.detail });
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
    });
  } catch {
    checks = [];
  }

  return {
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
 * Draw once, then keep drawing.
 *
 * NO SIGNAL HANDLER AND NO EXIT. Returns `{ stop }`; what an interrupt means belongs to the caller,
 * and in the daemon it means "take the managed processes with you", which this module must not
 * pre-empt.
 *
 * @returns {Promise<{stop: () => void}>} resolved after the FIRST frame, so a caller can await a
 *   visible screen before doing anything else.
 */
export async function startDashboard({
  endpoint,
  registryPath,
  write = (text) => process.stdout.write(text),
  clearScreen = true,
  intervalMs = 2000,
  // HOW OFTEN ARRIVING OUTPUT MAY REDRAW THE PANE, which is a different question from how often the
  // roster is re-collected. `intervalMs` bounds an HTTP round trip; this bounds a render, and a
  // render measured 0.9ms at 40 processes. Separate values because they are separate costs.
  paneRepaintMs = 80,
  once = false,
  // Defaults suit a pipe, not a terminal: no colour, a conservative width. The caller that knows it
  // owns a screen says so, and NO_COLOR is honoured there rather than sniffed here.
  columns = 100,
  color = false,
  // WHERE THE DAEMON'S OWN MESSAGES GO once this view owns the screen. Optional: a caller that is
  // not taking over a terminal keeps writing to stderr, which is right for a pipe or a log.
  notices = null,
  rows = 24,
  // THE CONSOLE IS OPT-IN, and off by default on purpose. This function is called by a script with
  // `--once`, by a test, and by the daemon's own startup banner; none of those owns a keyboard, and a
  // view that opened a process stream because it happened to be imported would be doing IO nobody
  // asked for. The binary that knows it owns a terminal passes `input`.
  input = null,
  // NAMED RATHER THAN LEFT IN `collectOptions`, because the console needs it too. It was spread into
  // `collectSnapshot` alone at first, so the follower quietly used the global `fetch` while a caller
  // believed it had injected one -- which made a test that watched for opened streams unable to
  // observe any, in either direction. A positive control caught it: the test asserting a stream IS
  // opened failed, and that is the only reason the one asserting none is opened means anything.
  fetchImpl = undefined,
  // What to do when the operator asks to leave, and where keys meant for a process go. Both
  // belong to the binary that owns the lifecycle -- this module deliberately owns none, which is
  // why the daemon's interrupt can stop its managed processes rather than being pre-empted by a
  // view's exit handler.
  onQuit = null,
  // WHAT Ctrl+C MEANS HERE, which is not the same question as what `q` means.
  //
  // In `aify-env tui` -- a client -- leaving costs nothing and both keys mean the same thing, so a
  // caller that says nothing about interrupt gets exactly today's behaviour. The DAEMON renders this
  // same view in the terminal it was started from, and there Ctrl+C means "stop the environment and
  // take its managed processes with it". That is why the daemon's view had no keyboard at all until
  // now: one action for both keys left two ways to be wrong -- swallow Ctrl+C in raw mode and the
  // daemon cannot be stopped from its own terminal, or honour `q` the same way and one stray
  // keystroke reaps every agent on the host.
  onInterrupt = null,
  //: Called with `{action, process}` once an action has been chosen AND, where it ends work,
  //: confirmed. Absent means the menu is visible and inert -- see the call site for why that is
  //: the honest default rather than a fallback.
  onAction = null,
  //: WHICH AGENTS THIS HOST COULD START, and starting one. Two callbacks rather than one, because
  //: they are asked at different moments: the list is fetched when the operator opens it, and a
  //: start happens when they choose. A caller that supplies neither gets a list that says it is
  //: asking and never answers -- so `onStartList` absent means the mode is honestly inert, exactly
  //: as an absent `onAction` leaves the menu visible and inert.
  onStartList = null,
  onStartAgent = null,
  //: Which of them this caller can actually perform. Forwarded to the session, which puts it on
  //: the focus so the router and the renderer agree about what is on offer.
  actions = null,
  onInput = null,
  ...collectOptions
} = {}) {
  // The frame currently on screen, so the next one can be a DIFFERENCE rather than a repaint.
  // Empty means we have not painted yet, which is what makes the first frame clear.
  let previousLines = [];

  // ONE SESSION FOR THE WHOLE RUN, because a follower is a connection and rebuilding it per frame
  // would abandon one every two seconds. It owns the selection and the stream; this loop owns
  // neither.
  //: Coalesces pane progress into at most one repaint per `paneRepaintMs`. Null when none is due.
  let paneRepaintTimer = null;
  //: WHEN THE PANE HAS SOMETHING NEW, DRAW IT -- at a bounded rate.
  //:
  //: THIS IS A CORRECTNESS PATH, not a nicety. Input is gated on a STREAMING frame having been
  //: drawn, and the refresh timer used to be the only thing that ever redrew, so attaching left the
  //: console refusing keys against "connecting..." for up to `intervalMs`. It is also why the pane
  //: updated at 0.5 frames a second while the bytes were arriving continuously.
  //:
  //: BOUNDED, because the alternative is a repaint per chunk from a producer that emits thousands a
  //: second. A frame measured 0.9ms at 40 processes, so this floor costs about 1% of a core while a
  //: console is open and nothing at all when one is not: no pane, no follower, no progress.
  const notePaneProgress = () => {
    if (stopped || paneRepaintTimer) return;
    paneRepaintTimer = setTimeout(() => {
      paneRepaintTimer = null;
      // CHECKED AGAIN HERE. `stop()` can land while this timer is pending, and a frame painted
      // during teardown lands over whatever the shutdown is printing.
      if (!stopped) repaint();
    }, paneRepaintMs);
    paneRepaintTimer.unref?.();
  };

  const console_ = input
    ? new ConsoleSession({ endpoint, fetchImpl, actions, onProgress: notePaneProgress })
    : null;

  // THE SIZE IS NOT FIXED FOR THE LIFE OF THE VIEW, and treating it as though it were is what put
  // stale characters on the operator's screen. `columns` and `rows` were read ONCE at startup, so
  // resizing the window left the frame painting at the old width -- wider rows leave a tail nothing
  // erases, narrower ones wrap and desynchronise `frameUpdate`'s absolute row addressing.
  //
  // THE CALLER STILL OWNS THE TERMINAL. This module deliberately never reads `process.stdout`; the
  // binary that knows it owns a screen calls `resize()`, exactly as it already decides colour.
  let liveColumns = columns;
  // THE SESSION HAS TO BE TOLD, and it refuses to attach until it is. Only the caller that owns
  // the terminal knows its width, and below `MIN_COLUMNS_FOR_PANE` the compositor draws no pane
  // at all -- which is where input used to keep flowing into a process with no screen on it.
  console_?.noteViewport({ columns: liveColumns });
  let liveRows = rows;

  // STOPPED IS CHECKED AFTER THE AWAIT, not only before the timer is cleared. Collecting a snapshot
  // is IO: `stop()` can land while one is in flight, and clearing the interval does nothing about a
  // frame that has already begun. It painted one more screen after the operator quit.
  //
  // Latent until it was not. The collection used to be two HTTP knocks and finished inside the gap;
  // adding the health checks made it long enough for the race to be the normal case, and its own
  // test caught it -- "frames kept arriving after stop(), 4 !== 3". In the daemon that frame lands
  // during teardown, over whatever the shutdown is printing.
  let stopped = false;

  //: The last snapshot drawn, so a redraw that needs no new facts can reuse it. Null until the
  //: first collection lands, which is why `repaint` does nothing before then.
  let lastSnapshot = null;

  const render = (snapshot) => {
    // Read at RENDER time, not at start: the whole point is the messages that arrive while this runs.
    if (notices) snapshot.notices = notices.recent();
    if (stopped) return;
    // The session reconciles against every snapshot, so a process appearing or finishing moves the
    // selection with it rather than leaving the pane pointed at something that is gone.
    console_?.syncProcesses(snapshot.processes);
    const lines = composeConsole({
      // DERIVED FROM WHAT THIS CALL WAS ACTUALLY GIVEN, never passed in separately. `input` is the
      // keyboard and `onQuit` is whether leaving is on offer, so the hint on screen cannot disagree
      // with what the keys will do -- which is the failure a second flag would eventually produce.
      dashboardLines: renderDashboard(snapshot, {
        // THE WIDTH IT WILL ACTUALLY GET, asked before drawing. `composeConsole` receives the frame
        // already rendered, so handing it a full-width one and letting it cut produced a left column
        // with `io`, `up` and `title` gone and every heading rule sliced mid-rule.
        columns: dashboardColumns(liveColumns, Boolean(console_?.pane())),
        color,
        // AND THE HEIGHT, so the process table can be windowed around the selection rather than
        // running off the bottom of a terminal that clamps every row past the last one onto it.
        rows: liveRows,
        keys: { enabled: Boolean(input), canQuit: Boolean(onQuit) },
        // FROM THE SESSION THAT OWNS THE SELECTION, never recomputed here. Two places deriving the
        // visible list would agree until one learned about a new filter, and the symptom would be a
        // cursor sitting on a row the keyboard is not actually on.
        view: console_ ? {
          rows: console_.visible(),
          selected: console_.focus.selected,
          mode: console_.focus.mode,
          query: console_.focus.query,
          //: So the hint can say "show" or "hide" rather than making the operator press it to find out.
          paneHidden: console_.focus.paneHidden,
          //: And which actions this caller can perform, so the menu draws no row it cannot run.
          menuActions: console_.focus.menuActions,
          menuAt: console_.focus.menuAt,
          confirming: console_.focus.confirming,
          //: WHICH agent the open menu is about, so the prompt and the executor name the same
          //: one. Without it the prompt indexed the cursor while `y` acted on the bound id.
          actionTargetId: console_.actionTargetId,
          //: THE AGENTS THIS HOST COULD START, from the session that owns that list too. A second
          //: derivation here would be a second answer to one question, which is how a cursor ends
          //: up on a row the keyboard is not on.
          start: console_.startView(),
        } : null,
      }),
      pane: console_?.pane() ?? null,
      //: The SAME decision the dashboard beside it made, never a second one. Two answers here
      //: is a coloured pane beside a colourless list, or escapes in a piped render.
      color,
      columns: liveColumns,
      rows: liveRows,
    });
    // ONLY WHAT CHANGED, when we own a screen. The old loop cleared and repainted every row twice a
    // second whether or not one character differed, which the eye reads as flicker and which a side
    // pane with live output in it could not survive. `frameUpdate` writes nothing at all for an
    // unchanged frame; see lib/frame.mjs for why the first one still clears.
    //
    // A PIPE IS NOT A SCREEN, and that distinction is why `clearScreen` still gates this. Escapes in
    // a log are noise, and a service manager parsing this output would get cursor moves interleaved
    // with the banner. Redirected output keeps the plain full write it has always had.
    // WHETHER A PANE FRAME ACTUALLY REACHED THE SCREEN, reported AFTER the write rather than decided
    // before it. This is the readiness the session gates input on, and only this function can know
    // it: `canDrawPane` proves the layout would permit a pane, and review reproduced input flowing
    // while the follower was connecting, after a 503 or 404, after the process exited, and into a
    // one-row header-only screen. An operator typing at something they cannot read is the defect.
    //
    // A THROWN WRITE REPORTS FALSE, which is the case a "would it fit" check can never see: the
    // layout was fine and nothing landed.
    // ASKED THROUGH THE COMPOSITOR'S OWN PREDICATE, not inferred from the session having a pane to
    // show. Those two answer differently below the pane's minimum width -- the session still HAS a
    // pane there and the compositor draws none.
    //
    // NO MUTANT CAN CURRENTLY KILL THAT PRECISION, and it is worth saying so rather than implying it
    // is load-bearing: attaching is already refused below the minimum and narrowing revokes an
    // existing attachment, so the state where they disagree is not reachable through the input path
    // today. It is kept because it makes ONE fact have ONE source -- a design rule rather than a
    // guard -- and because the thing that would make it reachable is any future path that enters
    // `pty` mode without going through the width check.
    const drewAPane = paneWillBeDrawn(console_?.pane() ?? null, liveColumns, liveRows);
    try {
      if (clearScreen) {
        const bytes = frameUpdate(previousLines, lines);
        // CACHED AFTER THE WRITE SUCCEEDS, never before. Caching first meant a FAILED frame still
        // recorded those lines as on screen -- so re-entering the same state produced no bytes at
        // all, and a readiness that the failure had revoked came straight back with nothing having
        // been drawn. Review measured input reaching bravo while a display oracle fed only
        // successful writes still showed alpha. An intention is not a frame.
        if (bytes) write(bytes);
        previousLines = lines;
      } else {
        write(`${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
      }
    } catch (error) {
      console_?.notePaneRendered(false);
      throw error;
    }
    console_?.notePaneRendered(drewAPane);
  };

  /**
   * Ask the daemon for the world, then draw it.
   *
   * COLLECTING IS IO AND RENDERING IS NOT, and until now they were one function. Every branch of the
   * key handler ended in this, so moving the cursor one row re-asked the daemon for everything
   * before the screen moved -- MEASURED at `1 + N` round trips per keystroke, N being the registered
   * services, which is 2 on a host running aify-comms. A key changes the SELECTION, and no request
   * can tell us anything about that.
   */
  const draw = async () => {
    // WIDTH AND COLOUR ARE DECIDED HERE, once, and handed to a pure renderer. Reading them inside the
    // view would make the same snapshot render differently in a test than on a screen.
    const snapshot = await collectSnapshot({
      endpoint, registryPath, ...(fetchImpl ? { fetchImpl } : {}), ...collectOptions,
    });
    if (stopped) return;
    lastSnapshot = snapshot;
    render(snapshot);
  };

  /**
   * Draw again from the facts already in hand.
   *
   * THE SAME RENDER, NOT A LIGHTER ONE. Reconciliation, composition and the readiness report all run
   * exactly as they do after a collection; the only difference is that the roster may be up to
   * `intervalMs` old, which is what every other terminal view also shows between refreshes.
   *
   * SWALLOWS, because the calls it replaced did: a keystroke that could not be drawn must not kill
   * the view, and the next frame still draws.
   */
  const repaint = () => {
    if (!lastSnapshot) return;
    try {
      render(lastSnapshot);
    } catch {
      // The next frame still draws.
    }
  };

  await draw();
  if (once) return { stop: () => {} };

  // A frame that throws must not kill the loop: the usual reason to have this open is watching for
  // the moment something comes back.
  const timer = setInterval(() => { draw().catch(() => {}); }, intervalMs);
  // Never hold the process open on its own account. A daemon exits when its own work says so.
  timer.unref?.();

  // RAW MODE IS THE CALLER'S TERMINAL, so it is restored on the way out no matter which way we leave.
  // A view that exits leaving the terminal in raw mode hands the operator a shell that no longer
  // echoes what they type, and the fix for that is not obvious to anyone it happens to.
  let onData = null;
  const rawWasOn = Boolean(input?.isRaw);
  if (input) {
    input.setRawMode?.(true);
    input.resume?.();
    onData = (chunk) => {
      // NOTHING A CALLBACK DOES MAY REACH THE STREAM. This runs as a `data` listener, so a callback
      // that throws becomes an uncaught exception and the view dies on a keypress -- which a test
      // caught here, having been written on the assumption it could not happen.
      try {
        const { quit, interrupt, toPty, action, perform, startAgent } = console_.handleInput(String(chunk));
        // OPENING THE LIST ASKS FOR IT. Not awaited: this runs inside a `data` listener and a slow
        // service must not hold the keyboard. The screen says it is asking until an answer lands,
        // which is why an unanswered list cannot be drawn as an empty one.
        if (action === "start-open" && onStartList) {
          Promise.resolve(onStartList())
            .then((answer) => {
              console_.noteStartable(answer?.agents, answer?.problem, answer?.service);
              repaint();
            })
            .catch((error) => {
              // A REFUSAL IS AN ANSWER. Reporting it as one is what stops the screen saying
              // "asking" for ever after a service went away mid-request.
              console_.noteStartable([], String(error?.message || error));
              repaint();
            });
        }
        // AND CHOOSING ONE STARTS IT, through the caller for the same reason `perform` goes there:
        // the daemon can reach its own plugin, a `tui` client has to ask over HTTP.
        if (startAgent && onStartAgent) {
          Promise.resolve(onStartAgent(startAgent)).catch(() => {});
        }
        // A CONFIRMED ACTION GOES TO THE CALLER, never performed here. What `stop` MEANS differs
        // between the two callers of this view -- the daemon can reach its own runner, a `tui` client
        // has to ask over HTTP -- which is the same split `quit` and `interrupt` already use.
        //
        // A CALLER THAT SUPPLIED NO HANDLER GETS THE MENU AND NOT THE ACTIONS. That is the honest
        // shape while the handlers are being built: the operator sees what is coming, nothing
        // happens, and nothing pretends to have happened. It is also why this is not `?? onQuit` --
        // there is no sensible fallback for "stop this agent".
        if (perform) onAction?.(perform);
        // FALLS BACK TO `onQuit`, so a caller that only knows about quitting behaves exactly as it
        // did before this split existed. A caller that wants the two separated says so.
        if (interrupt) return void (onInterrupt ?? onQuit)?.();
        if (quit) return void onQuit?.();
        // `toPty` is handed back rather than written from in here, because writing to a process is
        // the daemon's business and this is a view. The binary decides.
        // A FULL REPAINT ON REQUEST. `frameUpdate` writes only rows that CHANGED against its own
        // model of the screen, so anything that disturbs the screen from outside -- scrolling back,
        // another program writing, a resize we did not hear about -- leaves rows it will never
        // rewrite. Every terminal program binds Ctrl+L for exactly this, and until now there was no
        // way to recover a smeared screen short of restarting the view.
        if (action === "repaint") previousLines = [];
        if (toPty !== null) onInput?.(console_.selected, toPty);
      } catch {
        // A keystroke that could not be handled is not worth the screen. The next frame still draws.
      }
      // NO REFETCH. A key changes the selection, and the daemon has nothing to say about that.
      repaint();
    };
    input.on("data", onData);
  }

  return {
    /**
     * The terminal changed size. Repaints in full rather than diffing, because every row's content
     * and position may have moved and the previous frame is no longer a description of the screen.
     */
    resize: ({ columns: nextColumns, rows: nextRows } = {}) => {
      if (Number.isFinite(nextColumns) && nextColumns > 0) liveColumns = Math.floor(nextColumns);
      if (Number.isFinite(nextRows) && nextRows > 0) liveRows = Math.floor(nextRows);
      // NARROWING REVOKES AN ATTACHMENT. Nothing about the session changed -- the pane simply
      // stopped being drawn -- and input has to stop with it rather than keep reaching a live PTY.
      console_?.noteViewport({ columns: liveColumns });
      previousLines = [];
      // NO REFETCH. The geometry changed, not the roster.
      repaint();
    },
    stop: () => {
      // SET FIRST. A frame already awaiting IO checks this on the way back; clearing the interval
      // only stops frames that have not started.
      stopped = true;
      clearInterval(timer);
      // A PENDING PANE REPAINT IS A FRAME THAT HAS NOT HAPPENED YET.
      //
      // NO MUTANT CAN KILL THIS LINE TODAY, and saying so is better than implying it is
      // load-bearing: the timer's own callback re-checks `stopped` before drawing, and the handle is
      // `unref`d, so removing this clear changes neither what is written nor whether the process can
      // exit. It is kept because a scheduled callback that outlives the thing that scheduled it is a
      // shape this file has been bitten by before, and the next person to make that callback do
      // something else should find it already cleaned up rather than have to notice.
      if (paneRepaintTimer) {
        clearTimeout(paneRepaintTimer);
        paneRepaintTimer = null;
      }
      console_?.stop();
      if (input && onData) {
        input.off?.("data", onData);
        if (!rawWasOn) input.setRawMode?.(false);
        input.pause?.();
      }
    },
  };
}
