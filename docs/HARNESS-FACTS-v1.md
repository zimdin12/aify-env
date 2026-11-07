# Harness facts v1

The host owns `HARNESS_FACTS` in `lib/agent-definition-schema.mjs`. The wrapper retains its tested,
byte-identical copy of that module. This is one source of platform facts, not a new catalog or a
claim that every component implements every harness capability.

## Facts and admission are different

Rows are keyed by canonical harness and are deeply frozen:

- `runtime`: the runtime name used when that harness is admitted by definitions;
- `definition`: whether the current definition schema admits the harness;
- `install`: whether the guided chain accepts its canonical client selection;
- `managed`: the launcher's managed-mode capability, not current definition admission or complete
  service integration;
- `resident`: whether the current resident-record protocol supports this harness;
- `screen`: whether screen detection is supported and a working manifest is expected; it is not a
  claim that the manifest was loaded or a screen was observed;
- `residentReason`: the explanation when resident support is false;
- `aliases`: other launcher client stems, not additional accepted definition/resident spellings.

Consumers choose the fact they need. Definition validation and `HARNESS_RUNTIME` derive only rows
with `definition: true`; installer choices derive `install: true`; resident records require declared
resident support. Actual screen observation derives from the loaded manifest; `screen` separately
states whether failure to load one is an unhealthy host or an expected unsupported capability.

## Staged Pi admission

The facts include Claude, Codex, Hermes and Pi. Codex is not parked. Existing Pi launchers remain
discoverable and have managed-mode capability; `omp-aify` is Pi's launcher alias. Pi's `install` fact
is false: guided-install selections remain exactly Claude, Codex and Hermes. The service installer
refuses Pi assets, so discovering an installed Pi must not make it selectable for guided installation.
Pi cannot provide resident wake because OMP is single-client. It currently has no screen manifest.

**Definition admission is deferred for Pi.** In this change the production definition enum and the
shared `tests/fixtures/agent-definitions/cases.json` remain exactly unchanged: only `claude`, `codex`
and `hermes` are accepted. Pi's `definition` fact is false. A Pi-defined managed start is NOT completed
or qualified by this change. The receiver-first follow-up is:

1. comms #35 step 2 accepts Pi in its definition schema, runtime mapping and vocabulary;
2. env then widens Pi's definition flag and its shared fixture cases.

That sequence is separate from publishing the facts. Neither a table row nor a marked launcher
implies that the service currently accepts Pi definitions. No fixture may invent such an accepted
production definition to claim otherwise. Tests may add isolated fake rows to a copied export to
prove that consumers derive their decisions rather than remembering another list.

## Existing residents

Before this change the parser and wrapper record writer accept canonical `claude`, `codex` and
`hermes`; each remains `resident: true`. The current templates pass exactly those harness values to
`aify_lifetime_start`. Runtime/screen aliases `claude-code` and `hermes-agent` are not accepted resident
record spellings. The wrapper's only launcher alias is `omp-aify` for Pi, which has no resident-record
support. The compatibility controls retain an existing record of each accepted canonical kind
unchanged; no newly restrictive resident rule is introduced.

## Discovery and observation

Discovery reads launchers and their marker; it never runs them. Known aliases resolve to their
canonical harness. Unknown marked launchers remain explicit inventory diagnoses, not supported
advertisements: "installed but not in this aify-env's harness table".

A manifest that is missing, unreadable or invalid is **unknown**, not loaded and not silently absent.
The loader and launcher inventories retain that outcome. Doctor reports UNANSWERED for a discovered
harness whose screen expectation is true (or missing) but whose manifest could not load. Explicitly
unsupported screen detection and deferred definition admission are PASSED information: decided
limitations do not permanently fail a healthy Pi host. Unknown marked launcher identities remain
UNANSWERED. These informational rows do not grant definition admission or claim a loaded manifest.
Optional uninstalled harnesses do not cause warnings. The registry forwards the existing screen
adapter's manifest snapshot until its planned relocation. The screen observer evaluates nothing for that runtime
and must not manufacture a known-agent idle result. Existing manifest files and their aliases remain
the observation data; no new manifest format or distribution mechanism is introduced here.

## Ownership and limits

The wrapper owner adopts the exact approved schema bytes and tests the new export. Pi's
installation-disabled header remains consistent with the unchanged guided-install policy. Comms #35 consumes the producer facts later; this
change does not edit comms. Source changes do not authorize an install, launcher render, service
restart or live adoption. Fixture coverage establishes these component contracts, not native Pi
end-to-end operation. The review must record the Pi-definition deferral explicitly.
