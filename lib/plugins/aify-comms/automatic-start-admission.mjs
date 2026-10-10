// Classify only from a complete local reading. The host port owns the definition lock and stop slot.
export function automaticStartAdmission({ definitions, agents }) {
  return async (launch, produce, complete) => {
    if (typeof definitions?.list !== 'function') return { refused: 'automatic-definition-reading-unavailable' };
    const reading = await definitions.list();
    if (!reading || typeof reading.storeId !== 'string' || !reading.storeId
      || !Array.isArray(reading.definitions) || !Array.isArray(reading.unreadable)
      || reading.unreadable.length || reading.conflict !== null || reading.enumerationFailed !== null
      || reading.definitions.some(row => !row || typeof row.id !== 'string' || !Array.isArray(row.problems))) {
      return { refused: 'automatic-definition-reading-incomplete' };
    }
    const matching = reading.definitions.filter(row => row.id === launch?.agentId);
    if (!matching.length && !launch?.definition) {
      const produced = await produce();
      if (typeof complete === 'function') await complete(produced);
      return { produced };
    }
    if (matching.length !== 1 || matching[0].problems.length || !launch?.definition) {
      return { refused: 'automatic-definition-unavailable' };
    }
    if (typeof agents?.admitColdStart !== 'function' || typeof agents?.rawIdentity !== 'function') {
      return { refused: 'automatic-lifecycle-capability-unavailable' };
    }
    const identity = await agents.rawIdentity(launch.agentId);
    if (!identity || identity.unknown !== false || identity.conflict !== false || identity.current !== null) {
      return { refused: 'automatic-agent-not-cold' };
    }
    // Pass the exact supplied binding. Never wrap this call in definitions.admitStart.
    return agents.admitColdStart(launch, produce, complete);
  };
}
