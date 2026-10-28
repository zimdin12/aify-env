# Known issues

What is known to be wrong or unproven, with the evidence it rests on. An entry leaves when it is fixed or attributed,
and says which.

## `lib/agent-definitions.mjs` is 848 lines: next to split (noted for 0.9.9)

Past the 400-line signal since 0.9.9 added `readOnlySummary()`, the view's lock-free read. The read lives in the store
because only the store may name its folder (`tests/agent-definitions-have-one-writer.test.js`), so the split has to
keep that gate: the lock, recovery and adoption are the separable parts, with the folder still named in one place.
Not in 0.9.9 (comms-tech-lead, 2026-10-28).

## "Unexpected end of JSON input" in two unrelated live tests (seen 2026-10-28; one fixed, one instrumented)

Two causes behind one message, found by reading each failure's stack in the recorded runs. Both parsed an empty input.

FIXED: `tests/the-dashboard-plugin-serializes-activity-checkpoints.test.js`, "two stale recovery claimants cannot
overlap checkpoint writes". The stack ends at the harness's `JSON.parse(fs.readFileSync(<who>-ready))`, which runs as
soon as the phase file EXISTS, and the actor (`tests/fixtures/activity-checkpoint-actor.mjs`) wrote it with
`fs.writeFileSync`, which creates the file before it writes. Measured with a scratch probe on this host (one process
writing, one polling for the name and parsing): a writer that pauses 2 ms between create and write gave the reader an
empty file 184 times in 300, with exactly this message; written to a temporary name and renamed into place, 0 in 300.
Unloaded and under 64 CPU-bound processes, plain writes failed 0 in 20000, which is why it needed a host short of
memory to show. The actor now writes every phase file that way.

INSTRUMENTED, NOT ATTRIBUTED: `tests/doctor-live.test.js:217`, the negative control. The stack ends at
`JSON.parse(runDoctor(...).stdout)` after 12 s, under the 60 s timeout: the doctor printed no report, and the test
threw away the exit status, signal and stderr that would have said why. The run cannot be attributed from what it
recorded. Every parse there now goes through `reportOf`, which says the status, signal, spawn error and stderr when
there is no report; watched with a doctor replaced by one that writes to stderr and exits 3. If it recurs, the next
failure names its cause.
