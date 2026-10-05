# G2a: daemon service-plugin assembly

This slice follows G1 at env `694f7b3931a34cf4d7bbc50e0c300794c6a975f4`. The role/scope handoff is comms message `1791194105933-54bcb728`; the manager accepted this first slice in `1791194488460-6dae7bab`.

`lib/daemon-plugin-bootstrap.mjs` now assembles the existing PluginHost and PluginProcesses, invokes the existing service starter and owns the registry-following closure. The daemon still supplies the shared-context factory and its live credential, advertisement, definition, grant and harness callbacks. It still invokes plugin startup only after listening and orphan reaping, inside its existing failure boundary. The helper is internal, not a new package export or a changed plugin interface.

The shared object has the same fields and expressions. Its construction and the registry read remain after host construction. The follower still coalesces an in-flight beat and logs the existing follow reports. An extracted async helper introduces an additional promise-resolution boundary; exact global microtask scheduling equivalence is not claimed.

The existing dedicated-instance, pane-opener and production-picker source readers follow the new call/helper ownership. The picker test still executes the production daemon call with real factory, starter, plugin and route code, replacing only external IO and timers. A new direct test covers startup ordering/reporting, per-call credential and advertisement reads, both pane hooks, and coalesced registry following.

This is not G2 completion, C10 migration acceptance, AgentStateHost runtime wiring, descriptor/generation publication, P-1 implementation, lifecycle controls, the model delta, dashboard fields or the keyless-loop repair. Those are separate slices. No live environment restart or live test agent is part of this slice.

Review execution receipts are recorded separately against the staged tree. Full-suite results, skips and failures must be reported as observed, not inferred from focused checks.
