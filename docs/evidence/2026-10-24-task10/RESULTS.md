# Task #10: owner-scoped pending reservation recovery

Reviewed source tree: `f455e61cbb2df3a2cd802be77a7b78338c710699`. The successor uses fresh process death
or verified PID/birth mismatch only, on every boot path. Lead ruling `1792805184553-661b6aef` accepted
that correction and rejected tree `434ad957`. All five successor suites ran on unchanged source.
The composition is **NOT GREEN**. Approval `1792806822104-5dc5ab80` accepts the exact source tree
and excludes both recorded gaps from this change. The env gap remains UNATTRIBUTED on task #6.
Landing includes these receipts without changing the ten reviewed source/test/doc blobs.

## New native counterexample

`port-scope-drain-red.txt` records a named assertion failure on the actual candidate. A private old
Node process runs the real lifecycle with an unresolved builder, then the real shutdown closes its
listener while runner-stop completion is held. The replacement binds the exact same endpoint. The
parent independently confirms the old PID remains alive. The rejected recovery incorrectly set the
old pending reservation to terminal using its earlier generation. Listener exclusion does not prove
that old lifecycle custody cannot still execute. This disproves the claimed standalone shortcut even
after endpoint scoping fixed the advisory's original cross-port example.

The corrective successor uses fresh PID death or verified birth mismatch for every current boot
path, keeps scope/generation/PID metadata, and retains this native drain regression. No new lock or
shutdown redesign is proposed. The correction and withdrawn claim were sent to the lead linked to
`1792803832395-775e2080`. Its first campaign completed with unchanged source. Four candidate suites
passed and bridge failed the same resident-stdin-loss assertion in both arms, expected 1 and actual 0.
Those passes cannot override this safety RED. `REJECTED-434ad957.md` preserves the earlier report.

Reviewed source tree: `f455e61cbb2df3a2cd802be77a7b78338c710699`, on aify-env
`34c31d02e9af81a6e128a2051d3856431828e614`. Its ten changed source, test and documentation files are in
`C:/Users/Administrator/projects/aify-env-task10`, branch `fix/settle-prior-boot-reservations`.
At the qualification checkpoint, no commit, live journal edit, deployment or live daemon restart had
been performed.

## Implemented bound

New production reservations carry scope, generation, PID and nullable process birth time. Standalone
ownership uses the actual bound endpoint, including its resolved port. Dedicated preparation is not
exclusive before state boot, and a standalone listener can close while lifecycle work still drains.
Every recovery therefore requires fresh PID absence or a verified different birth time. Scope and
generation are metadata, never settlement authority. Live, unknown and ownerless legacy custody stays.
The existing unsupported-platform process probe remains unknown, not absent.

Recovery rereads intent, owner and pending state under the existing journal lock. It sets the terminal
result to the original unknown receipt without changing stop facts or replaying effects. Original
request IDs still replay execution-unknown. Manual legacy recovery under that lock, including the
backup and preservation requirements, is documented in `docs/PROTOCOL.md`.

## Executed checks

- Original ownerless diagnostic: 3 passed, 1 intended RED. The later ownerless-manual ruling supersedes
  that diagnostic's desired automatic release, not its historical result.
- Owned-format RED against unchanged product: 13 passed, 4 intended failures, exit 1 in `owned-red.txt`.
  Missing persisted owner and refusal of own prior-generation, gone-PID and reused-PID starts failed.
  Concurrent custody, unknown owner, unavailable birth time, legacy and other-port controls passed.
- The current owner tests were separately import-bound to the unchanged exact base in
  `successor-owned-red.txt`: six passed and six failed, exit 1. Four feature assertions failed for
  missing ownership and refused dead/reused-owner starts. Two control-mutation witnesses failed
  because the base lacks the recovery probe, not because a compare-under-lock guard was exercised.
  The separate successor mutations below pin those guards. `successor-owned-base-binding.json`
  records the unchanged test body with only its module import prefix redirected to the base.
