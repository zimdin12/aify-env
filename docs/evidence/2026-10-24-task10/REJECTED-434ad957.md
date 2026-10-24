# Task #10: owner-scoped pending reservation recovery

Status: **tree 434ad957 is rejected on safety before source review**, regardless of the outcome of its
already-running full-suite campaign. The post-bind generation shortcut is not safe during shutdown drain.
The report below records that candidate, not a qualified successor.

## New native counterexample

`port-scope-drain-red.txt` records a named assertion failure on the actual candidate. A private old
Node process runs the real lifecycle with an unresolved builder, then the real shutdown closes its
listener while runner-stop completion is held. The replacement binds the exact same endpoint. The
parent independently confirms the old PID remains alive. Current boot recovery incorrectly sets the
old pending reservation to terminal using its earlier generation. Listener exclusion does not prove
that old lifecycle custody cannot still execute. This disproves the claimed standalone shortcut even
after endpoint scoping fixed the advisory's original cross-port example.

The corrective successor must use fresh PID death or verified birth mismatch for every current boot
path, keep scope/generation/PID metadata, and retain this native drain regression. No new lock or
shutdown redesign is proposed. The correction and withdrawn claim were sent to the lead linked to
`1792803832395-775e2080`. The frozen campaign is allowed to finish without source changes; its test
passes cannot override this safety RED.

Candidate staged tree: `434ad9571be883b76800c125a7d9662eefb675b6`, on aify-env
`34c31d02e9af81a6e128a2051d3856431828e614`. Nine source, test and documentation files are staged in
`C:/Users/Administrator/projects/aify-env-task10`, branch `fix/settle-prior-boot-reservations`.
No commit, live journal edit, deployment or live daemon restart has been performed.

## Implemented bound

The lead accepted the owner-scoped rule in `1792803832395-775e2080`. New production reservations carry
scope, generation, PID and nullable process birth time. Standalone ownership uses the actual bound
endpoint, including its resolved port. Only the post-bind standalone caller grants the same-scope,
earlier-generation shortcut. Dedicated preparation is not exclusive before state boot: two preparations
can pass before the one exclusive readiness claim. Dedicated and cross-scope recovery therefore require
fresh PID absence or a confirmed different birth time. Live, unknown and ownerless legacy custody stays.
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
- The same RED run includes the maintained real-daemon takeover test. The predecessor was dead and the
  replacement's health response named its PID on the same port. Stranger and worker cleanup controls passed.
- Focused candidate: 131 passed, 0 failed, 0 skipped, exit 0 in `owned-green-2.txt`. This includes real
  boot, journal, definition store, actual lifecycle ports, daemon-bootstrap statement composition,
  dedicated admission race, journal integrity and retained cold-start/automatic producer regressions.
  Lifecycle recovery fixtures inject a no-child runner; they do not prove a real coding-agent startup.
- Five predicted sensitivity failures were observed and original source bytes restored, recorded in
  `mutation-receipt.json`: missing boot owner wiring, missing owner validation, missing scope guard,
  missing ownership comparison and missing pending-state comparison. Every mutant failed its named
  assertion, not a parser or fixture error.
- All nine staged working-tree files were LF and byte-identical to their index blobs, not merely
  clean after Git's text conversion. `git diff --cached --check` passed. Existing `bin/aify-env.mjs`
  remains at 985 lines; no unrelated split is included.

## Final campaign rule, before the full result

`run_full_suites.py` runs the five candidate suites once after matched bridge and env baseline controls.
It pins interpreter/import paths, shell, temporary roots, sibling sources and MSYS flags, and hashes the
complete tracked raw-byte populations before and after. An unchanged-source assertion and the native
exits govern the result. A failed case is baseline-matched only if its case/assertion identity matches,
not its failed total. Other failures remain UNATTRIBUTED; there is no retry-until-green allowance.
Full-suite results are pending. Source-review and activation approval are not claimed.

An advisory reader is checking exclusivity on the same source. Its report has not yet been consumed;
the existing primary native and composed tests above are separate evidence.
