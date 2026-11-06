# Bootstrap source test gate

When changing `bin/aify-env.mjs`, run the complete source-reader population below, as well as the tests for the changed behavior. Importing that entry point starts the daemon; source-executed fixtures instead supply its dependencies explicitly. A new boot dependency must reach those fixtures too.

## Census: 2026-11-06

The resolved population contains **28 tracked automated test files**: 23 direct/aliased source readers and five indirect readers. The indirect readers are `agent-definitions-have-one-writer`, `aify-env-installs-the-wrapper-it-was-tested-against`, `no-oversized-source-file`, `only-a-plugin-may-know-a-service` (whole-source walks), and `bin-names-cannot-collide` (the package's declared bin target).

The census checked tracked `tests/` sources for the entry filename, `new Function`/VM execution, file reads and generic `lib`/`bin` walks; it resolved aliases such as `ENTRY` and the manifest bin target. The managed-child bootstrap reader was the positive control; `runner.test.js`, which does not read the entry source, was the negative control. This is a source-reader gate, not the separate population of tests that only launch a sealed child process. Refresh the census when readers or their helpers change; a filename search alone misses the indirect readers.

Run from the development checkout through the normal isolated runner, with the project's required identity stripping and explicit peer-checkout environment. On Windows with the peers available, this population permits no skips or cancellations. Other platforms must name any platform-only cases not run.

```bash
npm test -- \
  tests/a-credential-acl-is-read-once-per-change.test.js \
  tests/a-defined-start-gets-its-contributions-on-both-routes.test.js \
  tests/a-held-plugin-keeps-its-own-key.test.js \
  tests/a-managed-agents-word-follows-its-screen.test.js \
  tests/a-managed-workers-pane-shows-its-agents-word.test.js \
  tests/a-plugin-knows-whether-its-instance-is-dedicated.test.js \
  tests/a-seal-that-is-empty-is-not-a-seal.test.js \
  tests/a-started-worker-gets-a-herdr-space.test.js \
  tests/a-state-change-is-published-when-it-happens.test.js \
  tests/agent-definitions-have-one-writer.test.js \
  tests/aify-env-installs-the-wrapper-it-was-tested-against.test.js \
  tests/an-idle-stream-stays-open.test.js \
  tests/bin-names-cannot-collide.test.js \
  tests/key-carrying-fetches-do-not-follow-redirects-and-advertising-cannot-crash-the-daemon.test.js \
  tests/launch-roots.test.js \
  tests/no-oversized-source-file.test.js \
  tests/only-a-plugin-may-know-a-service.test.js \
  tests/production-picker-bootstrap.test.js \
  tests/the-activity-read-asks-the-os-without-blocking.test.js \
  tests/the-daemon-sends-agent-state.test.js \
  tests/the-daemon-speaks-into-the-view-not-through-it.test.js \
  tests/the-heartbeat-carries-where-this-daemon-starts-work.test.js \
  tests/the-host-advertiser-keeps-its-own-rules.test.js \
  tests/the-managed-child-reaches-agent-state.test.js \
  tests/the-plugin-heartbeat-carries-the-machine-id.test.js \
  tests/the-tui-stays-on-screen.test.js \
  tests/usage.test.js \
  tests/where-workers-have-herdr-spaces-the-console-gives-way.test.js
```

## Why the whole population

The model-selection wiring passed its receiver/store/protocol gates but broke two source-executed bootstrap fixtures: the managed-child `new Function` parameters and the sender's `AsyncFunction` dependencies did not supply `ModelSelections`. Both now supply the real constructor. The managed-child fixture also asserts that HTTP dependencies receive the booted owner; deleting only the HTTP dependency makes that named assertion fail. A subset chosen by feature name did not cover the boot file's actual consumers.
