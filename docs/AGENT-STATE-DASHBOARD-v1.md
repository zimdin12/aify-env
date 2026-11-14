# Agent state, as the dashboard receives it (contract v1)

aify-env POSTs every agent-state publication to each destination it reports to; aify-dashboard is one. This is what
the dashboard admits, agreed with its owner on 2026-10-28, and the test that holds aify-env to it:
`tests/the-agent-state-post-fits-the-dashboards-envelope.test.js`, which checks the shared sender-captured bodies
against the historical compatibility block below. `tests/agent-state-schema.test.js` regenerates those bodies through
the actual host, reader, publisher and sender transport, and validates the current producer schema.

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
- `retired.reason`: `shutdown` only. `operator-attested` is refused, not a supported alternative.
- At most 64 levels of nesting.
- A lifetime may not be both changed and removed in one push.

## Records

Required: `agentId` (a non-empty string) and `lifetime` (a non-empty string, or null). The dashboard reads `state`,
`stateCause`, `name`, `role`, `busy`, `launch.cwd` and `launch.definition`; the rest is kept as received.

State words with a tone of their own: `starting`, `shell` and `idle` are ok; `available` is idle; `working`, `blocked`
and `unknown` warn; `misconfigured` is an error; `offline` and `stopped` are off. Any other word is shown with the
warn tone, not refused. `stateCause` is display evidence, not a definition fact.

`record.definition`, when known, is exactly `valid`, `invalid`, `unavailable` or `none`, projected from the facts used
by state derivation. Invalid and unavailable still describe a definition; none is known absence. Missing means an
older sender or an unknown fact, never implicit none. Present null is forbidden. Do not infer it from state/cause or
`launch.definition`, which remains only the launch reference and can be null for quiet defined agents.
Feature-detect this optional fact; the wire's `build` identity is not a Git SHA. Delete/lifecycle authorization remains separate.

## Machine-readable producer contract

The current sender contract is [agent-state/schema.json](agent-state/schema.json), JSON Schema draft-07. It describes
what env emits now, not every legacy body a receiver might still accept. In particular it requires `inputs`, positive
publication numbers and the current record fields; snapshots include empty `removed`. Retirement admits only
`shutdown`, with no cadence or rows. The nested `launch.definition` type describes its existing reference tag, not a
schema for agent definitions. Definition, registry and service-spec schemas are outside this change.

[agent-state/publications.json](agent-state/publications.json) is the one fixture/example set for env, comms and the
dashboard. Each entry is `{name, body}`; send or validate `body`, not the wrapper. All28 bodies were captured from
`AgentStateSender`'s serialized POST at an injected transport, using real `AgentStateHost`, `readAgentStates` and
`AgentStatePublisher`. Definition listings, OS answers, lifecycle facts, clock and transport are fixture inputs.
No daemon, child process, real credentials or network request is involved. Names and paths are neutral fixture data.
The current host does not emit an intermediate starting row; the enum retains that real derivation state without
inventing a captured example for it.

The set covers all four publication kinds, managed and resident rows, null identities, closed/open/future-aged turns,
lifetime replacement/removal, empty snapshots, unavailable inputs and omitted invalid metadata. Screen causes are
nonempty strings, not a closed enum: the real host emits a sighting's rule, for example `folder-trust`.

Run `npm test -- tests/agent-state-schema.test.js tests/the-agent-state-post-fits-the-dashboards-envelope.test.js` in
the normal private test environment. `AIFY_UPDATE_AGENT_STATE_FIXTURES=1` on that run regenerates the same example
file through the sender, rather than hand-editing bodies. Ordinary runs require identical regenerated values.
The validator is dev-only npm `jsonschema`1.5.0, pinned in package.json and package-lock.json; runtime adds nothing.
Its schema identifier uses a reserved `.invalid` HTTPS URI only to resolve local JSON pointers, with no remote fetch.

This structural schema does not implement transport byte/depth limits, duplicate JSON-key detection, cross-row
agent/lifetime uniqueness or publication ordering/claim rules. Receivers retain those guards; JSON Schema acceptance
alone must not be reported as complete ingest admission. The compatibility envelope above remains useful for the
older dashboard reader, whose record handling is looser than the current producer schema.

## Receiver projection policy

This is the shared projection rule, before any service-specific delivery, usage or UI-label overlay. Its one staleness multiple is:

```receiver-policy
{"staleAfterIntervals": 3}
```

- A publisher key is `(machineId, instance)`. Accepted contact means a valid publication actually applied by the receiver,
  not a duplicate, stale/refused body or an attempted send. For each non-retired key, contact is fresh only while its
  nonnegative receipt age is strictly below `staleAfterIntervals *` its own valid announced `reportEveryMs`.
  At or beyond that boundary it proves silence. Missing/invalid contact or cadence, and future/invalid clocks, prove neither.
- Contact alone does not make data fresh: the current data must also be complete and readable, not lost or unavailable.
  An accepted `unavailable` report renews contact without freshening old rows. Restored/saved data never becomes fresh
  merely by loading it; its saved valid contact pair can still prove silence.
- A key yields for an agent only on proven silence and only when a fresh, readable peer on the same machine lists that
  same agent. Yield does not delete or retire the key, and an accepted renewed report can participate again.
- Two live publishers that disagree about an agent remain conflict/unknown. Newer receipt time, generation or build
  from another key never overrides a still-live conflicting report. Complete-snapshot absence or matching lifetime
  removals withdraw only that key's row, not proof of a global offline/stopped word.

[agent-state/scenarios.json](agent-state/scenarios.json) supplies nine short independent ordered scenarios with expected
canonical env states, not a second receiver implementation. It references the sole captured corpus by zero-based index;
`bindings` pins each index to its capture name. `atMs` is relative to `origin`, cases start with empty state, and each
`accept` applies that indexed body unchanged. `restore` loads saved rows/cursors/contact pairs without changing their
recorded acceptance times. A `read` names an agent and its expected state/conflict or known/absent definition fact.
Consumers execute these expectations in their own receiver tests; env checks reference, shape and boundary consistency.
The extra contact-versus-data case is kept separate so another unknown holder cannot mask that distinction.

## The dashboard's side

Enforced in aify-dashboard by `server/src/agent-state/publication.ts` (the receiver) and read by
`ui/src/agent-state.ts` and `ui/src/agents-board.ts`. Its `server/src/agent-state/sender-contract.test.ts` tests a
vendored copy of this repo's publisher; tell the dashboard's maintainers when the publisher changes, before the change reaches a
release, so it is vendored again.
