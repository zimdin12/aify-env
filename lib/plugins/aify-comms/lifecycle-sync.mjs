// A dedicated lifecycle pass. Definition edits remain a separate queue.
export class LifecycleSync {
  #api; #lifecycle; #machineId; #mayExecute; #plugin;
  state = { requestsHandled: 0, lastError: '', accepted: null };
  constructor({ api, lifecycle, machineId, mayExecute = () => true, plugin = null }) {
    this.#api = api; this.#lifecycle = lifecycle; this.#machineId = machineId; this.#mayExecute = mayExecute;
    this.#plugin = plugin;
  }
  async pass(environmentId) {
    try {
      if (!this.#mayExecute()) return { outcome: 'detaching' };
      const answer = await this.#api.claimLifecycleRequests(environmentId, this.#machineId);
      this.state.accepted = true;
      if (!Array.isArray(answer?.requests)) throw Error('invalid lifecycle claim');
      for (const request of answer.requests) {
        if (!this.#mayExecute()) return { outcome: 'detaching' };
        const callbacks = this.#plugin ? {
          buildSpec: (readingAgent, invocation) => this.#plugin.prepare(environmentId, invocation, readingAgent),
          start: (prepared, runLocked) => this.#plugin.start(environmentId, prepared, runLocked),
        } : undefined;
        const result = await this.#lifecycle.execute(request, callbacks);
        await this.#api.reportLifecycleRequest(environmentId, request.id, this.#machineId, result);
        this.state.requestsHandled++;
      }
      this.state.lastError = '';
      return { outcome: 'synced' };
    } catch (error) {
      this.state.lastError = String(error?.message || error);
      if (error?.status === 404) this.state.accepted = false;
      return { outcome: 'unavailable' };
    }
  }
}
