# Agent state, as the dashboard receives it (contract v1)

aify-env POSTs every agent-state publication to each destination it reports to; aify-dashboard is one. This is what
the dashboard admits, agreed with its owner on 2026-10-28, and the test that holds aify-env to it:
`tests/the-agent-state-post-fits-the-dashboards-envelope.test.js`, which builds real bodies with
`lib/agent-state-publisher.mjs` and checks them against the block below.

## The envelope is strict; records are not

ANY TOP-LEVEL FIELD OUTSIDE ITS KIND'S LIST REFUSES THE WHOLE PUSH (code `unexpected_field`). On 2026-10-20 aify-env
added `build`, and the dashboard applied no agent state for 17 hours. So a new envelope field ships on the dashboard
first, then here: adding one to the publisher turns the test red until this block, and the dashboard, have moved.

Inside an agent record anything is kept as received.

```envelope
every: kind machineId instance generation incarnationId publication inputs? build?
snapshot: reportEveryMs? complete agents removed?
changes: reportEveryMs? agents removed
unavailable: reportEveryMs? reason
retired: reason
```

`every` applies to all four kinds. A `?` field is optional; the rest must be present.

## Values

- `generation`: a whole number of at least 1. aify-env's is a positive safe integer; the publisher throws otherwise.
- `publication`: a whole number of at least 0. aify-env's first body is 1.
- `incarnationId`: a non-empty string.
- `build`: 1-200 printable ASCII characters, no space. aify-env omits it rather than send one that is not.
- `reportEveryMs`: a whole number from 1000 to 3600000. aify-env sends it on every kind but `retired`.
- `inputs`: an object whose values are strings, keys open. `retired` carries `inputs: {}`, explicitly.
- `snapshot.complete`: true. aify-env sends `removed: []` on every snapshot.
- `changes.removed`: an array, always present.
- `unavailable.reason`: a non-empty string.
- `retired.reason`: `shutdown` or `operator-attested`. aify-env produces only `shutdown`.
- At most 64 levels of nesting.
- A lifetime may not be both changed and removed in one push.

## Records

Required: `agentId` (a non-empty string) and `lifetime` (a non-empty string, or null). The dashboard reads `state`,
`stateCause`, `name`, `role`, `busy`, `launch.cwd` and `launch.definition`; the rest is kept as received.

State words with a tone of their own: `starting`, `shell` and `idle` are ok; `available` is idle; `working`, `blocked`
and `unknown` warn; `misconfigured` is an error; `offline` and `stopped` are off. Any other word is shown with the
warn tone, not refused. `stateCause` is shown verbatim under the state; `startable`, `operator-stop` and `config` also
count as "defined while quiet".

## The dashboard's side

Enforced in aify-dashboard by `server/src/agent-state/publication.ts` (the receiver) and read by
`ui/src/agent-state.ts` and `ui/src/agents-board.ts`. Its `server/src/agent-state/sender-contract.test.ts` tests a
vendored copy of this repo's publisher; tell dashboard-manager when the publisher changes, before the change reaches a
release, so it is vendored again.
