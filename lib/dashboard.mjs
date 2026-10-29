// Driving the dashboard: drawing it, reading the keyboard, and refreshing, with no lifecycle of its own.
// What it draws is collected by lib/view-snapshot.mjs (0.9.8, moved there verbatim).
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
// ITS PARTS (0.9.8b), each the only writer of its own state: the screen (dashboard/frame-writer.mjs), the frame
// from the facts (dashboard/view-renderer.mjs), the refresh (dashboard/refresh-loop.mjs), what a key asks for
// (dashboard/key-actions.mjs) and the keyboard (dashboard/keyboard.mjs). `startDashboard` wires them.

import { readLayout } from "./tui-layout.mjs";
import { paneWillBeDrawn } from "./console-view.mjs";
import { ConsoleSession } from "./console-session.mjs";
import { collectSnapshot } from "./view-snapshot.mjs";
import { FrameWriter } from "./dashboard/frame-writer.mjs";
import { KeyActions } from "./dashboard/key-actions.mjs";
import { Keyboard } from "./dashboard/keyboard.mjs";
import { RefreshLoop } from "./dashboard/refresh-loop.mjs";
import { ViewRenderer, orderedSnapshot } from "./dashboard/view-renderer.mjs";

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
  //: WHETHER Ctrl+C ON THE DASHBOARD ASKS FIRST. Off by default, which is the client's case; the
  //: daemon turns it on, because there `onInterrupt` ends every worker on the host.
  confirmInterrupt = false,
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
  //: Whether an agent gets a herdr space from its next start: `(agent, show) => {ok, problem}`.
  onSetHerdrSpace = null,
  //: Which of them this caller can actually perform. Forwarded to the session, which puts it on
  //: the focus so the router and the renderer agree about what is on offer.
  actions = null,
  withoutConsole = false,
  //: Whether this environment ends with the Herdr session it runs in, so the header can say so.
  endsWithHerdr = false,
  //: WHICH PANES, IN WHAT ORDER: ~/.aify/tui.json (lib/tui-layout.mjs), read ONCE here, when the view starts. A
  //: caller may hand one in, as a test does; none reads the file under this process's home.
  layout = readLayout(),
  onInput = null,
  //: WHOSE `exit` GIVES THE SCREEN BACK. The process, always, outside a test.
  processEvents = process,
  ...collectOptions
} = {}) {
  //: The view's own stop, once it exists: the screen is given back by it when the process ends with the view up.
  let stopView = null;
  const frames = new FrameWriter({ write, clearScreen, once, processEvents, paneRepaintMs, onExit: () => stopView?.() });

  // ONE SESSION FOR THE WHOLE RUN, because a follower is a connection and rebuilding it per frame would abandon one
  // every two seconds. It owns the selection and the stream; this view owns neither. Arriving pane output redraws at a
  // bounded rate (FrameWriter's `paneProgress`).
  const session = input
    ? new ConsoleSession({ endpoint, fetchImpl, actions, withoutConsole, confirmInterrupt,
      onProgress: () => frames.paneProgress(() => !refresh.stopped, () => refresh.redraw()) })
    : null;

  // THE SIZE IS NOT FIXED FOR THE LIFE OF THE VIEW, and treating it as though it were is what put stale characters on
  // the operator's screen. The caller still owns the terminal: this module never reads `process.stdout`, and the
  // binary that knows it owns a screen calls `resize()`.
  const size = { columns, rows };
  // THE SESSION HAS TO BE TOLD, and it refuses to attach until it is. Below `MIN_COLUMNS_FOR_PANE` the compositor
  // draws no pane at all -- which is where input used to keep flowing into a process with no screen on it.
  session?.noteViewport({ columns: size.columns });

  const renderer = new ViewRenderer({ color, endsWithHerdr, keys: { enabled: Boolean(input), canQuit: Boolean(onQuit) } });
  //: The panes the last frame drew ▹, for want of room: the pane menu says so rather than flipping one it cannot open.
  let noRoom = new Set();
  const keys = new KeyActions({ session, layout, notices, repaint: () => refresh.redraw(), isStopped: () => refresh.stopped,
    noRoom: () => noRoom,
    onQuit, onInterrupt, onAction, onStartList, onStartAgent, onSetHerdrSpace, onInput });

  /** One frame from `collected`: ordered, reconciled with the session, drawn, and its readiness reported. */
  const paint = (collected) => {
    const snapshot = orderedSnapshot(collected, keys.layout.sort);
    keys.noteArrivals(snapshot.processes);
    // Read at RENDER time, not at start: the whole point is the messages that arrive while this runs.
    if (notices) snapshot.notices = notices.recent();
    if (refresh.stopped) return;
    // The session reconciles against every snapshot, so a process appearing or finishing moves the selection with
    // it rather than leaving the pane pointed at something that is gone.
    session?.syncProcesses(snapshot.processes);
    const frame = renderer.frame(snapshot, { session, layout: keys.layout, outcome: keys.outcome, ...size });
    const { lines } = frame;
    noRoom = frame.noRoom;
    // WHETHER A PANE FRAME ACTUALLY REACHED THE SCREEN, reported AFTER the write rather than decided before it. This
    // is the readiness the session gates input on, and only this function can know it. ASKED THROUGH THE COMPOSITOR'S
    // OWN PREDICATE, not inferred from the session having a pane to show: below the pane's minimum width the session
    // still HAS a pane and the compositor draws none. A THROWN WRITE REPORTS FALSE, which is the case a "would it fit"
    // check can never see: the layout was fine and nothing landed.
    const drewAPane = paneWillBeDrawn(session?.pane() ?? null, size.columns, size.rows);
    try {
      frames.show(lines);
    } catch (error) {
      session?.notePaneRendered(false);
      throw error;
    }
    session?.notePaneRendered(drewAPane);
  };

  // WIDTH AND COLOUR ARE DECIDED HERE, once, and handed to a pure renderer. Reading them inside the view would make the
  // same snapshot render differently in a test than on a screen.
  const refresh = new RefreshLoop({
    intervalMs,
    collect: () => collectSnapshot({ endpoint, registryPath, ...(fetchImpl ? { fetchImpl } : {}), ...collectOptions }),
    onSnapshot: paint,
  });

  await refresh.draw();
  if (once) return { stop: () => {} };
  refresh.start();

  const keyboard = input ? new Keyboard({ input, session, repaint: () => refresh.redraw(), isStopped: () => refresh.stopped,
    act: (result) => {
      const { leave, forgetFrame } = keys.act(result);
      if (forgetFrame) frames.forget();
      return leave;
    } }) : null;
  keyboard?.start();

  const view = {
    /**
     * The terminal changed size. Repaints in full rather than diffing, because every row's content and position may
     * have moved and the previous frame is no longer a description of the screen.
     */
    resize: ({ columns: nextColumns, rows: nextRows } = {}) => {
      if (Number.isFinite(nextColumns) && nextColumns > 0) size.columns = Math.floor(nextColumns);
      if (Number.isFinite(nextRows) && nextRows > 0) size.rows = Math.floor(nextRows);
      // NARROWING REVOKES AN ATTACHMENT. Nothing about the session changed -- the pane simply stopped being drawn --
      // and input has to stop with it rather than keep reaching a live PTY.
      session?.noteViewport({ columns: size.columns });
      frames.forget();
      // NO REFETCH. The geometry changed, not the roster.
      refresh.redraw();
    },
    stop: () => {
      refresh.stop();
      frames.cancelPaneRepaint();
      session?.stop();
      frames.leave();
      keyboard?.stop();
      frames.unhook();
    },
  };
  stopView = view.stop;
  return view;
}
