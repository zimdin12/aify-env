// A dedicated lifecycle pass. Definition edits remain a separate queue.
import { LIFECYCLE_ACTIONS, validRequest } from '../../agent-lifecycle.mjs';
import { claimBatch } from './request-claim.mjs';

/**
 * The answer for a request this host cannot run (an action this aify-env predates, a malformed row), judged before
 * execute is called, so nothing has been done for it. Reported, it costs that request alone.
 */
function cannotRun(request) {
  const action = request?.action;
  const unknown = LIFECYCLE_ACTIONS.includes(action) ? ''
    : `; ${JSON.stringify(action)} is not an action this aify-env runs (${LIFECYCLE_ACTIONS.join(', ')})`;
  return { status: 'refused', outcome: `invalid lifecycle request${unknown}`, resultLifetime: null, finishedAt: new Date().toISOString() };
}

export class LifecycleSync {
  #api; #lifecycle; #machineId; #mayExecute; #plugin; #onChanged;
  state = { requestsHandled: 0, lastError: '', accepted: null };
  constructor({ api, lifecycle, machineId, mayExecute = () => true, plugin = null, onChanged = () => {} }) {
    this.#api = api; this.#lifecycle = lifecycle; this.#machineId = machineId; this.#mayExecute = mayExecute;
    this.#plugin = plugin; this.#onChanged = onChanged;
  }
  async pass(environmentId, { signal } = {}) {
    let batch;
    try {
      if (!this.#mayExecute()) return { outcome: 'detaching' };
      // THE ACTIONS THIS HOST RUNS travel with the claim, so the service hands it nothing it cannot run.
      batch = await claimBatch(() => this.#api.claimLifecycleRequests(
        environmentId, this.#machineId, [...LIFECYCLE_ACTIONS], ['automatic-start-v1'], { signal }), 'lifecycle');
      this.state.accepted = true;
      for (const request of batch.requests) {
        if (!this.#mayExecute()) return { outcome: 'detaching' };
        const callbacks = this.#plugin ? {
          buildSpec: (readingAgent, invocation) => this.#plugin.prepare(environmentId, invocation, readingAgent),
          start: (prepared, runLocked) => this.#plugin.start(environmentId, prepared, runLocked),
        } : undefined;
        // ONE REQUEST THIS HOST CANNOT RUN COSTS ITSELF, NOT THE QUEUE. execute threw for it, the throw ended the pass
        // unreported, and the service hands open requests back oldest first on every claim, so every later start, stop
        // or restart on this machine waited behind it for good (2026-10-28, a `release` reaching an older aify-env).
        // JUDGED BEFORE execute, by the rule execute validates with, so a refusal here follows no effect; judging by
        // what execute threw would refuse a request a bug failed midway through, after it started or stopped a worker.
        // execute's own throws still end the pass.
        const result = validRequest(request) ? await this.#lifecycle.execute(request, callbacks) : cannotRun(request);
        await this.#api.reportLifecycleRequest(environmentId, request.id, this.#machineId, result);
        if (result.status === 'done') this.#onChanged();
        this.state.requestsHandled++;
      }
      this.state.lastError = '';
      return { outcome: 'synced', rearm: batch.rearm };
    } catch (error) {
      if (!batch && signal?.aborted) return { outcome: 'detaching' };
      this.state.lastError = String(error?.message || error);
      if (error?.status === 404) this.state.accepted = false;
      return { outcome: 'unavailable' };
    }
  }
}
