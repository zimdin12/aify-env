// Owned native lifetimes, real host lifecycle ports, real producer. HTTP is a protocol stub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixture, until } from './_activity-fixture.mjs';
import { AgentStateHost } from '../lib/agent-state-host.mjs';
import { createAgentLifecyclePorts } from '../lib/daemon-agent-lifecycle.mjs';
import { probeProcesses } from '../lib/process-probe.mjs';
import { sourceName } from '../lib/plugins/aify-dashboard/activity-raw.mjs';
export const receipt = r => ({ committed: true, eventIds: r.token.eventIds, gapIds: r.token.gapIds });
export const commit = (c, r) => { assert.ok(r.token, 'a real batch exists'); assert.equal(c.ack(r.token, receipt(r)).ok, true); };
export async function reclamationFixture(t, options = {}) {
  const cleanup = [];
  t.after(async () => { for (const end of cleanup) await end(); });
  const f = await fixture(t, { records: 0, ...options });
  const instance = 'reclamation-instance';
  // One OS answer for the host and the plugin's agents port, as the daemon gives both its ProcessProbeCache. A test of
  // what the activity read asks the OS passes one (options.processes); the rest answer at once, synchronously.
  const processes = options.processes ?? probeProcesses;
  const host = new AgentStateHost({ aifyHome: path.join(f.root, 'state-host'), instance, population: 'managed',
    probe: processes, nowUs: () => Date.now() * 1000 });
  const agents = createAgentLifecyclePorts({ aifyHome: path.join(f.root, 'lifecycle'), machineId: 'fixture',
    stateHost: host, runner: {}, definitions: {}, installed: [], processes });
  const { activityEvent } = await import(pathToFileURL(path.join(process.env.AIFY_WRAPPER_REPO, 'lib/file-activity.mjs')));
  const record = (lifetime, sessionId = randomUUID()) => activityEvent({
    input: { session_id: sessionId, cwd: 'C:/fixture/project', tool_name: 'Read', tool_input: { file_path: 'owned.txt' } },
    identity: { machineId: 'win32:fixture', instanceId: instance, agentId: 'agent-1', incarnation: lifetime },
    outcome: 'success', observedAt: Date.now() });
  // A smaller checkpoint slot cap when the test asks for one (ActivityConsumer's `slots`), so freeing slots is proven
  // with a few incarnations rather than seventeen.
  const open = (extra = {}) => f.open({ agents, ...(options.slots ? { slots: options.slots } : {}), ...extra });
  async function owner() {
    const release = path.join(f.root, randomUUID() + '.release'), lifetime = randomUUID();
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(AIFY_|HERDR_|COMMS_|AGENT_STATE_)/i.test(k) || ['NODE_OPTIONS', 'HERMES_SESSION_ID'].includes(k.toUpperCase())) delete env[k];
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'data/activity-reclamation-owner.mjs'), release], { env, stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const live = probeProcesses([child.pid, process.pid]);
    assert.equal(live.get(process.pid)?.alive, true, 'same-run OS probe positive control');
    assert.equal(live.get(child.pid)?.alive, true, 'owned helper is alive');
    assert.ok(Number.isSafeInteger(live.get(child.pid).createdAtUs));
    const ledger = process.env.ACTIVITY_EVIDENCE_DIR && path.join(process.env.ACTIVITY_EVIDENCE_DIR, 'owned-processes.jsonl');
    const evidence = event => { if (ledger) { fs.mkdirSync(path.dirname(ledger), { recursive: true });
      fs.appendFileSync(ledger, JSON.stringify({ ...event, pid: child.pid, createdAtUs: live.get(child.pid).createdAtUs,
        executable: process.execPath, version: process.version, release }) + '\n'); } };
    evidence({ action: 'spawned', selfProbeAlive: live.get(process.pid).alive });
    // Stamped after the child exists, as ManagedLifetimes.register stamps a managed record.
    host.startManaged({ agentId: 'agent-1', lifetime, instance, pid: child.pid, handle: lifetime, writtenAtUs: Date.now() * 1000 });
    let finished = false;
    const end = async () => {
      if (finished) return;
      fs.writeFileSync(release, '1');
      const result = await exited; assert.equal(result.code, 0); assert.equal(result.signal, null);
      assert.equal(probeProcesses([child.pid, process.pid]).get(child.pid)?.alive, false, 'exact owned helper is gone');
      assert.equal(host.endManaged(lifetime).ended, true); finished = true;
      evidence({ action: 'exited', nativeExit: result.code, gone: true });
    };
    cleanup.push(async () => { if (!finished) await end(); });
    return { lifetime, child, end, createdAtUs: live.get(child.pid).createdAtUs };
  }
  const append = r => { assert.equal(f.producer().append(r).ok, true, 'real producer admitted frame'); return path.join(f.directory, sourceName(r.source)); };
  async function pass() {
    const p = f.plugin({ shared: { agents } }); await p.start(f.host);
    try { await until(() => (p.state().activity?.passes ?? 0) >= 1, 'production plugin tick completes', 25000); }
    finally { await p.stop(); }
    return p;
  }
  return { ...f, open, owner, record, append, agents, stateHost: host, pass };
}