- The original `owned-red.txt` run includes the maintained real-daemon takeover test. The predecessor was dead and the
  replacement's health response named its PID on the same port. Stranger and worker cleanup controls passed.
- Focused successor: 132 passed, 0 failed, 0 skipped, exit 0 in `successor-focused.txt`. This includes real
  boot, journal, definition store, actual lifecycle ports, daemon-bootstrap statement composition,
  dedicated admission race, journal integrity and retained cold-start/automatic producer regressions.
  The retained native shutdown-drain test keeps the still-live reservation pending. In the additional
  Windows `native-death-green.txt` probe, the parent confirms the old PID's later exit and a fresh real
  boot probe settles that exact row. One test passed with no failure or skip. These fixtures do not
  launch a coding agent; the real lifecycle start with a no-child runner is covered by the selection.
- Five predicted sensitivity failures were observed and original source bytes restored, recorded in
  `successor-mutations/mutation-receipt.json`: missing boot owner wiring, missing owner validation,
  missing birth mismatch,
  missing ownership comparison and missing pending-state comparison. Every mutant failed its named
  assertion, not a parser or fixture error.
- All ten staged working-tree files were LF and byte-identical to their index blobs, not merely
  clean after Git's text conversion. `git diff --cached --check` passed. Existing `bin/aify-env.mjs`
  remains at 985 lines; no unrelated split is included.

## Final campaign rule

`run_full_suites.py` runs the five candidate suites once after matched bridge and env baseline controls.
It pins interpreter/import paths, shell, temporary roots, sibling sources and MSYS flags, and hashes the
complete tracked raw-byte populations before and after, plus the coordinator's own source hash.
An unchanged-source assertion and the native exits govern the result. A failed case is baseline-matched only if its case/assertion identity matches,
not its failed total. Other failures remain UNATTRIBUTED; there is no retry-until-green allowance.
Successor results are in `successor-full/receipt.json` and `successor-full/parsed-results.json`.
Every raw log hash was checked. Tracked source before and after was identical. No whole-suite retry
of this successor has been run.

| Invocation | Actual reporter result | Native exit |
|---|---|---:|
| Baseline bridge | 380 file invocations, one failing file | 1 |
| Baseline env | 3,428 passed, 4 skipped | 0 |
| Candidate Python | 5,736 passed, 28 skipped, 12,638 passed subtests | 0 |
| Candidate bridge | 380 file invocations, one failing file | 1 |
| Candidate dashboard | 1,953 passed | 0 |
| Candidate wrapper | 936 passed, 70 skipped | 0 |
| Candidate env | 3,436 passed, one failed file, 4 skipped | 1 |

Both bridge arms fail `bridge-exits-when-its-terminal-goes.test.js`, case
`a resident bridge whose stdin ends reports resident-lost and exits`, at its strict equality,
expected 1 and actual 0. This matches the file, case and assertion, not merely the failed total.

The candidate-only env failure is file-level `ERR_TEST_FAILURE`, exit 1, for
`tests/the-dashboard-plugin-reads-only-what-it-judged.test.js`. The captured report contains no
individual-case outcomes for that file and gives no underlying assertion. Exactly one matched
named-file control then passed all seven cases on each arm with unchanged source. That is
non-reproduction only. The full failure remains **UNATTRIBUTED**, not dismissed as host slowness.
Receipts are in `named-env-control/`. The reviewer subsequently excluded this failure by its import
graph, not by counts: the dashboard test's imported modules do not load the changed lifecycle modules
or the daemon entry point. This is the reviewer's attributed disposition in
`1792806822104-5dc5ab80`, not a new cause attribution. The bridge case is baseline-matched.

The rejected first campaign remains in `full/`, with its original coordinator preserved as
`run_full_suites-round1.py`. Source approval authorizes commit, main integration and push. It does
not authorize a live daemon restart. The disk update takes effect at the operator's next ordinary
restart; this change requests none.

The advisory read base `34c31d02`, not the changed candidate. Its broad distinction prompted the native
counterexample above; it is not source-review approval of either candidate.
