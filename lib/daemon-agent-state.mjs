// G2b boots the state owner before readiness. Hooks, managed lifetimes and sending are later slices.
import fs from "node:fs";
import path from "node:path";
import { LifecycleJournal } from "./agent-lifecycle.mjs";
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
  // The journal is home-wide; a generation from ANY instance is prior boot evidence.
  // Read every artifact, not existsSync, so unreadable evidence cannot authorize first use.
  let priorBoot = false;
  try {
    const dir = path.join(aifyHome, "env");
    let names;
    try { names = fs.readdirSync(dir); }
    catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
    for (const name of names.filter(name => name.endsWith(".generation"))) {
      fs.readFileSync(path.join(dir, name), "utf8");
      priorBoot = true;
    }
  } catch (error) {
    report(`agent state: ${error.message}`);
    throw error;
  }
  // A LOST OR DAMAGED JOURNAL REFUSES LIFECYCLE ACTIONS, NOT THE HOST: every other agent keeps running, each
  // lifecycle call refuses on its own, and nothing recreates the file, so lost stops are never silently forgotten.
  const journalFile = path.join(aifyHome, "agent-lifecycle.json");
  try { new LifecycleJournal({ file: journalFile }).initialize({ priorBoot }); }
  catch (error) {
    report(`agent state: ${error.message}; lifecycle actions are refused until ${journalFile} is restored, `
      + `or reset to {"version":1,"records":{},"stops":{}} (which forgets every operator stop)`);
  }
  const generation = advanceGeneration(generationFile(aifyHome, instance), { nowMs });
  const host = new AgentStateHost({ aifyHome, instance, probe, nowUs });
  for (const problem of host.boot().problems) report(`agent state: ${problem}`);
  writeDescriptor(descriptorFile(aifyHome, instance), { url, instance, pid, startedAt: new Date(nowMs).toISOString() });
  return { host, instance, generation };
}
