# A managed worker's Herdr pane shows aify-env's word (0.9.9, Herdr status sync phase 1)

`lib/herdr-pane-reporter.mjs` tells each managed agent's pane, in a `herdr-aify env` instance, the word the dashboard
shows for that agent. What is proven, and what is not yet:

- PASSES IN TESTS: `tests/a-managed-workers-pane-shows-its-agents-word.test.js` (11 tests) against a faked Herdr, with
  18 mutants watched red, the "no path back in" one among them (the pane's own reports offered to the word as its
  screen). Full run 3922 tests, 0 failed, on the commit that added it.
- PROVEN 2026-10-29, after Steven's restart into 4a77d20 (see "Seen live" below): Herdr 0.9.5 takes the reporter's
  `--message` argv, and a pane the reporter holds goes back to aify-env's word within one minute of anyone else's
  report.
- NOT YET SEEN: a pane on `blocked` or `shell`; check 2 below as read (the daemon's notices go to the view, which was
  on the agent picker); check 3 (a stopped agent's pane hears nothing more).

## First thing to look at after Steven's restart into this main

In a `herdr-aify env` instance, start one managed agent and watch its pane's dot beside its dashboard row:

1. The dot follows the row: working while a turn runs, idle at the prompt, blocked on a dialog (folder trust, a
   permission prompt), with the word as the dot's message (`shell` shows idle with the message "shell").
2. The daemon's log has no line `herdr: <pane> not told its word (...)`. If Herdr refuses `--message`, that line says
   so once per pane and the dot keeps the state it was claimed with (idle); the fix is then in the reporter's argv.
3. Stopping the agent closes its pane and nothing more is reported to it (no `not told its word` line for that pane
   after the close).

Until aify-wrapper's hooks stop reporting for a launch with `AIFY_HERDR_PANE_FILE` set (their gate waits on the version
this ships in), both write the pane; Herdr keeps the highest seq, and this reporter says an unchanged word again after a
minute, so the dot settles on aify-env's word within one minute of a hook's report.

## Seen live (2026-10-29, the daemon at 4a77d20 in a `herdr-aify env` instance, Herdr 0.9.5)

Two managed workers ran under it. The managed agent writing this was one of them, in pane `w3:p1`.

- `herdr pane list`: the working worker's pane read `claude-aify` / `working` and the idle one's `claude-aify` / `idle`.
  aify-comms listed the same two agents as working and online.
- Who writes the pane. aify-wrapper's hooks report `working` after each tool call, and Herdr's own detection labels a
  pane `claude`. So, inside ONE shell call (no hook can fire), `w3:p1` was reported `unknown` under the agent label
  `probe-label` with a current seq, then read every few seconds:

  | round | read at once | changed back after | to |
  |---|---|---|---|
  | 1 | `probe-label` / `unknown` | 46 s | `claude-aify` / `working` |
  | 2 (straight after 1) | `probe-label` / `unknown` | 60 s | `claude-aify` / `working` |

  The read at once is the control that the instrument can say "not aify-env's word". Only aify-env's reporter labels
  the pane `claude-aify` with no hook running, and round 2 took exactly its one-minute repeat (`REPORT_EVERY_MS`). Every
  report it makes carries `--message` (`lib/herdr-pane-reporter.mjs`, with the word never empty), so Herdr accepted it.

`herdr pane get` does not print the message, so the word as the dot's message is shown by the argv Herdr accepted, not
read back.
