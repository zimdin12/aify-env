# 0.9.8b: the view's two big units as objects (design)

```text
0.9.8b: THE VIEW'S TWO BIG UNITS AS OBJECTS (design; built after instructions-at-launch)

WHY. After 0.9.8a, lib/dashboard.mjs is one closure (startDashboard, ~590 lines) over 14 `let`s, and
lib/console-session.mjs is one class (~800 lines). Neither can shrink by moving code: their parts share state.
These two files run the stop and attach menus, so the change is judged by behaviour, not by tests alone.

1. startDashboard BECOMES A SPECIFICATION over four owned parts (lib/dashboard/*.mjs):
   - FrameWriter: owns previousLines, the alternate screen (enteredView, stopView, releaseOnExit), frameUpdate and
     the pane-repaint timer. In: lines. Out: bytes written.
   - ViewRenderer: render(collected) as it is today: sorts rows, composes the console, asks renderDashboard. In:
     snapshot plus a context object (layout, outcome, session view, size). Out: lines. No timers, no writes.
   - RefreshLoop: the interval, the one-collection-at-a-time guard, lastSnapshot, stopped. In: collect(). Out:
     snapshots to a listener.
   - KeyActions: today's actOn (columns, sort, collapse, start/stop/attach dispatch, outcome and pendingStart). In:
     an action and the selected subject. Out: a result object {repaint, layoutChange, dispatch, outcome}, applied
     by startDashboard in one place, instead of each branch writing shared `let`s.
   startDashboard keeps its signature and return value ({stop} plus the view handle); its body wires the four.

2. ConsoleSession KEEPS focus, processes, selection identity and handleInput's routing, and owns three parts
   (lib/console-session/*.mjs):
   - StartList: startable, startProblem/Skipped/Service/Asked/Opening, startVisible, noteStartable, startView.
   - PaneFollower: follower, watchedId, followerOpenedAt, retry, paneRendered/renderedProblem/renderedStreaming,
     canDrawPane, inputIsLive, pane(), #inputPauseReason, #closeFollower.
   - InputDecoder: pasteReader, handleChunk, flushInput, inputFlushMs, #handlePieces/#handlePaste/#handleTyped,
     handing keys and pastes to the session.
   Public methods stay on ConsoleSession with the same names and results, delegating. Tests that read a field
   moved into a part (e.g. s.watchedId, s.startable) are edited to read it through the session's getter; those
   edits are listed in the commit.

PROOF, before and after, same inputs:
   - A SCRIPTED-SESSION DIFFERENTIAL. One driver runs old (main) and new startDashboard with a fake fetch sequence
     (hosts appearing, exiting, reordering; blocked and working records), a fake keyboard (arrows, digits, g and a
     search, m then stop then y, m then attach, Enter, Ctrl+], s and a start, a split paste, v, o, c then a letter,
     Ctrl+C in both tiers) and resizes. It compares every byte written, every executor call (action, target id)
     and every attach target. Plus the same script into old and new ConsoleSession alone, comparing focus,
     selected id, watchedId and actionTargetId after every step.
   - THE RACE A WRONG TARGET COMES FROM (lead's review): the script lands a state change between `m` and `y`
     while the stop confirmation is open: the agent above the subject exits, the rows reorder under `o`'s
     attention order, and the subject itself exits. Old and new must make the same executor call, or none.
   - Negative control in the same run: a new build with one action's target taken from the cursor must differ.
   - The existing suite (3800+) and the full run. Mutants on KeyActions' stop and attach branches.

SIZE TARGETS. dashboard.mjs and console-session.mjs under 300 each; every part under 250.

RISK. Medium: the stop and attach paths move. The differential compares executor calls, so a wrong target shows
up as a byte-for-byte difference, not as a test that happened not to look.

ORDER. After instructions-at-launch (lead, 2026-10-28). Two commits: the session first (smaller, its own
differential), then startDashboard.
```
