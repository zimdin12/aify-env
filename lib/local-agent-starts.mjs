import { randomUUID } from 'node:crypto';

function readable(listed) {
  return typeof listed?.storeId === 'string' && Boolean(listed.storeId) && !listed.conflict
    && !listed.enumerationFailed && !listed.unreadable?.length && Array.isArray(listed.definitions);
}

function refusal(reading, raw) {
  if (!reading?.agent || reading.problems?.length !== 0) return 'no valid local definition';
  if (reading.agent.mode !== 'managed') return 'defined as resident: it is started through its launcher';
  if (raw?.conflict !== false || raw?.unknown !== false) return 'local lifetime is not known';
  if (raw.current !== null) return 'the agent already has a worker';
  return '';
}

/** HTTP and the daemon TUI choose the same route. A remote answer is never retried locally. */
export function agentStartPort(remote, local) {
  return typeof remote?.start === 'function' ? remote : local ?? null;
}

/** Bind local explicit Start to a store revision and the observed cold lifetime. */
export function localAgentStarts({ definitions, identity, lifecycle, machineId }) {
  const read = async () => {
    try { return await definitions.list(); } catch { return null; }
  };
  return {
    async list() {
      const listed = await read();
      if (!readable(listed)) return { agents: [], skipped: [], problem: 'local definitions are not readable' };
      const agents = [], skipped = [];
      for (const reading of listed.definitions) {
        const problem = refusal(reading, await identity(reading.id));
        const row = { id: reading.id, name: reading.agent?.name ?? reading.id, role: reading.agent?.role ?? '',
          harness: reading.agent?.harness ?? '', status: 'available', herdrSpace: reading.agent?.herdrSpace ?? true };
        if (problem) skipped.push({ ...row, reason: problem });
        else agents.push(row);
      }
      return { agents, skipped, problem: '' };
    },
    async start(agentId) {
      const report = (started, problem) => ({ started, agentId, sessionId: '', problem });
      const listed = await read();
      if (!readable(listed)) return report(false, 'local definitions are not readable');
      const reading = listed.definitions.find(row => row.id === agentId);
      const problem = refusal(reading, await identity(agentId));
      if (problem) return report(false, problem);
      const result = await lifecycle.execute({ id: `local-${randomUUID()}`, agentId, machineId,
        storeId: listed.storeId, expectedIncarnation: reading.incarnation, expectedRevision: reading.revision,
        expectedLifetime: null, action: 'start', requestedBy: 'operator' });
      return result?.status === 'done' && result.outcome === 'start' && result.resultLifetime
        ? report(true, '') : report(false, result?.outcome || 'local launch did not prove a new lifetime');
    },
  };
}
