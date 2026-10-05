// Retry attach discovery, not input, resize or lifecycle operations.
// The deadline bounds an unanswered environment, never total time beside a live one.
import { setTimeout as sleepFor } from 'node:timers/promises';
import { looksLikeEnvironment } from './environment-checks.mjs';

class AttachRefusal extends Error {}

export async function waitForAttachProcesses({ endpoint, fetchImpl = fetch,
  now = Date.now, sleep = sleepFor, unansweredMs = 15000, retryMs = 500,
  requestTimeoutMs = 5000, healthTimeoutMs = 2000, onRetry = () => {} } = {}) {
  let deadline = now() + unansweredMs;
  let health = {};
  let announced = false;
  async function probeHealth() {
    try {
      const response = await fetchImpl(`${endpoint}/health`, { signal: AbortSignal.timeout(healthTimeoutMs) });
      const body = await response.json();
      health = response.ok ? body : {};
      if (looksLikeEnvironment({ ok: response.ok, status: response.status, body })
        && Number.isInteger(body.pid) && body.pid > 0
        && typeof body.instance === 'string' && body.instance) {
        deadline = now() + unansweredMs;
      }
    } catch { health = {}; }
  }
  await probeHealth();
  for (;;) {
    try {
      const response = await fetchImpl(`${endpoint}/processes`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok) {
        const reason = `process listing answered ${response.status}`;
        if (response.status === 429 || response.status >= 500) throw new Error(reason);
        throw new AttachRefusal(reason);
      }
      let body;
      try { body = await response.json(); }
      catch (error) {
        if (error instanceof SyntaxError) throw new AttachRefusal('process listing returned invalid JSON');
        throw error;
      }
      if (!Array.isArray(body?.processes)) throw new AttachRefusal('process listing returned no processes array');
      return { health, processes: body.processes };
    } catch (error) {
      if (error instanceof AttachRefusal) throw error;
      // Recheck AFTER a slow listing. A live answer renews the deadline even when
      // the just-failed request took longer than the unconfirmed interval.
      await probeHealth();
      if (now() >= deadline) throw error;
      if (!announced) { onRetry(error); announced = true; }
      await sleep(Math.min(retryMs, Math.max(0, deadline - now())));
    }
  }
}
