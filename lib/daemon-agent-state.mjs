// G2b boots the state owner before readiness. Hooks, managed lifetimes and sending are later slices.
import fs from "node:fs";
import path from "node:path";
import { LifecycleJournal } from "./agent-lifecycle.mjs";
import { AgentStateHost } from "./agent-state-host.mjs";
import { DaemonResidents } from "./daemon-residents.mjs";
import { descriptorFile, writeDescriptor } from "./instance-descriptor.mjs";
import { advanceGeneration, generationFile } from "./publication-generation.mjs";
import { ProcessProbeCache } from "./process-probe.mjs";
import { RESIDENTS } from "./residents-home.mjs";

/**
 * State names survive a daemon restart; Runner.instance() remains a separate boot/handle UUID.
 * A dedicated scope survives leave/join of one Herdr invocation. A new invocation has a new scope,
 * so this does not restore resident turns across different Herdr invocations.
 */
function stateInstanceName(context) {
  return context === null ? "default" : context.scope;
}

/**
 * Compose the accepted owners. Any failed durable write throws before the caller publishes readiness.
 *
 * The host here is this daemon's MANAGED population, under its own instance. Resident records belong to the residents
 * role (lib/daemon-residents.mjs): `residents` is returned without the role, and the caller acquires it once it can
 * publish, then on every sweep. Holding it is not a condition of booting.
 */
export function bootDaemonAgentState({ aifyHome, context = null, url, pid = process.pid,
  nowMs = Date.now(), nowUs = () => Date.now() * 1000, probe = null, report = () => {} }) {
  const instance = stateInstanceName(context);
  // The journal is home-wide; a generation from ANY instance is prior boot evidence.
  // Read every artifact, not existsSync, so unreadable evidence cannot authorize first use.
  // THE RESIDENTS' GENERATION IS THE ROLE'S (B1 contract item 5): unreadable, it still counts as prior boot, and it
  // refuses the residents role alone, when the role reads it. Any other unreadable generation still refuses boot.
  const residentsGeneration = path.basename(generationFile(aifyHome, RESIDENTS));
  let priorBoot = false;
  try {
    const dir = path.join(aifyHome, "env");
    let names;
    try { names = fs.readdirSync(dir); }
    catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
    for (const name of names.filter(name => name.endsWith(".generation"))) {
      try { fs.readFileSync(path.join(dir, name), "utf8"); }
      catch (error) {
        if (name !== residentsGeneration) throw error;
        report(`agent state: ${name}: ${error.code || error.message}; the residents role is refused until it is readable`);
      }
      priorBoot = true;
    }
  } catch (error) {
    report(`agent state: ${error.message}`);
    throw error;
  }
  // A LOST OR DAMAGED JOURNAL REFUSES LIFECYCLE ACTIONS, NOT THE HOST: every other agent keeps running, each
  // lifecycle call refuses on its own, and nothing recreates the file, so lost stops are never silently forgotten.
  const journalFile = path.join(aifyHome, "agent-lifecycle.json");
  let journal = null;
  try {
    const candidate = new LifecycleJournal({ file: journalFile });
    candidate.initialize({ priorBoot }); journal = candidate;
  }
  catch (error) {
    report(`agent state: ${error.message}; lifecycle actions are refused until ${journalFile} is restored, `
      + `or reset to {"version":1,"records":{},"stops":{}} (which forgets every operator stop)`);
  }
  const generation = advanceGeneration(generationFile(aifyHome, instance), { nowMs });
  // THE OS IS ASKED IN THE BACKGROUND once boot is over: every turn event refreshes, and a blocking probe there froze
  // the daemon and its herdr panes (lib/process-probe.mjs ProcessProbeCache). An injected probe is used as given.
  const cache = probe ? null : new ProcessProbeCache();
  const asked = probe ?? ((pids, options) => cache.answers(pids, options));
  // A standalone scope is its actual bound endpoint, never the shared publisher name "default".
  // Neither a new generation nor a released listener proves the prior daemon's operations ended.
  const lifecycleOwner = { scope: context === null ? new URL(url).origin : context.scope,
    generation, pid, createdAtUs: null };
  if (journal) {
    try {
      const observed = journal.open();
      let readings = new Map();
      try {
        const answer = asked([...new Set([pid, ...observed.filter(row => row.owner).map(row => row.owner.pid)])]);
        if (answer instanceof Map) readings = answer;
      } catch { report('lifecycle: owner process probe unanswered; unproved owners stay reserved'); }
      const birth = readings.get(pid);
      if (birth?.alive === true && Number.isSafeInteger(birth.createdAtUs) && birth.createdAtUs > 0)
        lifecycleOwner.createdAtUs = birth.createdAtUs;
      journal.settleObsolete({ owner: lifecycleOwner, observed, readings });
    } catch (error) { report(`lifecycle recovery: ${error.message}; unproved reservations stay reserved`); }
  }
  const host = new AgentStateHost({ aifyHome, instance, probe: asked, nowUs, population: "managed" });
  for (const problem of host.boot().problems) report(`agent state: ${problem}`);
  const residents = new DaemonResidents({ aifyHome, url, pid, probe: asked, nowUs, report });
  if (cache) {
    cache.onUpdate = () => {
      try { host.refresh(); residents.refresh(); } catch (error) { report(`agent state: ${error.message}`); }
    };
    cache.serve();
  }
  writeDescriptor(descriptorFile(aifyHome, instance), { url, instance, pid, startedAt: new Date(nowMs).toISOString() });
  return { host, instance, generation, residents, lifecycleOwner: Object.freeze(lifecycleOwner) };
}
