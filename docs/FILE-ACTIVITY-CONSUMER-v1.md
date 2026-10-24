# File activity consumer, ingress v1 and storage v2

File activity is disabled by default. This plugin does not enable the dashboard capability or a wrapper producer. Core lifecycle, agent-state, Herdr, status and worker-secret contributions are unchanged.

## Configuration

The maintained plugin configuration reader supplies `plugins["aify-dashboard"].activity`. For example, a disabled configuration with explicit grants is:

```json
{
  "plugins": {
    "aify-dashboard": {
      "activity": {
        "enabled": false,
        "leaseDirectory": "C:/local/agents",
        "wrapperCheckout": "C:/local/aify-wrapper",
        "sessionBytes": 8388608,
        "maxSessions": 16,
        "maxAgeMs": 86400000
      }
    }
  }
}
```

Enabling it requires an explicit boolean `true` and both absolute paths. `wrapperCheckout` is an execution grant, like `providerCheckout`: the plugin imports JavaScript from that trusted checkout. Do not grant an untrusted or automatically located installation. There is no home scan, global-package fallback or implicit execution grant.

`leaseDirectory` must be the producer's exact absolute lease directory. Discovery considers `<leaseDirectory>/<validated agentId>/activity-v2`, not transcripts or lease-record contents. `activity-v1` is untouched. Symlink/junction ancestors and unexpected entry types refuse admission. Regular lease files are ignored. Missing and empty raw roots are not initialized. Admission assumes cooperating local writers, not hostile same-user ancestor replacement.

The consumer imports only the granted checkout's `lib/file-activity.mjs` validators. The producer exposes append only. The plugin owns cursors, ACKs, gap identity, age and recovery. Displayed settings are defaults and inclusive maxima; optional values may only lower them. Each raw line retains its original validated policy. A wider consumer setting cannot widen an old line's byte/age allowance. A stricter session-count setting refuses an over-limit root rather than omitting sources. Use the approved STORAGEv2 wrapper source recorded in the private receipt.

Configuration is read on each maintained plugin tick. Disabling it stops new activity passes. Stop or detach aborts the current request, waits for it to unwind, and forbids late ACK/recovery writes. Declining to another environment suppresses discovery and delivery on that same lifecycle. Activity has no independent watcher or immediate drain/retry loop. Each tick selects at most one existing agent directory in round-robin order and submits at most one source batch. The cursor remains local and durable across plugin/process restarts.

## Discovery and authentication

The first enabled tick asks its existing registry entry's endpoint for `/.well-known/aify-service` through `DashboardApi`. This same-endpoint spec request is necessary because older registry readers do not retain the new fixed declaration. A successfully read declaration, including an absent capability, is retained until the plugin restarts; idle ticks do not refetch it. Failed discovery requests can retry on a later existing tick. Only `fixed.fileActivity: {"path":"/api/v1/file-activity"}` authorizes ingress. An absent or malformed declaration permits neither a trial activity POST nor importing the wrapper grant. Restart the plugin after changing the receiver's declared capability.

Activity ingress presents `x-aify-activity-key` containing the existing API_KEY from the existing per-call credential getter. It never presents `x-api-key` or the secrets header. Legacy requests and the separate secrets-fetch credential retain their original headers and authority. There is no second activity credential. Redirects are manual. The existing ten-second request deadline and plugin stop signal cover body reads too. Activity error messages contain bounded local descriptions, not remote response, header, path or credential bytes.

## Delivery and coverage

The consumer sends only `record.event`, its source identity and the spool's coverage/gaps. It preserves event IDs and bodies, leaves unproved incarnation null, omits WSL facts and sends `reportEveryMs: null`. Unknown coverage and nullable loss counts remain unknown. Empty discovery or an idle spool does not establish complete producer history. The local doctor reports coverage unknown; no unsupported producer rows or freshness cadence are invented.

Requests have at most 128 unique event IDs, 32 gaps and 256 KiB encoded JSON. Ordinary batches split at 240 KiB to leave recovery headroom. Approved individual records fit these bounds. Oversized raw segments, unexpected entries and exhausted checkpoint capacity refuse delivery without deleting input. A future record format needs separate qualification.

Only HTTP 200 with the exact version/batch ID, ordered results, admitted dispositions/refusal codes, matching generation and complete unique submitted gap-ID set authorizes an ACK. Terminal refusals first become durable gaps. A valid 409 persists only named event/gap conflicts, with event precedence for mixed conflicts and fresh replacement IDs for conflicting gaps. A 409 never advances the cursor. Unaffected records/gaps are resubmitted with fresh batch IDs and stable recovery IDs. Invalid receipts, transport failures and cancellation authorize no discard. Every update reopens the actual consumer checkpoint and checks its token and raw prefix.

## Checkpoints, clocks and retirement

