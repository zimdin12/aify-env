# Known issues

What is known to be wrong or unproven, with the evidence it rests on. An entry leaves when it is fixed or attributed,
and says which.

## "Unexpected end of JSON input" in two unrelated live tests (seen 2026-10-28, not attributed)

Two tests that read files their own fixtures are writing failed with the same error, in full runs on a loaded host:

- `tests/the-dashboard-plugin-serializes-activity-checkpoints.test.js:56`, "two stale recovery claimants cannot
  overlap checkpoint writes": a full run on the TUI split's parent. It passed alone in both checkouts (5/5).
- `tests/doctor-live.test.js:184`, "NEGATIVE CONTROL, ON THE SAME REAL DAEMON: change the disk and the row goes
  FAILED": a full run on `aa17d1b` that Claude Code stopped part-way because the host was low on memory (5 GB free of
  97 GB).

Leading hypothesis, ASSUMED: a reader catching a file mid-write, rather than memory pressure. That fits two
unrelated tests failing the same way. Not reproduced, and neither test has been read for where it parses. To be
attributed after the 0.9.6 TUI release.
