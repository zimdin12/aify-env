# In-flight spawn custody

Runner owns a piped child as soon as its synchronous spawner returns, including the interval before Node's `spawn` event. This private custody is not successful admission: public `list()`, managed registration, durable success rows and HTTP 201 still follow `PipedSpawn.ready()` and a usable positive PID.

## Existing shutdown owner

`createShutdown` uses `Runner.shutdownView()` when supplied. That internal list/stop view includes pending children as well as admitted registry entries. It does not change the HTTP list or health payload.

`InFlightSpawns` keeps actual returned child handles in a private map. After confirmed admission, each pending alias delegates to the existing Runner stop witness. An already captured shutdown snapshot still reaches that same witness. The alias retires when admitted child/group custody is released; a root close alone does not retire unverified group custody.

A pending stop uses `RunnerStop`, not a separate killer. Waiting for handoff consumes its existing stop-exit budget. A successful handoff receives only the remaining budget. If the budget expires before handoff, the stop attempts only the captured child's `kill()` method and returns `execution-unknown`; it does not guess a process tree from a PID or claim death. Private custody remains until the spawn outcome or admitted owner resolves it. Late admission still enters the captured stop path, even after the original wait expired. A concurrent spawn error settles pending custody without a success row.

## Final admission assertion

`Runner.start(spec, { admitSpawn, assertOpen })` optionally accepts a synchronous final assertion. Runner invokes it after checkpoint loading, the start gate and the final working-folder admission await. There is no await from this assertion through spawn to private handle capture. A thenable result is refused, not awaited into permission to spawn. Throwing the existing `StartAdmissionRefusal` preserves typed admission refusal.

The caller owns the meaning of cancellation. This prerequisite exposes the seam; daemon boot cancellation wires it separately. Held ownership recovery is not cancellation and must retain its existing fresh-request recheck path.

## Tests and limits

`npm test -- tests/in-flight-spawn-custody.test.js` exercises the real Runner and shutdown owner with injected process effects and native-effect tripwires. It covers the ready-await snapshot, public admission boundary, retained snapshot handoff, spawn errors, timeout retention, repeated stop, late handoff, cancellation at each await and thenable refusal. Existing spawn-outcome, process-group, stream and shutdown tests remain regression gates.

This is not native platform qualification or live activation. An unconfirmed result is deliberately not a tree-cleanup certificate. Full platform acceptance remains the authorized release-candidate gate.
