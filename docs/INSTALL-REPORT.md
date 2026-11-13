# Guided install completion report

The wrapper owns connect admission and produces `--report-file` JSON. Env reads that data, never the service-shaped prose on stdout.

The existing record carries `result`, `service`, `installed` and `pending`. Pending rows have the existing wrapper report shape `{name, reason}`. The name is the MCP identity, not the artifact ID. The producer always writes a pending array, including an empty one. Env's installed-wrapper compatibility check requires that projection so an older linked wrapper cannot silently lose it.

`connectRecorded` retains well-formed pending rows with string names and reasons. `InstallChain` adds the service name and carries them in `report.pendingEntries`, separately from `report.pending`. The latter remains the selected-client queue and can make a no-prompt run fail when a CLI is absent.

Pending MCP entries alone remain nonfatal. Connect success still proceeds through render and assets. The final line names each pending service/MCP identity and reason, then gives one action to take after the artifacts become available. Strings are JSON-escaped so a reason containing a newline cannot forge a separate completion line. If some other phase fails, the status stays failed and any pending entries already collected still appear in the qualified final line.

With no pending entries, ordinary success still prints `chain: complete`. A failed connect still stops later phases. This change adds no artifact refusal, rollback or retry mechanism. Missing or unreadable record files retain the existing empty-install receipt behavior; this is not a new guarantee of record delivery.

## Verification

With explicit peer checkout variables and the repository's normal private test environment:

```sh
env -u AIFY_AGENT_ID -u AIFY_AGENT_LEASE -u AIFY_ENV_INSTANCE -u AIFY_LIFETIME \
  npm test -- tests/pending-connect-report.test.js tests/the-install-chain-runs-its-phases-in-order.test.js
```

The focused test composes the real wrapper record projection, the real host reader and the real chain. Its process/install ports are injected, so it proves this reporting boundary, not live service onboarding. Controls preserve ordinary empty-pending success, missing-client refusal and connect-failure nonmutation. The wrapper's own tests exercise real connect through record-file production.