State lives outside the producer root at `<leaseDirectory>/<agentId>/.aify-dashboard-activity-v2/<sha256(receiver endpoint)>/state.json`. The existing plugin context supplies no state directory; this location stays inside the explicit lease grant without a new home/config path. Receiver hashing prevents cross-receiver ACK reuse. The checkpoint is capped at 256 KiB and 16 source entries; a staged interval has at most 128 dispositions and 32 gaps. A fixed temporary file and exclusive operation lock add bounded overhead. Writes fsync the temporary file and atomically rename it. Ordinary drained reads do not publish or fsync a checkpoint.

Checkpoint transactions require the existing optional `koffi` 3.3.3 dependency and its matching native platform package. Missing native support refuses the operation; there is no unlocked fallback or native-free transaction claim. On Windows, a non-inheritable `CreateFileW` handle with zero sharing owns the stable `lock` rendezvous until close or process death. The rendezvous is never unlinked. POSIX `flock` is implemented but not qualified by the native Windows receipts. This lock serializes consumer operations, not producer hooks. Directory-fsync and power-loss durability are not claimed.

Before HTTP, the checkpoint persists the source, file identity, checked-prefix digest, contiguous committed offset, fixed staged interval, clock fence, generation and stable gap IDs. Later append bytes wait for another batch. Replacement bytes cannot inherit a deterministic filename's old cursor. Replacement creates an identity gap, retains pending recovery markers and starts at byte zero. Invalid checkpoints fail closed without reset. Same-reason losses may share one nullable-count gap per batch; each named event disposition remains recorded until the gap obligations commit.

Raw envelopes require exact STORAGEv2 schema, original policy/clocks, a valid unchanged activity v1 record and the complete-source filename hash. Malformed/torn bytes become gaps once a valid retained frame establishes the source. Parsing continues to later complete frames, including producer-delimited recovery and fully validated suffixes after torn prefixes. Corrupt lines require at most two JSON parse attempts; malformed runs compact into intervals clipped at the committed offset, so newly appended bad bytes never inherit an old gap ACK. Unknown sources are never fabricated. `.loss` persists until the whole ended source qualifies for reclamation below. Root `uncertain` is never removed. A marker does not veto later valid records or establish complete coverage.

Age comes from original pre-append wall and host-uptime clocks, never event time, first poll or restart. Rollback, reboot or elapsed-time disagreement over 2000 ms means a gap. Cross-poll discontinuities durably fence the affected byte range, even after clocks recover. Expiry cannot be renewed by a wider setting or retry. Invalid current clocks refuse delivery without resetting continuity.

Physical reclamation requires all bytes through the current EOF and every source-marker obligation to be committed. The consumer must also have captured this source's exact agent, instance, lifetime, PID and process birth through the existing host lifecycle identity while that lifetime was current. It persists that witness with a shipped batch, not on each idle observation. Fresh maintained process evidence must prove the captured process gone or its birth mismatched. A missing current lifecycle record is never END evidence. Live, null, unknown and unbound historical incarnations remain retained and count against capacity. A live incarnation opening more than 16 sessions can still exhaust the limit; producer uncertainty remains visible.

Before unlinking, the consumer ships a stable terminal gap with `reason: "reclaimed"`, unknown coverage and nullable loss count. This declares that hooks still in flight when the agent ended may not be captured; the session tail is possibly incomplete, never complete. A terminal-gap 409 creates a fresh conflicting-gap ID but preserves `reclaimed`, and cannot count as an ACK. Only the exact committed terminal ID and generation authorize removal on a later existing tick. EOF, immutable-prefix/file identity, marker obligation and fresh END evidence are rechecked under the consumer operation lock. No writer scan, writer lock, producer handshake, grace interval or time-based expiry authorizes deletion. Windows sharing refusal retains the file and retries on a later tick without force or idle checkpoint churn.

Bounded per-source retirement metadata records the terminal obligation, its committed generation and successful marker/raw unlink outcomes. The checkpoint slot is removed only after the raw unlink outcome is saved. A persistent generation floor prevents recycled slots from restarting delivery generations. A late callback opening the same filename creates a fresh file identity, read from byte zero; an already-open callback can write into an unlinked inode, covered by the declared terminal gap. If a crash lands after an unlink but before its outcome save, missing files do not prove our own success. That ambiguous outcome retains its bounded slot and reports unknown coverage instead of silently freeing capacity. A saved marker-removal outcome can resume raw removal after restart, and a saved raw-removal outcome can resume slot retirement. Externally missing files are not silently attributed to this consumer.

## Qualification scope

Run focused consumers through `npm test`, with explicit `AIFY_WRAPPER_REPO` pointing to the frozen approved wrapper source. Missing prerequisites skip cross-repository tests and do not qualify activity. The evidence README contains results and reproduction commands. Drivers, native logs, fixture snapshots and expanded source bindings stay private under ignored `.check-output`.

The HTTP listener is a protocol stub, not the dashboard receiver. Native junction tests are real; the state-file symlink guard also has an explicitly labeled lstat metadata stub because this Windows worker refused native file-symlink creation. Linux/WSL behavior, actual Claude callbacks, full governing suites and real-dashboard composition remain integration obligations. No live service or activity capability was enabled.
