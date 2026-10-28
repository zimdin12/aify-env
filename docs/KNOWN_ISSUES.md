# Known issues

What is known to be wrong or unproven, with the evidence it rests on. An entry leaves when it is fixed or attributed,
and says which.

## `lib/agent-definitions.mjs` is 663 lines after its split: still past the 400-line signal (0.9.9)

It was 848 when 0.9.9 added the view's read-only summary. Two subjects other code needs have left it: that read
(`lib/definition-summary.mjs`, 57) and the lock with the process probe it judges holders by (`lib/definition-lock.mjs`,
182; process-probe.mjs and serving-endpoint.mjs imported `processState` from the store), with the store's two errors in
`lib/definition-errors.mjs`. What remains is the store's own job: its public calls, recovery, adoption and the
four-step operation. Recovery and adoption are the next separable parts if it grows; each must keep the folder named
here alone (`tests/agent-definitions-have-one-writer.test.js`).

## The attach-client test's process crashed natively in two full runs (seen 2026-10-28; unattributed)

`tests/an-attach-client-names-itself-as-a-viewer.test.js` failed at file level in 2 of 3 full runs of the 0.9.9
definition-binding change: exit code 3 once, after both its subtests had passed, and 3221225477 (0xC0000005, an access
violation) once. It passed in the third run, alone 3 times in 3, and in both full runs of main (ce78e2e) on the same
host the same afternoon. The test drives `bin/aify-env-attach.mjs` in a real terminal through node-pty (ConPTY), with
the test's environment plus two endpoint variables; nothing in that change reaches it. Other repositories' suites
(aify-wrapper, aify-comms, planetary_golf) were running at the same time. ASSUMED: a ConPTY fault under load,
unattributed. A crash with the host otherwise idle would make it this repository's to chase.

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
