// What an agent's session actually runs, read when aify-comms asks (0.9.1 3B).
//
// ON DEMAND. aify-comms asks when a person looks at an agent and holds this claim open until then, so nothing here
// runs on a timer: an idle host spends one held request, and a look costs one file read, or one stat when the file
// has not changed since the last look (`ModelReader`).
//
// THE SERVICE NAMES THE SESSION: it sends each agent's runtime, workspace and native session handle, which it already
// holds. This side only reads the harness's own record of that session.

import { ModelReader } from "../../actual-model.mjs";
import { HARNESS_OF_RUNTIME } from "./agent-import-records.mjs";

//: How long to wait before asking again when the service answers that it offers no model reads (an older service).
export const NOT_OFFERED_RETRY_MS = 60_000;

export class ModelReads {
  #api; #machineId; #reader;
  state = { readsAnswered: 0, lastError: "" };

  constructor({ api, machineId, reader = new ModelReader() }) {
    this.#api = api; this.#machineId = machineId; this.#reader = reader;
  }

  /**
   * One held claim, and an answer for each read it returns. Resolves `{outcome}`; never throws.
   * `live` is asked before the claim, before each read and before each answer: a plugin that detached while the claim
   * was held takes and answers nothing more (review of 0.9.1, ENV-1).
   */
  async pass(environmentId, { live = () => true } = {}) {
    try {
      if (!live()) return { outcome: "detaching" };
      const answer = await this.#api.claimModelReads(environmentId, this.#machineId);
      if (!Array.isArray(answer?.reads)) throw Error("invalid model-read claim");
      for (const read of answer.reads) {
        if (!live()) return { outcome: "detaching" };
        const results = await this.#results(read.agents);
        if (!live()) return { outcome: "detaching" };
        await this.#api.answerModelRead(environmentId, read.readId, this.#machineId, results);
        this.state.readsAnswered++;
      }
      this.state.lastError = "";
      return { outcome: answer.reads.length ? "answered" : "idle" };
    } catch (error) {
      this.state.lastError = String(error?.message || error);
      return { outcome: error?.status === 404 ? "not-offered" : "unreachable" };
    }
  }

  async #results(agents) {
    const results = {};
    for (const agent of Array.isArray(agents) ? agents : []) {
      const harness = HARNESS_OF_RUNTIME[agent?.runtime] ?? String(agent?.runtime || "an unknown runtime's");
      results[agent.agentId] = await this.#reader.read({ harness, workspace: agent.workspace, handle: agent.sessionHandle });
    }
    return results;
  }
}
