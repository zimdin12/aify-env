// One bounded consumer checkpoint per admitted agent/receiver, outside the producer root.
import fs from 'node:fs';
import path from 'node:path';
import { existingDirectory } from './activity-source.mjs';
import { digest, integer, validClock, sourceName, fileIdentity } from './activity-raw.mjs';
const MAX_STATE_BYTES = 256 * 1024;
export function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-file');
    return stat;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function stateDirectory(directory, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('receiver');
  return path.join(path.dirname(directory), '.aify-dashboard-activity-v2', digest(endpoint));
}
export function readSegment(file, stat) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fileIdentity(fs.fstatSync(fd)) !== fileIdentity(stat)) throw new Error('segment-race');
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('segment-race');
    return bytes;
  } finally { fs.closeSync(fd); }
}
export class ActivityState {
  constructor({ directory, endpoint }) { this.directory = stateDirectory(directory, endpoint); }
  transaction(action) {
    // Validate all existing ancestors before creating anything. Missing raw roots are never initialized.
    let ancestor = this.directory;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    existingDirectory(ancestor);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    existingDirectory(this.directory);
    const lock = path.join(this.directory, 'lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const stat = regularFile(lock);
      if (!stat || stat.size > 64) throw new Error('state-busy');
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('state-busy');
      try { process.kill(pid, 0); throw new Error('state-busy'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      // Cooperating readers only. Reused/live PIDs refuse; no elapsed-time lock breaking.
      fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx', 0o600);
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return action(this.load());
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  load() {
    const file = path.join(this.directory, 'state.json'), stat = regularFile(file);
    if (!stat) return { version: 2, sources: {} };
    if (stat.size > MAX_STATE_BYTES) throw new Error('state-limit');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.version !== 2 || !state.sources || Array.isArray(state.sources)
      || Object.keys(state.sources).length > 16) throw new Error('state-invalid');
    for (const [name, s] of Object.entries(state.sources)) {
      if (!/^session-[a-f0-9]{64}\.jsonl$/.test(name) || sourceName(s.source) !== name
        || !integer(s.offset) || !integer(s.checked) || s.checked < s.offset || !integer(s.invalidThrough)
        || !Number.isSafeInteger(s.generation) || s.generation < 1 || !validClock(s.clock)
        || typeof s.identity !== 'string' || !/^[a-f0-9]{64}$/.test(s.prefix)
        || !Array.isArray(s.latches) || s.latches.some(v => !['loss', 'uncertain'].includes(v))) throw new Error('state-invalid');
      if (s.stage && (!Array.isArray(s.stage.items) || s.stage.items.length > 128
        || !Array.isArray(s.stage.gaps) || s.stage.gaps.length > 32
        || !integer(s.stage.end) || s.stage.end < s.offset || s.stage.end > s.checked)) throw new Error('state-invalid');
    }
    return state;
  }
  save(state) {
    const bytes = Buffer.from(JSON.stringify(state));
    if (bytes.length > MAX_STATE_BYTES) throw new Error('state-limit');
    const file = path.join(this.directory, 'state.json'), temp = path.join(this.directory, 'state.tmp');
    regularFile(file); regularFile(temp);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
}
