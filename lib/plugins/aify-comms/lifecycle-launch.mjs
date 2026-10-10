// Service transport and terminal output belong to this plugin; the host owns admission and receipts.
import { HARNESS_RUNTIME } from '../../agent-definition-requests.mjs';
import { prepareTerminalLaunch, carryTerminal } from './terminal-controls.mjs';

export class LifecycleLaunch {
  #deps;
  #prepared = new WeakSet();
  constructor(deps) { this.#deps = deps; }
  async prepare(environmentId, request, readingAgent) {
    const d = this.#deps;
    const answer = await d.api.prepareLifecycleLaunch(environmentId, request.id, d.machineId);
    const launch = answer?.launch;
    const listing = await d.definitions.list();
    const reading = listing?.definitions?.find(row => row.id === request.agentId);
    if (answer?.ok !== true || !launch || request.machineId !== d.machineId
      || listing.conflict || listing.enumerationFailed || listing.unreadable?.length
      || listing.storeId !== request.storeId || !reading?.agent || reading.problems?.length !== 0
      || reading.incarnation !== request.expectedIncarnation || reading.revision !== request.expectedRevision
      || JSON.stringify(reading.agent) !== JSON.stringify(readingAgent)
      || readingAgent.mode !== 'managed' || launch.agentId !== request.agentId
      || !HARNESS_RUNTIME[readingAgent.harness] || launch.runtime !== HARNESS_RUNTIME[readingAgent.harness]
      || launch.definition?.storeId !== request.storeId
      || launch.definition?.incarnation !== request.expectedIncarnation
      || launch.definition?.revision !== request.expectedRevision) throw Error('lifecycle-launch-binding-moved');
    if (typeof launch.terminalId !== 'string' || !launch.terminalId.trim()) throw Error('lifecycle-launch-terminal-unavailable');
    if (!Array.isArray(launch.argv) || !launch.argv.length
      || typeof launch.argv[0] !== 'string' || !launch.argv[0].trim()
      || launch.argv.some(part => typeof part !== 'string' || part.includes('\0'))) throw Error('lifecycle-launch-argv-unavailable');
    const prepared = prepareTerminalLaunch({ ...d, launch, terminalId: launch.terminalId, cwdRoots: await d.cwdRoots() });
    if (prepared.detail) throw Error(prepared.detail);
    const result = { environmentId, request: structuredClone(request), launch: structuredClone(launch), spec: prepared.built.spec };
    this.#prepared.add(result);
    return result;
  }
  async start(environmentId, prepared, runLocked) {
    const d = this.#deps;
    if (!this.#prepared.has(prepared) || prepared.environmentId !== environmentId) throw Error('lifecycle-launch-not-prepared');
    this.#prepared.delete(prepared); // No second effect, even if subscription or reporting fails.
    const { request, launch, spec } = prepared;
    const terminalId = launch.terminalId;
    if (typeof runLocked !== 'function') throw Error('lifecycle-admission-unavailable');
    const admitted = await runLocked(() => d.processes.start({ ...spec, agentId: request.agentId, definition: launch.definition, id: terminalId,
      cols: Number(launch.cols) || 0, rows: Number(launch.rows) || 0, space: launch.herdrSpace !== false }));
    if (admitted?.refused) return admitted;
    const started = admitted?.produced;
    const handle = String(started?.id ?? '');
    if (!handle) throw Error('lifecycle-start-handle-unavailable');
    d.handles.remember(terminalId, handle, request.agentId);
    const release = carryTerminal({ ...d, terminalId, handle, runtime: launch.runtime, log: d.log ?? (() => {}) });
    if (typeof release !== 'function') throw Error('lifecycle-start-subscription-unavailable');
    d.handles.carriedBy(terminalId, release);
    const raw = await d.identity(request.agentId);
    const current = raw?.current;
    if (raw?.conflict !== false || raw?.unknown !== false || typeof current?.lifetime !== 'string' || !current.lifetime
      || current.lifetime === request.expectedLifetime || current.agentId !== request.agentId
      || current.handle !== handle || !Number.isSafeInteger(started?.pid) || started.pid <= 0
      || current.pid !== started.pid) throw Error('lifecycle-start-lifetime-unavailable');
    const attachment = { terminalId, handle, processId: started.pid, lifetime: current.lifetime,
      ...(Number(started.cols) > 0 ? { cols: Number(started.cols) } : {}),
      ...(Number(started.rows) > 0 ? { rows: Number(started.rows) } : {}) };
    const receipt = await d.api.reportLifecycleAttachment(environmentId, request.id, d.machineId, attachment);
    if (receipt?.ok !== true || !receipt.attachment
      || Object.entries(attachment).some(([key, value]) => receipt.attachment[key] !== value)) throw Error('lifecycle-attachment-refused');
    return started;
  }
}
