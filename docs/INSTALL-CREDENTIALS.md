# Installer credential readiness

The standalone `install.sh` credential step judges the selected registry (`AIFY_SERVICE_REGISTRY`, otherwise the runtime home's `.aify/services.json`). It never infers a usable key from an unpublished default-reference file. Runtime resolution remains `credentialForTarget`, including environment/file conflict and store-custody faults; diagnostic output carries typed states and convergence outcomes, never values.

## Readiness policy

- A runtime `OK` credential is ready without an authentication probe.
- Runtime `ABSENT` is not proof that a key is unnecessary. Fetch and validate the selected service's served spec without credentials. If its `credentialRef` secret explicitly has `required:false`, the service is ready without a credential.
- Otherwise use only that secret's declared verification probe, resolved by the spec owner's origin-relative route rule. Send no credential, cookies or authorization header, bound the request and refuse redirects. A 2xx response proves this deployment accepts the declared API operation without a key; 401/403 means a required credential is missing. Other statuses, transport failure or no declared probe remain unknown and fail closed. Public health is not an authentication probe.
- Invalid, missing-declared-reference, unreadable, insecure or conflicting configured credentials remain faults. A keyless probe cannot mask them. Unreadable/malformed registry state is not an empty successful plan.
- Services without an env plugin remain outside this credential step. Readiness here is configuration/authentication readiness, not proof that a running daemon or client has adopted it.

This policy was agreed with the registration owner on 2026-11-06; it also covers the keyless fresh-install case tracked in comms #49.

## Interactive repair and ownership

Only a missing required credential is prompted for. Before requesting it, the helper explains that repair is a full service reconnect: approved artifact verification/acquisition and launcher rerender may occur. It is not a hidden credential-only operation or an assets-phase registry edit.

The existing `aify-wrapper-connect` CLI owns staging, probes, store-aware validation, locked publication and rerender. The helper supplies the selected service/endpoint, exact registry and existing install destinations, with the key only on stdin. It does not first run `credential set`, guess a default reference, add an env registry writer, approve a refused artifact automatically, or delete staged references. Exit 78 is refusal; exit 75 is unknown publication and stays non-success. A fresh report-file or exit-zero acknowledgement alone is not readiness.

After exit 0, reread the exact selected registry entry, confirm its identity/endpoint, and re-resolve its published credential through the runtime resolver before reporting ready. Preserve the exact registry entry name when invoking its owner; an owner refusal must not be bypassed by publishing a second canonicalized name. Then recompute the plan. Another unattended run must use that published state without prompting. An entry changed by somebody else or a failed/unknown publication must not become success.

All implementation and composition tests use private homes, registries, credential files and controlled endpoints. Production credential values and live registration/install/restart actions are outside this development scope.
