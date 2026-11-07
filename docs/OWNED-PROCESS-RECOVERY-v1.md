# Owned-process recovery v1

The owned-process record is crash-recovery custody, not permission to kill a numeric PID. Durable replacement prevents torn writes; it is not a lock between independent writers sharing a path. This contract implements the bounded #17 change, not per-instance migration or automatic cleanup of every surviving process group.

## Owning producer

The default record remains a JSON array at the configured process-record path. Dedicated invocations keep their validated private record and recovery:none policy. Unknown rows and unknown fields stay in the file; the readable legacy view excludes unusable rows without authorizing their deletion.

Each new host-owned row retains id, pid, owner, service, launcher and startedAt. These optional fields describe different witnesses:

- startToken is the owning Linux child's five-field capture from [process identity v1](PROCESS-IDENTITY-v1.md). Capture occurs at the actual live spawn boundary, never by repairing an old PID.
- ownerIdentity is captured for the running daemon itself at boot. Linux uses the same token format bound to the owner PID. Windows uses `{version:1, platform:"win32", pid, createdAtUs}`, with the shared probe's Unix microseconds, compared exactly. A failed capture adds no invented birth identity.
- groupScope is `{kind:"posix-process-group", pgid:<child pid>}` only for the host's detached piped POSIX spawn. It records the original scope; the number alone does not renew kill authority after the root died.

Child identity and owner identity are never substituted for each other. Old arrays remain readable. A live or unknown legacy PID-only owner stays protected and gains no stored-owner supersede exception. A malformed optional owner identity is unknown, not a reason to fall back to weaker permission.

## Durable IO and failures

Every replacement uses the existing writeFileDurably: sibling temporary file, fsync, rename and directory sync where supported. Only ENOENT means missing. Other read failures leave the target untouched and report the failure. Readable corrupt/unsupported bytes are copied exactly to a durable, uniquely named recovery copy before a start can replace them; failed preservation refuses replacement. Retirement has no identifiable row in damaged input and leaves it in place.

Unknown rows retain their original JSON source, including values a parse/stringify round trip would round or replace. Record retirement removes exact expected rows from the current file, including owner/birth evidence; it does not replace the file with an old keep snapshot. Unresolved pre-stop rows lost to a legacy predecessor's last clear are merged back only after that predecessor can no longer write.

The Windows rename retry is synchronous and can occupy up to 2000 ms **per durable write**. Starts, individual stop retirements and aggregate recovery writes can therefore delay the event loop; an asynchronous shutdown timer cannot preempt them. A failure before rename leaves the previous target. A directory-sync failure after rename may leave the new target; targetReplaced reports that distinction. Errors are reported without throwing through the daemon, and successful replacement is not claimed when durability is uncertain.

## Taking over a legacy or current incumbent

The existing health-shape identification and work-loss refusal run before takeover effects. From that shape-checked PID, the successor immediately observes birth through the shared process-identity probe and binds it to this invocation. **The incumbent need not publish birth fields.** This is the compatibility path for the joint switch from dde9d6d. It is a takeover observation, not backfill of legacy child/owner records and not authentication against a malicious local health responder.

The successor snapshots known entries before the first effect. Its Runner refuses managed and raw starts until startup recovery has run and the original observed predecessor identity is positively gone. A freed port, accepted TERM, timeout, unknown query or PID alone does not establish writer quiescence. A fresh positive different birth on the same PID proves that the original is gone; it does not authorize signalling the replacement.

Only a stored owning-writer identity equal to this invocation's displaced birth can use the still-live displaced-owner exception. Unrelated live instances, including an independent port-zero instance, remain protected. The successor makes no shared-record changes while the original predecessor might still write. Once quiescent, it applies aggregate retain/retire deltas and admits new starts. This does not serialize every unrelated live instance sharing one file.

## Cleanup permission and confirmation

Linux requires the original child token and exact NUL-delimited launcher component. A recovered group additionally requires the owning spawn's recorded group scope and fresh matching OS group membership while that original root is still present. The bounded TERM/KILL schedule is shared with live custody; a recovered PID is never wrapped as a fake live ChildProcess.

A root already gone with a surviving or unanswerable group stays recorded and is reported as an **unverified group**, with no signal. A positive group ESRCH observation can retire that scope. Root absence alone, or an unknown root observation, cannot. Numeric group custody during a bounded attempt is not a held-handle identity lease across an unobserved reuse gap. Descendants that leave the owned group remain outside its ending guarantee.

Windows keeps the legacy child verifier's launcher match and +/-30000 ms start-time tolerance; it is not exact child birth identity. Once that policy admits a fresh observed root, the held helper's actual GetProcessTimes creation clock must match that observation before go. Completion confirms the reachable held tree, not descendants already orphaned before root acquisition. A missing root with unverifiable descendant scope stays unresolved.

Only a confirmed result for the **matching recorded scope** retires its exact row. Attempted-only booleans, root-only success, missing scope, failed effects and unknown observations retain custody. Confirmed cleanup stays remembered if a later request must finish the predecessor fence; it is not resurrected by reclassifying a now-missing root.

## Visible holds and operator recovery

- During a bound-but-incomplete recovery, `/health.ownershipRecovery` reports ready:false, state:held, the reason and displaced PID. Raw starts return HTTP503; managed lifecycle returns a typed terminal no-spawn refusal. Generic errors with copied codes remain execution-unknown.
- An initial takeover birth query that cannot answer refuses before signalling and exits69; the old environment is left alone. The console states the bounded failure. The shared query has its own 15-second limit; held cleanup has a separate bounded helper budget.
- The operator can inspect the old environment with the explicit TUI/doctor commands and return to its owning terminal to finish its work and stop it there. They can then retry their ordinary launch if the new listener never bound, or make a fresh start request to the already-bound successor. That request rechecks the original observed identity and opens the fence when its absence is proved. Do not delete bookkeeping or signal an unverified numeric PID to bypass the fence.

Recovery is boot/request-driven, not a new periodic reaper. A ready host does not repeatedly re-kill retained leftovers on every start. Unverified groups do not keep unrelated new work blocked after predecessor quiescence; their records and diagnosis remain. #17 closes silent custody loss. A durable surviving-group witness or OS containment is a separate design, not implemented here.

## Compatibility and qualification limits

New metadata does not migrate the file layout. Older readers can parse the array, but an older daemon does not implement this contract and can discard metadata/unresolved entries during its own writes; readability is not a downgrade safety guarantee. The takeover fence protects against the specific displaced legacy writer, not every old writer on a shared path.

Decision and mutation tests inject every effect and install throwing syscall tripwires. Native qualification uses only fixture-owned processes/groups and known-tree handles, never a real daemon takeover or global process discovery. The legacy-switch fixture tests the actual core observer/recovery/store/Runner/raw path with dde9d6d-shaped health and no birth fields. Native effect-adapter proof is reported separately from simulated boot permission and from live fleet deployment.
