# Segment reclamation qualification

Native Windows, 2026-10-25. Activity remains disabled by default. This is a consumer implementation receipt, not activation or a real-dashboard/browser qualification.

## Sources and results

- Consumer starting point: `ea5324760222fbefa9c9cd21cd140fb3fd0b27be`.
- Released checkpoint lock: `4cfa11c766f49c1ecc375247400603d1b90cdb45`, carried locally as `3f325e3b307a3b1c5612dd7922515d8f0060fe6b`. Its transaction implementation is unchanged; the overlapping state edits add reclamation validation and the generation floor.
- Approved wrapper runtime: `0de08cbd1ee6faf3a484bba2fb514ed0d117ce92`. No wrapper source was changed here.
- The existing Koffi 3.3.3 dependency and `@koromix/koffi-win32-x64` load in this clone. All 92 dependency files match the released lock checkout. No package metadata changed.

| Native worker | Test files | Tests | Passed | Failed / cancelled / skipped / todo | Native exit |
| --- | ---: | ---: | ---: | --- | ---: |
| Node 22.20.0 | 13 | 157 | 157 | 0 / 0 / 0 / 0 | 0 |
| Node 26.7.0 | 13 | 157 | 157 | 0 / 0 / 0 / 0 | 0 |

The selection is the dashboard plugin's `*activity*.test.js` and `*reclamation*.test.js` files. Every run enters through `npm test` and the maintained temporary-root runner. This is not the entire env suite. Worker executable/version bindings, explicit source hashes before and after, source archives, wrapper runtime hashes, native dependency hashes, executed controller bytes and raw logs are retained privately under `.check-output/activity-6/sealed-delivery-{22,26}`.

## Behavioral evidence

PASSES IN TESTS:

- Seventeen sequential ended incarnations, with a real producer limit of one session, admit all seventeen sources. Each raw segment and checkpoint slot is physically gone before the next admission. Generations do not restart when slots are recycled.
- Fully ACKed live, null, unknown and unbound historical incarnations remain retained. Typed unknown process evidence refuses reclamation. Ordinary drained reads do not publish a checkpoint.
- A terminal `reclaimed` gap survives retry/reopen. Missing gap ACKs, transport failure and terminal-gap 409 do not authorize unlink. A conflicting terminal ID is replaced without replacing its `reclaimed` meaning.
- Appended suffixes, same-byte inode replacement, fresh same-name files, marker obligations and obsolete terminal generations retain their own delivery/identity obligations. Lease ancestors containing `.jsonl` cannot redirect marker lookup.
- Real consumer subprocess exits exercise six boundaries: before ACK save, before marker unlink, after marker unlink, after marker-outcome save, after raw unlink and after raw-outcome save. Saved outcomes resume. Missing files before an outcome save remain ambiguous and retain a bounded slot instead of claiming successful own retirement.
- An injected `EBUSY` sharing refusal exercises later-tick retry without repeated idle checkpoint writes. Actual Windows sharing refusal was not observed in the async-observer fixture.

PROVEN in owned native fixtures, not actual Claude/ConPTY:

The approved CLI observer is paused after its actual `O_APPEND` descriptor opens, immediately before its actual `fs.writeSync`. Its owned Bash lifetime exits, the real `AgentStateHost` records END, and the observer remains alive. The production plugin ships and ACKs `reclaimed` before removing the segment. On both runtimes, unlink succeeded while that observer was paused. Its late open-inode write therefore has the declared possibly-incomplete tail gap. A subsequent real CLI callback reopens the same deterministic filename, and the plugin delivers the new frame with a higher generation rather than skipping it with the retired cursor. The HTTP listener is a protocol stub, not the dashboard receiver.

Each governing runtime arm records 36 helper birth/exit pairs with no unmatched pair. The separately captured Bash owner and paused observer both have real OS birth evidence and confirmed exits before fixture teardown. Generated observer/crash inputs are preserved; before/after hashes agree.

## RED controls

All controls compile and run through maintained npm tests on both native runtimes.

