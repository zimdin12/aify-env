# 0.9.8b, first commit: ConsoleSession's parts (2026-10-28)

The design is [`docs/0.9/view-objects-design.md`](../../0.9/view-objects-design.md), part 2. ConsoleSession keeps the
focus, the process list, the selection's identity and what each key does. It now owns three parts:

- `lib/console-session/start-list.mjs`: the start list's rows and whether they answer the current opening;
- `lib/console-session/pane-follower.mjs`: the stream, the width it can be drawn at, and what the last frame showed;
- `lib/console-session/input-decoder.mjs`: how a read is cut into keys and pastes.

One change from the design's list: what a paste does in each mode reads and changes the session's focus, so it
stays on the session (`#handlePaste`). The decoder hands it pastes as it hands `handleInput` keys.

## Proof

`differential.mjs <repo> f274b21` drives one 91-step script into the old class (main at f274b21) and the new one,
under three configurations. After every step it compares:

- every value handed back;
- every follower made, started and stopped;
- the focus, the selected id, `watchedId` and `actionTargetId`;
- the pane, `inputIsLive`, `canDrawPane`, the start list's view and the input flush timer.

The script includes:

- processes appearing, exiting and reordering;
- arrows, a held arrow arriving as one read, digits, and the picker (accept, no match, close);
- `m` then stop then `y`, and `m` then attach;
- a paste split across reads, with and without the agent's bracketed paste;
- the start list (search, Tab, Enter, reopen);
- `v`, `o` and `c`, hiding and showing the pane;
- narrowing to 79 columns and an unknown width;
- a failed stream retried after its pause, a notice frame and a lost frame;
- Ctrl+C asked and unasked, and the list emptying under an open menu.

THE RACE (the lead's review of the design): a state change lands between `m` and `y` while the stop confirmation is
open. The agent above the subject exits, then the rows reorder, then `y` is pressed. Both classes stop `bravo`, the
agent the menu named. A second run has the subject itself exit before `y`; both classes stop nothing.

`differential.out` is the run: all three configurations agree on all 91 steps, and the NEGATIVE CONTROL in the same run
differs. The control is a copy of the new class whose confirmed action takes its process from the cursor; it diverges
at step 49 (`y` on an agent that has gone), so the driver can see a wrong target.

Mutants on the parts, against the 20 test files that import the session: 13 of 14 red. The one that stays green
removes `pane()`'s `paneHidden` check. Hiding the pane closes its stream at once, so `pane()` already returns null
there. The same mutant also stays green on main at f274b21, in a throwaway worktree whose unmutated run was 259/259
green, so this gap is older than the split.

## Size

`lib/console-session.mjs` went from 803 to 568 lines, against the design's target of 300. The parts are 237, 80 and
69 lines. What remains is `handleInput` and `syncProcesses`, mostly the comments that record the wrong-subject
incidents. Bringing the session under 300 means moving `handleInput`'s subject resolution out as well. That step is
not in the design, so it is proposed rather than done here.
