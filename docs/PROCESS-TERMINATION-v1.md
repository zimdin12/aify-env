# Owned process termination v1

The host owns process-ending mechanisms. A plugin owns its stop/timeout decision, not another killer.
Released imports use `aify-env/plugin-ports`; the in-tree adapter imports the same `lib/plugins/ports.mjs` barrel.

## Owned POSIX groups

`PosixProcessGroup({child, detached, platform, signal?, now?, wait?, defer?})` captures custody at the
caller-owned detached spawn. `child` is the actual live ChildProcess from that spawn, and detached must
be true. It is not constructed from a saved PID, an HTTP body or a process-table match. Invalid, self,
parent and init targets fail closed before an effect. A failed ownership setup never becomes a weaker
PID-only cleanup path.

`endPosixGroup(group, {timeoutMs?, phase?, force?})` returns Promise<void>. It resolves only after an
ESRCH observation for the owned group; present or unanswerable cleanup rejects. The default budget is
3000ms. Ordinary Runner stop uses its existing exitWaitMs budget, half for TERM grace and the remainder
for KILL/absence confirmation. At most one KILL is issued per attempt; no recurring daemon timer is
added. `force:true` keeps the provider's existing immediate-KILL policy while still requiring absence.
`close` is never a precondition to checking the group: a surviving descendant may hold the pipes open.

Before a new numeric group effect, the owner yields to the check phase so pending exit callbacks can
revoke an exit-unseen witness. A child whose exit was already observed cannot authorize a new kill.
An attempt that began with custody can complete its bounded group cleanup after the leader exits.
This is numeric-PGID ownership within that bounded attempt, not a Windows-style held-handle identity
lease or a claim of atomic immunity to reuse across an unobserved gap. Descendants that deliberately
leave the owned group are outside the group-ending guarantee. Once ESRCH retires custody, that object
never queries or signals a later reuse of the numeric ID.
EPERM, an unreadable observation or a failed signal is uncertainty, not absence or permission for a
positive-PID fallback.

Runner retains group custody through root exit/close and reaper release until absence is proved.
A dead root with an unresolved group is not a completed stop. The reaper still kills nothing; a group
release refusal is returned as unknown rather than reaped. The separate [owned-record recovery
contract](OWNED-PROCESS-RECOVERY-v1.md) defines durable metadata, successor admission and retention;
these live-child ports do not themselves grant recovered-PID authority.

If the root exits on its own while descendants keep its group alive, a later stop returns unknown
without signalling that group. Repeated stops can therefore keep failing, with the entry retained,
until the group is positively observed gone or this environment's lifetime ends. This is deliberate:
a crashed root does not renew numeric-group kill authority. #17 persists this uncertainty and reports
an unverified group without signalling it. It closes silent custody loss, not automatic survivor
cleanup. A durable surviving-group witness or OS containment is separate, unimplemented work;
a restart alone does not promise these survivors will be cleaned up.

## Result propagation

Runner's new group refusal includes:

```js
{
  stopped: false,
  problem: "execution-unknown: ...",
  groupCleanup: { kind: "owned-posix-group", pid, state: "present" /* or "unknown" */ }
}
```

`stopAndVerify` preserves ONLY this typed refusal; a dead root cannot overwrite it. Every legacy
Windows/PTY or untyped false answer retains its existing subsequent PID-absence verification. It is
not correct to propagate every stopped:false answer, nor to infer group ownership from problem text.
Request-id replay stays tied to the same stop witness; uncertainty does not grant a new PID target.

## Windows held handles

`heldKill(pid, {stillOurs, start?, powershell?, timeoutMs?})` returns Promise<void>. The helper opens
and holds the root before calling `stillOurs({createdAt100ns})` for go/no-go. Live-child callers keep
their current exit-unseen witness and may ignore the argument. The recovered-record adapter instead
requires the actual held creation clock to match its freshly observed birth; a saved PID is never
sufficient. Self/parent/init targets are refused before a helper starts. An optional positive timeout
cancels only the newly spawned helper and leaves target cleanup unconfirmed; it never sends a second
command after go. Unknown open/query/list/wait/termination outcomes reject. Completion describes the
reachable held tree, not a subtree orphaned before acquisition. The C# algorithm remains unchanged;
the old plugin module is a compatibility re-export, not a second implementation.

`endOwnedChildTree(pid, {platform?, own?, group?, stillOurs?, held?, timeoutMs?})` selects the strict
owned-group or held-child port. A supplied own handle must match pid. A best-effort own-handle kill
never certifies unknown tree cleanup; no numeric positive-PID fallback is added.

## Preserved exception and recovery boundary

RunnerStop's existing Windows/PTY sequence remains child.kill() followed by injected killTree, then
its existing exit/root check. **Owned ConPTY taskkill is an explicit retained exception.** Replacing it
with a hold-root-before-console design is outside this change. “Taskkill is recovered-only” is not a
universal claim.

The older core killTree API remains a best-effort attempted boolean for its existing callers, not a
cleanup certificate. Resident/gateway consumers retain their existing verification and fences.
Owned-record recovery now captures the shape-identified incumbent's actual birth through the shared
probe, fences writes until that original writer is gone, and verifies matching cleanup scope before
retirement; see [owned-record recovery](OWNED-PROCESS-RECOVERY-v1.md). This does not authenticate a
malicious local health responder, backfill old tokens or add gateway/Linux wall-clock authority.

Linux incumbent takeover replaces the old killTree group-then-root signals with birth-verified TERM
then KILL to the incumbent root only, leaving managed workers to its own shutdown and record recovery;
Windows takeover still ends the reachable held tree.

## Qualification boundary

Existing synthetic-PID piped fixtures explicitly select the legacy Win32 syscall profile, retaining their
original root/console assertions without ever probing a real POSIX group by a fake PID. Actual POSIX
behavior is covered separately by the fully injected group fixtures and owned native rigs. Missing-command
fixtures retain their real platform so spawn rejection still exercises the actual OS boundary.

Decision mutants run only with injected effects and throwing default syscall tripwires in isolated
scratch/test processes. Native qualification is separate: only fixture-owned PIDs/PGIDs, no fleet sweep,
no daemon entry, and no native/default-killer mutation. The native negative control records termination
requests without issuing them, then lets the private fixtures clean themselves up voluntarily; its red
result proves the absence probe can say no. Source publication does not authorize install/restart or
live adoption.
