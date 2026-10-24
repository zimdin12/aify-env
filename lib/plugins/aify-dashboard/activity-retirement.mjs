// Consumer-owned END witnesses and physical effects. No writer exclusion is claimed.
import fs from 'node:fs';
import path from 'node:path';
import { probeProcesses } from '../../process-probe.mjs';
import { verifyLifetime } from '../../resident-lifetimes.mjs';
import { regularFile, readSegment } from './activity-state.mjs';
import { digest, fileIdentity, validWitness } from './activity-raw.mjs';
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export class ActivityRetirement {
  constructor({ agents, probe = probeProcesses }) { this.agents = agents; this.probe = probe; }
  observe(source) {
    if (!uuid(source.incarnation) || typeof this.agents?.rawIdentity !== 'function') return null;
    const raw = this.agents.rawIdentity(source.agentId), current = raw?.current;
    if (raw?.unknown !== false || raw?.conflict !== false || !current
      || current.agentId !== source.agentId || current.instance !== source.instanceId
      || current.lifetime !== source.incarnation || !Number.isSafeInteger(current.pid) || current.pid <= 0
      || (current.harness !== undefined && current.harness !== source.runtime)) return null;
    const fresh = this.probe([current.pid]).get(current.pid);
    if (fresh?.alive !== true || !Number.isSafeInteger(fresh.createdAtUs) || fresh.createdAtUs <= 0
      || (current.createdAtUs !== undefined && current.createdAtUs !== fresh.createdAtUs)) return null;
    return { agentId: source.agentId, instance: source.instanceId, lifetime: source.incarnation,
      pid: current.pid, createdAtUs: fresh.createdAtUs };
  }
  ended(s) {
    if (!validWitness(s.witness, s.source)) return false;
    return verifyLifetime(s.witness, this.probe([s.witness.pid]).get(s.witness.pid), s.witness.createdAtUs).verified === 'no';
  }
  marker(file) {
    const stat = regularFile(file.replace(/\.jsonl$/, '.loss'));
    if (!stat) return null;
    if (stat.size !== 1 || fs.readFileSync(file.replace(/\.jsonl$/, '.loss'), 'utf8') !== '?') throw Error('invalid-marker');
    return fileIdentity(stat);
  }
  unchanged(s, file) {
    const stat = regularFile(file);
    return stat && fileIdentity(stat) === s.identity && stat.size === s.offset && s.checked === s.offset
      && digest(readSegment(file, stat)) === s.prefix;
  }
  reclaim(state, name, storage, directory) {
    const s = state.sources[name], r = s.retirement, file = path.join(directory, name);
    if (!r || r.phase === 'pending') return false;
    if (r.phase === 'raw-removed') {
      // This phase exists only after our unlink returned and its outcome was durably recorded.
      if (regularFile(file) || this.marker(file)) return false;
      delete state.sources[name]; storage.save(state); return true;
    }
    // Missing after an intent is ambiguous, not evidence that our unlink succeeded before a crash.
    if (!regularFile(file)) throw Error('retirement-outcome-unknown');
    if (s.stage || r.ackGeneration !== r.generation || !this.unchanged(s, file) || !this.ended(s)) return false;
    const marker = this.marker(file);
    if (r.phase === 'acked' && r.marker !== null && marker === null) throw Error('retirement-marker-outcome-unknown');
    if (r.phase === 'acked' ? marker !== r.marker : marker !== null) return false;
    if (marker && (!s.latches.includes('loss') || s.lossIdentity !== marker)) return false;
    if (r.phase === 'acked' && marker) {
      if (!this.remove(file.replace(/\.jsonl$/, '.loss'))) return false;
      r.phase = 'marker-removed'; storage.save(state);
    }
    // The in-flight hook tail can race these last checks. Its terminal gap has already committed.
    if (!this.unchanged(s, file) || !this.ended(s) || this.marker(file) !== null) return false;
    if (!this.remove(file)) return false;
    r.phase = 'raw-removed'; storage.save(state);
    delete state.sources[name]; storage.save(state); return true;
  }
  remove(file) {
    try { fs.unlinkSync(file); return true; }
    catch (e) { if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return false; throw e; }
  }
}
