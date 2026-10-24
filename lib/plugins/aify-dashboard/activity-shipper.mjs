// One optional source batch on the plugin's existing tick, with no independent watcher or retry loop.
import { randomUUID } from 'node:crypto';
import { ActivityConsumer } from './activity-consumer.mjs';
import { activityDeclared, activityBatch, activityDecision } from './activity-protocol.mjs';
import { activityGrant, wrapperActivity, activityDirectories } from './activity-source.mjs';

export class ActivityShipper {
  #api;
  #config;
  #endpoint;
  #agents;
  #declared;
  #next = 0;
  #passes = 0;
  #active = false;
  #problems = [];

  constructor({ api, config, endpoint, agents }) { this.#api = api; this.#config = config; this.#endpoint = endpoint; this.#agents = agents; }

  state() {
    return this.#active ? { passes: this.#passes, coverage: 'unknown', problems: [...this.#problems] } : null;
  }

  async pass({ signal } = {}) {
    if (signal?.aborted) return;
    let problem = 'configuration could not be read';
    try {
      const { config } = this.#config();
      this.#active = config?.activity !== undefined && config.activity?.enabled !== false;
      const grant = activityGrant(config);
      this.#problems = [];
      if (!grant) return;
      problem = 'service capability was not declared';
      if (this.#declared === undefined) {
        const spec = await this.#api.serviceSpec({ signal });
        if (signal?.aborted) return;
        this.#declared = activityDeclared(spec);
      }
      if (!this.#declared) throw new Error('capability');
      problem = 'wrapper execution grant or policy could not be admitted';
      const { validRecord, safeAgentId, policy } = await wrapperActivity(grant);
      if (signal?.aborted) return;
      problem = 'lease directory could not be admitted';
      const roots = activityDirectories(grant.leaseDirectory, safeAgentId);
      if (!roots.length) return;
      const root = roots[this.#next++ % roots.length];
      const spool = new ActivityConsumer({ ...root, endpoint: this.#endpoint, validRecord, policy, agents: this.#agents });
      problem = 'spool read was refused';
      const read = spool.read();
      if (!read.ok) throw new Error('storage');
      if (!read.token || !read.source) {
        if (read.uncertain) throw new Error('unknown-coverage');
        return;
      }

      const batch = activityBatch(read, randomUUID());
      problem = 'delivery was not committed';
      const response = await this.#api.fileActivity(batch, { signal });
      // A transport may deliver a late successful body even after cancellation. It authorizes no write.
      if (signal?.aborted) return;
      const decision = activityDecision(response, batch);
      if (!decision) throw new Error('invalid-receipt');
      const result = decision.kind === 'resolve' ? spool.resolve(read.token, decision)
        : spool.ack(read.token, { committed: true, eventIds: read.token.eventIds, gapIds: read.token.gapIds });
      if (!result.ok) throw new Error('storage');
    } catch {
      if (!signal?.aborted) this.#problems = [`file activity: ${problem}; coverage unknown`];
    } finally {
      this.#passes++;
    }
  }
}
