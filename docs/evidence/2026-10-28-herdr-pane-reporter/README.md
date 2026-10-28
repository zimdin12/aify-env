# A managed worker's Herdr pane shows aify-env's word (0.9.9, Herdr status sync phase 1)

`lib/herdr-pane-reporter.mjs` tells each managed agent's pane, in a `herdr-aify env` instance, the word the dashboard
shows for that agent. What is proven, and what is not yet:

- PASSES IN TESTS: `tests/a-managed-workers-pane-shows-its-agents-word.test.js` (11 tests) against a faked Herdr, with
  18 mutants watched red, the "no path back in" one among them (the pane's own reports offered to the word as its
  screen). Full run 3922 tests, 0 failed, on the commit that added it.
- NOT YET SEEN: a real Herdr 0.9 taking `pane report-agent ... --message <word>`, and a real dot agreeing with the
  dashboard. Nothing here ran against a live Herdr.

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
