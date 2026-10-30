// Generic production adapters. No service submission or claims live here.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentLifecycle, LifecycleJournal } from './agent-lifecycle.mjs';
import { ResidentStarts } from './resident-starts.mjs';
import { stopAndVerify } from './verified-stop.mjs';
import { probeProcessesAsync } from './process-probe.mjs';
import { verifyLifetime } from './resident-lifetimes.mjs';
import { killTree as defaultKillTree } from './kill-tree.mjs';
import { defaultIsAlive } from './reaper.mjs';
function knownCold(raw) {
  return raw?.conflict === false && raw?.unknown === false && raw?.current === null;
}
function knownRefusal(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, "refused")
    && typeof value.refused === "string" && value.refused.trim() !== "";
}
function matchesBirth(raw, produced, agentId) {
  return raw?.conflict === false && raw?.unknown === false && raw?.current?.agentId === agentId
    && produced !== null && typeof produced === "object" && !Array.isArray(produced)
    && Object.hasOwn(produced, "id") && typeof produced.id === "string" && produced.id.trim() !== ""
    && Object.hasOwn(produced, "pid") && Number.isSafeInteger(produced.pid) && produced.pid > 0
    && !Object.hasOwn(produced, "refused") && (!Object.hasOwn(produced, "unknown") || produced.unknown === false)
    && (!Object.hasOwn(produced, "outcome") || produced.outcome !== "execution-unknown")
    && (!Object.hasOwn(produced, "status") || produced.status !== "failed")
    && raw.current.handle === produced.id && raw.current.pid === produced.pid
    && typeof raw.current.lifetime === "string" && raw.current.lifetime.trim() !== "";
}

/**
 * RESIDENT LIFECYCLE REQUIRES THE ROLE (B1 contract item 7). `residents` is this daemon's lib/daemon-residents.mjs: a
 * resident's identity comes from its host only while the role is held here, and every resident lifecycle effect runs
 * inside an operation the role admitted, asking it again immediately before each effect: the kill, the refresh after
 * it (which can remove resident records), and in AgentLifecycle the stop fact and a delete's definition removal. The
 * lifecycle admits once and hands its operation to the stop; a stop called alone admits its own. Without `residents`,
 * nothing is admitted.
 */
export function createAgentLifecyclePorts({aifyHome,owner = null,machineId,stateHost,residents = null,runner,definitions,
  installed,buildSpec = async () => { throw Error('lifecycle-launch-composition-unavailable'); },
  probe = probeProcessesAsync,isAlive = defaultIsAlive,killTree = defaultKillTree,settleMs = 1000,onStopChange,
  processes = null}) {
  const journal = new LifecycleJournal({file:path.join(aifyHome,'agent-lifecycle.json'),owner,onStopChange});
  const identity = id => residents ? residents.identity(id, stateHost) : stateHost.rawIdentity(id);
  const admitResident = () => {
    const entered = residents?.enter() ?? null;
    return entered && { host: entered.host, live: entered.op.live, done: entered.op.done };
  };
  const stopResident = async (witness, admitted) => {
    const role = admitted ?? admitResident();
    if (!role) return false;
    try {
      if (!Number.isSafeInteger(witness.createdAtUs)) return false;
      const fresh = (await probe([witness.pid])).get(witness.pid);
      if (verifyLifetime(witness,fresh,witness.createdAtUs).verified !== 'yes') return false;
      if (!role.live()) return false;
      await killTree(witness.pid);
      const deadline=Date.now()+settleMs;
      for (;;) {
        const answer=(await probe([witness.pid])).get(witness.pid);
        if (answer?.alive === false) {
          // Killed, but the role may have gone during the waits: then the refresh is not this daemon's to make.
          if (!role.live()) return false;
          role.host.refresh(); return true;
        }
        if (Date.now()>=deadline) return false;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
    } finally { if (!admitted) role.done(); }
  };
  const stop = async (witness, mode, admitted = null) => {
    if (!Number.isSafeInteger(witness?.pid) || witness.pid <= 0) return false;
    if (mode === 'resident') return stopResident(witness, admitted);
    const fresh = identity(witness.agentId);
    if (fresh.unknown || fresh.conflict || JSON.stringify(fresh.current) !== JSON.stringify(witness)) return false;
    const stopped = await stopAndVerify({list:()=>[{id:witness.handle,pid:witness.pid}],stop:()=>runner.stop(witness.handle)},witness.handle,{isAlive,settleMs});
    if (!stopped.stopped) return false;
    stateHost.endManaged(witness.lifetime);
    return true;
  };
  const lifecycle = new AgentLifecycle({journal,machineId,definitions,identity,stop,admitResident,installed,buildSpec,start:spec=>runner.start(spec)});
  const residentStarts = new ResidentStarts({ definitions, journal, residents, identity });
  const stopFacts = () => journal.stopFacts();
  const admitColdStart = async (launch, produce, complete) => {
    if (!launch?.agentId || !launch?.definition || typeof produce !== "function") return { refused: "lifecycle-definition-unavailable" };
    if (typeof complete !== "function") return { refused: "lifecycle-continuation-unavailable" };
    let request, lifetime;
    const admitted = await definitions.admitStart(launch, async () => {
      const fresh = await identity(launch.agentId);
      if (!knownCold(fresh)) return { refused: "identity-moved" };
      request = { id: `automatic-${randomUUID()}`, agentId: launch.agentId, machineId,
        storeId: launch.definition.storeId, expectedIncarnation: launch.definition.incarnation,
        expectedRevision: launch.definition.revision, expectedLifetime: null, action: "start", requestedBy: "automatic" };
      let admission;
      try { admission = journal.reserveAutomaticStart(request); }
      catch (error) { if (error?.message === "lifecycle journal missing") return { refused: error.message }; throw error; }
      if (!admission.fresh) return { refused: admission.result.outcome };
      // A throw or an unclassified answer retains the pre-effect durable unknown.
      const produced = await produce();
      const observed = await identity(launch.agentId);
      if (knownRefusal(produced) && knownCold(observed)) {
        journal.finish(request, { status: "refused", outcome: produced.refused, resultLifetime: null,
          finishedAt: new Date().toISOString() });
        return produced;
      }
      if (!matchesBirth(observed, produced, launch.agentId)) return { unknown: true };
      lifetime = observed.current.lifetime;
      return produced;
    });
    if (admitted?.refused || admitted?.produced?.refused) return { refused: admitted.refused ?? admitted.produced.refused };
    if (!lifetime) return admitted;
    // Birth exclusion is now released. The journal slot stays open through subscription and acknowledgement.
    if (await complete(admitted.produced) !== true) return { produced: admitted.produced, unknown: true };
    const current = await identity(launch.agentId);
    if (!matchesBirth(current, admitted.produced, launch.agentId) || current.current.lifetime !== lifetime)
      return { produced: admitted.produced, unknown: true };
    journal.finish(request, { status: "done", outcome: "automatic-start", resultLifetime: lifetime,
      finishedAt: new Date().toISOString() });
    return admitted;
  };
  // `processes`: the daemon's non-blocking OS answer (bootDaemonAgentState), passed through for plugins; null answers nothing.
  return {lifecycle,stopFacts,admitColdStart,stop,rawIdentity:identity,processes,
    residentStarted: (agentId, body) => residentStarts.consume(agentId, body)};
}
