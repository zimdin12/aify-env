# 0.9.8b, third commit: which agent a key acts on, as its own part (2026-10-28)

The lead asked for this after the first commit: the code that decides which agent a stop hits becomes one small part
with its own tests. `lib/console-session/subjects.mjs` (122 lines) holds:

- the open menu's subject;
- where leaving the picker returns to;
- the four rules that resolve them by identity, each with the comment recording the wrong-subject defect it came from.

`lib/console-session.mjs` went from 568 to 509 lines. The incident comments that stay there (`syncProcesses`, the
rest of `handleInput`) were kept whole, as the lead asked.

## Proof

- `session-differential.out`: the session differential from the first commit
  (`docs/evidence/2026-10-28-098b-session/differential.mjs <repo> fbfeb4d`). Old and new agree on 91 steps in three
  configurations. Its control moves to the new call site; a confirmed action's target taken from the cursor still
  differs at step 49.
- `dashboard-differential.out`: the dashboard differential from the second commit, against fbfeb4d. It runs through
  the new session and agrees on every event in all three configurations, and old against old agrees.
- Mutants on the part: 10, against the 47 dashboard and session test files.
  - Six went red on the first run.
  - J4 (a closed menu keeps its subject) and J8 (a performed action keeps its subject) survived, because the next
    refresh tidies both. Done faster than a refresh ("m, Ctrl+], s, Enter", or "y" then "s, Enter"), each brought back
    the v0.7.1 E1 report: a start of bravo that also acts on alpha. Two tests in
    `tests/a-start-after-a-list-flap-names-no-other-agent.test.js` drive exactly that, and both mutants are red
    against them.
  - J9 and J10 cannot be killed, and the file says why: a stale picker return is always overwritten before it is read,
    and an attach from the menu always re-syncs at once.
- Full run: 3823 tests, 3818 pass, 0 fail, 5 skipped.
