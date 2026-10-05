// G2b boots the state owner before readiness. Hooks, managed lifetimes and sending are later slices.
import { AgentStateHost } from "./agent-state-host.mjs";
import { descriptorFile, writeDescriptor } from "./instance-descriptor.mjs";
import { advanceGeneration, generationFile } from "./publication-generation.mjs";
import { probeProcesses } from "./process-probe.mjs";

/**
 * State names survive a daemon restart; Runner.instance() remains a separate boot/handle UUID.
 * A dedicated scope survives leave/join of one Herdr invocation. A new invocation has a new scope,
 * so this does not restore resident turns across different Herdr invocations.
 */
function stateInstanceName(context) {
  return context === null ? "default" : context.scope;
}

/** Compose the accepted owners. Any failed durable write throws before the caller publishes readiness. */
export function bootDaemonAgentState({ aifyHome, context = null, url, pid = process.pid,
  nowMs = Date.now(), nowUs = () => Date.now() * 1000, probe = probeProcesses, report = () => {} }) {
  const instance = stateInstanceName(context);
  const generation = advanceGeneration(generationFile(aifyHome, instance), { nowMs });
  const host = new AgentStateHost({ aifyHome, instance, probe, nowUs });
  for (const problem of host.boot().problems) report(`agent state: ${problem}`);
  writeDescriptor(descriptorFile(aifyHome, instance), { url, instance, pid, startedAt: new Date(nowMs).toISOString() });
  return { host, instance, generation };
}