- The untouched original consumer tests fail at the missing terminal `reclaimed` assertion. Retention is the healthy control, not credited as a new bug.
- Four compiling mutations cover skipped physical unlink, bypassed END, forged terminal ACK and omitted file identity. All eight runtime/mutation rows fail at the intended behavioral assertions. `composed-guard-mutations/restoration.json` records byte-exact restoration.
- Substituting the exact consumer blob from the starting commit into the otherwise composed candidate makes the real async-observer test fail at its missing terminal-tail assertion on both runtimes. Restoring the candidate byte-for-byte passes that same test on both. These are labeled consumer-substitution controls, not whole-base executions.
- Additional REDs found obsolete persisted terminal generations and marker lookup redirected by a `.jsonl` ancestor. Both corrected cases are in the final passing selection.

Earlier failed apparatus attempts are retained. The first run exposed fixture teardown ordering, then suffered a transport timeout without a complete native receipt. It is not credited as a completed RED campaign or an exact-PID cleanup receipt. Corrected runs register owned-child cleanup before root teardown and retain birth/exit ledgers. Earlier source bindings are not relabeled as later ones.

## Sandbox lifecycle replay

The existing plugin factory now forwards `shared.agents` to `ActivityShipper` and then to `ActivityConsumer`. It expects the production synchronous `rawIdentity(agentId)` port. Only an answer with `unknown: false`, `conflict: false` and a matching current `{ agentId, instance, lifetime, pid }` can bind a source witness. `instance` must match `source.instanceId`; `lifetime` must match `source.incarnation`. If `createdAtUs` or `harness` is supplied, it must agree with the fresh process birth or source runtime. A missing current record or a promise is not proof of END.

A sandbox can use the maintained objects without importing or executing `bin/aify-env.mjs`:

```js
import { AgentStateHost } from './lib/agent-state-host.mjs';
import { createAgentLifecyclePorts } from './lib/daemon-agent-lifecycle.mjs';
import { probeProcesses } from './lib/process-probe.mjs';
import { createDashboardPlugin } from './lib/plugins/aify-dashboard/index.mjs';

const stateHost = new AgentStateHost({
  aifyHome: ownedStateHome, instance, population: 'managed',
  probe: probeProcesses, nowUs: () => Date.now() * 1000,
});
const agents = createAgentLifecyclePorts({
  aifyHome: ownedLifecycleHome, machineId, stateHost,
  runner: {}, definitions: {}, installed: [],
});
// After actual owned child creation, not a synthetic PID or an assumed launch:
stateHost.startManaged({ agentId, lifetime, instance, pid: ownedChild.pid, handle });
const plugin = createDashboardPlugin({ ...sandboxShared, agents });
```

The empty runner/definition inputs above are sandbox-only placeholders for unused lifecycle effects. Identity comes from the actual `AgentStateHost`; the reclamation consumer calls the maintained fresh process probe, not those placeholders. The sandbox must have WindowsPowerShell in its native PATH and must seal all homes, temp locations and inherited agent/credential namespaces before importing fixtures.

Keep the owned lifetime alive through the plugin's initial event batch so its real birth witness is persisted. Then observe that exact child's exit before calling `stateHost.endManaged(lifetime)`. A later existing plugin tick sends and ACKs the terminal gap; a subsequent tick rechecks and unlinks. The maintained replay is `tests/the-dashboard-plugin-reclamation-tail.test.js`; its helpers are tracked under `tests/data/activity-reclamation-*`. `tests/_activity-reclamation-fixture.mjs` shows the same real lifecycle-port composition for focused tests. No new generic host port is required. Historical lifetimes never witnessed while current remain unknown and are not reclaimed.

## State integration and limits

`activity-state.mjs` keeps the released `ActivityOperationLock` transaction body. New optional v2 fields are root `generationFloor`, source `witness`, source `lossIdentity`, and source `retirement`. The witness contains agent, instance, lifetime, PID and process birth. Retirement contains `id`, `generation`, `ackGeneration`, `phase` and `marker`; phases are `pending`, `acked`, `marker-removed`, and `raw-removed`. The terminal generation must equal the staged generation, or be exactly one below the current generation after ACK. Existing byte/source caps remain unchanged.

The consumer lock is not writer exclusion. Unknown historical lifetimes, a live incarnation exhausting its session allowance, and crashes between an unlink and its outcome save can still retain capacity. Root `uncertain` is never cleared. Linux/WSL process evidence, POSIX locking, power-loss durability, actual Claude/ConPTY and final real-dashboard/browser composition are not qualified here. The existing composed proof must be replayed separately against the final consumer and dashboard warning implementation.
