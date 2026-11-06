# Whole-tree review gates

Every env review runs this complete population in addition to behavior/caller tests. A boot-file wiring change also runs [BOOT-SOURCE-TESTS.md](BOOT-SOURCE-TESTS.md). These bounded gates do not replace the full tag-candidate suite.

## Census: 2026-11-06

The **25 files** below are selected by their inputs, not by the feature being changed:

- Export/name/package indexes read `lib/`, root tests, `package.json`, the declared bin/export targets, version declarations and the command registry.
- Structural gates walk production source for size, definition writers and plugin-boundary coupling; the wrapper-pin gate scans the install source; the shell gate scans root/scripts installers.
- Test-safety gates enumerate test source, directly or through `_daemon-spawns.mjs`, and check registry/home/port seals. The doctor-home gate also enumerates tests. Runner gates cover named selectors, concurrency and inherited session identity.
- Documentation gates consume the actual README key/layout tables, while the view-field gate enumerates `lib/tui-panes`. The allowlist gate checks that the actual README is not executable.

The census examined tracked test file reads and directory walks, including helper-mediated scans. Fixture-only directory listings and fake in-memory source trees are not whole-tree scans. Refresh this list when a scanner or its inputs change. `every-export-is-tested.test.js` is a positive population control; `lifecycle-death-unknown.test.js`, whose directory reads concern only its fixtures, is a negative control. A filename-only search is not an exhaustive reference resolver for arbitrary computed readers.

Run through `npm test` with identity stripped and peer checkouts set as required by the project. Report failures, cancellations and skipped cases separately, including the exact skip reason; exit zero alone is not qualification.

```bash
npm test -- \
  tests/a-named-test-file-must-exist.test.js \
  tests/a-test-daemon-describes-nobody.test.js \
  tests/agent-definitions-have-one-writer.test.js \
  tests/aify-env-installs-the-wrapper-it-was-tested-against.test.js \
  tests/allowlist.test.js \
  tests/bin-names-cannot-collide.test.js \
  tests/every-export-is-tested.test.js \
  tests/no-command-substitution-in-installer-strings.test.js \
  tests/no-oversized-source-file.test.js \
  tests/no-test-binds-a-hardcoded-port.test.js \
  tests/no-test-daemon-inherits-the-real-registry.test.js \
  tests/no-test-daemon-resolves-the-real-home.test.js \
  tests/no-test-inherits-an-ambient-registry.test.js \
  tests/one-command-with-subcommands.test.js \
  tests/one-version-not-three.test.js \
  tests/only-a-plugin-may-know-a-service.test.js \
  tests/the-agents-list-shows-the-columns-asked-for.test.js \
  tests/the-doctor-reads-only-the-home-it-is-given.test.js \
  tests/the-host-api-is-declared.test.js \
  tests/the-keys-are-documented.test.js \
  tests/the-redraw-key-is-documented.test.js \
  tests/the-suite-runs-four-files-at-once.test.js \
  tests/the-suite-runs-outside-the-agent-session-that-started-it.test.js \
  tests/the-view-gets-every-field-it-renders.test.js \
  tests/usage.test.js
```
