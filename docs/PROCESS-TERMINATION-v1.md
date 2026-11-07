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
release refusal is returned as unknown rather than reaped. Existing durable records can be retained,
but this change adds no recovery format and does not establish hard-crash recovery (#17).

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

`heldKill(pid, {stillOurs, start?, powershell?})` returns Promise<void>. The caller must own a live child
and provide a current exit-unseen witness. Self/parent/init targets are refused before a helper starts.
The helper holds the root before the callback decides go/no-go; held handles preserve identity while
the reachable tree is ended. Unknown open/query/list/wait/termination outcomes reject. This API does
not accept a recovered PID or claim an already orphaned subtree was reached. The moved C# algorithm
and handshake are the existing ones; the implementation lives in core. The old plugin module is a
compatibility re-export only, not a second implementation.

`endOwnedChildTree(pid, {platform?, own?, group?, stillOurs?, held?, timeoutMs?})` selects the strict
owned-group or held-child port. A supplied own handle must match pid. A best-effort own-handle kill
never certifies unknown tree cleanup; no numeric positive-PID fallback is added.

## Preserved exception and recovery boundary

RunnerStop's existing Windows/PTY sequence remains child.kill() followed by injected killTree, then
its existing exit/root check. **Owned ConPTY taskkill is an explicit retained exception.** Replacing it
with a hold-root-before-console design is outside this change. “Taskkill is recovered-only” is not a
universal claim.

The older core killTree API remains a best-effort attempted boolean for its existing callers, not a
cleanup certificate. Recorded orphan/resident/gateway consumers retain their existing verification
and fences. Supersede retains its health-shape-identified PID policy; it is not relabelled birth-verified.
No new gateway, owner-record, token-backfill, process-query or Linux clock-conversion authority is added.

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
