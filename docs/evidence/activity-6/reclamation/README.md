# Segment reclamation qualification

Predecessor `20f0782e6a935cf140698cdea9efced18cc53271` passed the combined 188-test selection on native Windows Node 22.20.0 and 26.7.0. It covers physical retirement of 17 ended sources, protected live/unknown sources, exact terminal ACKs, file replacement and bounded crash recovery. Compiling END, ACK, identity and unlink mutations reached behavioral REDs with exact restoration. A mixed-source END control was rejected and replaced by isolated protected-source cases.

With dependencies installed, sealed fixture homes/temp, the selected native interpreter on PATH and explicit `AIFY_WRAPPER_REPO` at producer `0de08cbd1ee6faf3a484bba2fb514ed0d117ce92`, reproduce the reclamation cases through the maintained runner:

```sh
npm test -- tests/the-dashboard-plugin-reclaims-activity-v2.test.js tests/the-dashboard-plugin-recovers-reclamation.test.js tests/the-dashboard-plugin-reclamation-tail.test.js
```

The real owned Bash/CLI-observer fixture proves an observer can outlive END. An ACKed `reclaimed` warning precedes unlink; a fresh same-name callback is consumed at a higher generation. The listener here is a protocol stub, not the dashboard receiver or actual Claude/ConPTY. Injected sharing refusal is not a claim that Windows refused the fixture's unlink. Missing files before an outcome save remain ambiguous and retain capacity.

Private ignored `.check-output` retains the native receipts, failed attempts, generated inputs, source/binary hashes and controls. A successor needs its own qualification. Activity remains off; full cross-repo suites, real receiver/UI acceptance and operator activation are separate.
