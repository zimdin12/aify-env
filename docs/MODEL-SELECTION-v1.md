# Explicit model selection (receiver contract v1)

`POST /agents/:id/model-selection` writes only the existing definition's `agent.model`; it never changes a running model. The HTTP authority/browser protections apply first. Instance/lifetime admission follows turn-event and gateway: this daemon's own population, or `residents` only while it holds that role; a fresh current identity must match the posted lifetime.

This body was agreed with the wrapper owner on 2026-11-06. It replaces the old settingsModel/display/firedAtUs proposal. Env does no model-name inversion or settings read.

## Two strict body shapes

An explicit launch argument, or no explicit choice:

```json
{
  "instance": "default",
  "lifetime": "11111111-1111-4111-8111-111111111111",
  "harness": "claude",
  "source": "launch",
  "session": "",
  "transcriptIdentity": null,
  "endOffset": null,
  "recordUuid": null,
  "value": null
}
```

Here `value` is the exact explicit argument string, or null when no explicit launch model exists. Null writes nothing. A lifetime admits the launch phase once, and no delayed launch may overwrite an admitted transcript choice.

A recognized completed native choice:

```json
{
  "instance": "default",
  "lifetime": "11111111-1111-4111-8111-111111111111",
  "harness": "claude",
  "source": "model-command",
  "session": "22222222-2222-4222-8222-222222222222",
  "transcriptIdentity": "opaque-native-file-identity",
  "endOffset": 4096,
  "recordUuid": "33333333-3333-4333-8333-333333333333",
  "value": "provider-qualified-model"
}
```

`value` is a literal catalog model string, `""` for explicit native Default, or null for a recognized completed choice whose value is unresolved. Unresolved advances ordering but never clears the definition. Unknown fields/shapes, non-integer or unsafe offsets, and mismatched admission are refused; nothing is coerced. This stage supports Claude only.

The first completion pins the producer's native session/file domain for that lifetime. A domain change refuses rather than resetting history. This does not independently attest the file on the receiver: the admitted producer owns the prelaunch fence, complete-record parsing, native origin, catalog qualification and replacement/truncation detection. Typed and picker choices share one file-byte domain. `endOffset` is the positive safe-integer END of the newline-terminated record beyond that launch's fence. UUID identifies a record; it is never sorted as a clock.

## Ordering and persistence

Only a strictly newer offset is eligible. Equal duplicates are idempotent; conflicting record identity at the same position cannot apply a different value. Older positions cannot write. Every eligible resolved occurrence rereads the actual definition, so an A re-pick reasserts A after an external edit to B even when the last reported value was already A.

The receiver advances its in-memory fence when admitting a newer completion, **before** reading/writing the definition. That includes unresolved values and failed writes: neither permits a delayed older value to move the definition backwards. Current identity, residents-role ownership and the newest admitted position are checked again at the store's locked effect boundary. Existing DefinitionStore CAS refuses an intervening definition change; no definition is created to satisfy a report.

A successful changed value emits one warning naming agent, old/new literal values and source. Unchanged values emit no change warning. Failures return a fixed diagnostic and are logged once; neither side adds a retry queue, replay file or polling loop. Warning text escapes literal values onto one line. Metadata maintained by DefinitionStore (revision/operation/time) changes normally; other agent fields and incarnation remain unchanged.

## Responses

Successful handling returns `200` with `{agentId, applied, changed, reason}`. A changed write has
`applied:true, changed:true`; an equal current value has `applied:true, changed:false`. Null choices,
duplicates, older positions and superseded pending writes have `applied:false, changed:false`.
Malformed envelopes return `400`; wrong admission, native domain/record conflicts and harness
mismatch return `409`; unavailable identity/definition/store dependencies return `503`.
Refusals include `{agentId, applied:false, reason}` with a fixed diagnostic, not internal error text.

## Known limits and qualification

The fence is memory-only by the lead's explicit decision. After receiver restart it is empty and the first admitted report establishes it again. This is not durable ordering across restart; the newest-report-after-restart case is a test, not proof against every delayed transport from an earlier receiver. The wrapper serializes its per-session scanner and does not queue failed reports.

No explicit launch record means no write. `/config`, fast mode, unsupported fork/session changes, unqualified catalogs and failed/cancelled selections must not become guessed values. Hard kills and lost transport have no guaranteed final delivery. Native current-version catalog/flush/exit behavior and actual running adoption are qualified separately at the joint switch; receiver tests do not establish them.
