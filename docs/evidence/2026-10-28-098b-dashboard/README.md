# 0.9.8b, second commit: startDashboard as the wiring of its parts (2026-10-28)

The design is [`docs/0.9/view-objects-design.md`](../../0.9/view-objects-design.md), part 1. `lib/dashboard.mjs` went
from a 590-line closure over 14 `let`s to 208 lines that wire five parts under `lib/dashboard/`. Each part is the only
writer of its own state:

| Part | Owns | Lines |
|---|---|---|
| `frame-writer.mjs` | the frame on screen, the diff, the view's own screen, the coalesced pane repaint | 127 |
| `view-renderer.mjs` | nothing: snapshot, session, layout, outcome and size in, lines out | 91 |
| `refresh-loop.mjs` | the interval, one collection at a time, the last snapshot, `stopped` | 92 |
| `key-actions.mjs` | the layout, the last outcome, the start awaiting its worker; what one key asks of the caller | 187 |
| `keyboard.mjs` | raw mode, the read decoder, the paste flush timer | 99 |

Two changes from the design:

- **A fifth part, Keyboard.** It holds raw mode, the data listener and the paste flush timer, which the design's four
  parts did not name.
- **KeyActions keeps its callbacks.** Several of its answers arrive later (a start, an action, a list), so it reports
  through `report`. The synchronous result it returns is `{leave, forgetFrame}`, applied by `startDashboard` in one
  place.

## Proof

`differential.mjs <repo> <old-ref>` runs the OLD `startDashboard` (main at ee5cdcc) and the NEW one through one
68-step script. Both runs get the same fakes:

- the daemon: processes coming and going, and a live output stream;
- the keyboard and the process events;
- the callbacks;
- the clock: every timer the view sets fires only when the script advances time.

The home is a temp directory, because `v`, `o` and the pane menu write `~/.aify/tui.json`. The driver compares, in
order:

- every byte written;
- every callback, with the process each action or keystroke names;
- every call on the terminal and the process.

It runs three configurations: a live screen, a pipe, and `--once`.

THE HARNESS'S OWN CONTROL comes first: the old view against itself. The first version failed it, because a real disk
read on the collection path (the credential store) landed between steps when the thread pool said. With the store
injected as an immediate answer, old against old agrees in every configuration, on three consecutive runs.

THE RACE (the lead's review). The view orders rows by name, so the shift comes from agents leaving and arriving
above the subject:

1. A stop for charlie is confirmed and awaiting `y`.
2. alpha exits above it, then aaron arrives above it.
3. `y` is pressed: both views call `onAction` with stop charlie.
4. An attach from the menu, made while abel arrives above, sends the typed key to delta, the agent the menu named.
5. A stop whose subject exits before `y` calls nothing.

`differential.out`: old and new agree on every event in all three configurations. The NEGATIVE CONTROL in the same
run takes an action's process from the top row instead, and differs at that `y`: stop aaron.

## Mutants

16 on the parts, against the 47 test files that touch the dashboard or the session. 11 went red on the first run.
B2 (paste flush) needed its anchor fixed, and then went red. K3 (keys handed to the top row instead of the agent typed
at) survived, which is the attach branch the design named. A new test in `tests/dashboard-console-input.test.js`
attaches to the second row and closes it.

Four stay green: K6 (Ctrl+L keeps the old frame), R1 (a frame after stop), V1 (a failed write keeps readiness) and V2
(resize keeps the old frame). Their equivalents on main are green too, in a throwaway worktree whose no-op control was
green, so these gaps are older than the split. They are closed in the item that widens the export gate. R1 cannot be
killed while `paint` checks `stopped` as well, as the old `render` did.

## On the real system

`node bin/aify-env-tui.mjs --once`, with `AIFY_ENV_ENDPOINT` set to the endpoint `findEnvEndpoint` resolves, was run
from main and from this build against the live aify-env (0.9.4). Both drew the same 18-line frame. The only difference
was the traffic counter, which kept counting between the two renders. That covers the one-shot path; the interactive
path is covered by the differential only.
