# Process identity v1

This is the env/wrapper record contract for GitHub #22. Env owns process observations and admission;
wrapper owns resident-launcher publication. Env's compatible reader must land on main before the
wrapper writer lands. Publishing either source does not authorize launcher rendering or live adoption.

## Linux record field

A new owned-process or resident record may carry `startToken`:

```json
{
  "version": 1,
  "platform": "linux",
  "bootId": "d57f8bed-05a8-4d57-bd23-c59952256667",
  "pid": 41236,
  "startTicks": "9007199254740993"
}
```

The object has exactly these five fields. `bootId` is the lowercase UUID from
`/proc/sys/kernel/random/boot_id`; `pid` is the record's same positive safe-integer PID;
`startTicks` is the raw decimal string in `/proc/<pid>/stat` field 22. The example ticks deliberately
exceed JavaScript's exact Number range. Do not convert ticks to Number, seconds, epoch time or btime.
Compare all five field values exactly. A different boot ID, PID or tick string is a different identity.

The proc stat parser checks its leading PID against the expected PID and splits after the final `)`
terminating comm. Spaces, parentheses and newlines inside comm do not shift field 22. Invalid or
incomplete input answers unknown; it must not produce a token from another process or a rounded tick.

## Capture custody

- Env captures for its own newly spawned live child at the spawn/record boundary, not when recovering
  a durable record. A missed capture leaves identity unknown.
- The resident's owning Linux shell captures its own complete `/proc/$$/stat` and boot ID with shell
  built-ins. It passes those raw captures beside the PID it already supplies to
  `aify-resident-record.mjs`. The writer validates the captured PID against the recorded PID before
  extracting field 22. The helper's Node PID is not the launcher PID.
- Neither reader nor writer backfills a token by probing an arbitrary PID from an old record.
- Windows resident publication adds no PowerShell invocation.

## Read, observe, decide

Legacy records without `startToken` remain readable. A malformed optional token also cannot authorize
an effect. Linux admission requires an OS-observed live process, a valid matching token and the
existing launcher identity check. Missing, unreadable or mismatching identity is unknown: no adoption
and no kill. A tokenless record is not upgraded merely because its PID is currently alive.

The shared probe reports per-PID liveness, command line and identity. A failed probe is unknown, never
an empty successful population. A confirmed absence is distinct from an identity mismatch. Cache
refresh preserves identity fields; signal zero between observations proves liveness, not identity.
A cached answer older than the record cannot admit it. Linux identity does not depend on wall time.

Windows keeps the existing CreationDate-to-microsecond precision and policies: resident creation must
be strictly before the record's `writtenAtUs` (equality is unknown), while env's own child recovery
keeps its legacy millisecond comparison and start-time tolerance. The probe itself retains all
microseconds; only that legacy recovery comparison floors to milliseconds. The complete Windows reap
population uses one asynchronous query, not one or two PowerShell launches per entry. Unsupported
platforms remain unknown. Durable writes, unresolved-record retention and superseded-owner handling
remain #17's scope; this identity change does not claim those cleanup guarantees.

Owned records still name their owner by PID only. #22 does not verify that owner's original identity,
infer an owner token from a saved PID, or add owner-based kill permission. The existing conservative
owner-liveness guard is unchanged. Owner identity publication and its compatibility policy belong to #17.

Fixtures in `tests/fixtures/process-identity-v1.json` bind legacy parsing and Linux token compatibility.
They are format examples, not records of real agents. Wrapper uses the same fixtures when its writer
is implemented; env's reader must already be on main first.

## Effect and qualification limits

Every reap-decision test injects the killer and asserts its calls. Reap/kill mutants run only with that
injected killer. Native test observations concern only the test itself and its own spawned children;
no test may kill or tree-kill a process it did not spawn itself.

Enabling a Linux probe does not establish identity for a different record format. Gateway records
currently contain no owned start token. The gateway book retains its existing Windows-only probe
adapter: Linux gateway decisions stay unchanged, with no new answer, kill, refusal or replacement
block. An owning-writer gateway token is a separate follow-up. Activity-retirement witnesses still
require their existing numeric creation-time evidence; this contract does not invent it.
