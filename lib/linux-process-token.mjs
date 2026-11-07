// Pure Linux identity format. IO belongs to the probe or the owning child's writer, never a record reader.
const FIELDS = Object.keys({ version: 1, platform: 'linux', bootId: '', pid: 0, startTicks: '' });
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PID = value => Number.isSafeInteger(value) && value > 0;

/** A valid v1 token for this recorded PID, or null. Legacy/malformed data never gains identity. */
export function linuxStartTokenFrom(value, pid) {
  if (!PID(pid) || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.length || !FIELDS.every(field => Object.hasOwn(value, field))) return null;
  const { version, platform, bootId, pid: capturedPid, startTicks } = value;
  if (version !== 1 || platform !== 'linux' || capturedPid !== pid || typeof bootId !== 'string'
    || !BOOT_ID.test(bootId) || typeof startTicks !== 'string' || !/^[0-9]+$/.test(startTicks)) return null;
  return { version, platform, bootId, pid: capturedPid, startTicks };
}

/** Decode raw procfs text without wall-clock conversion; an optional parent guard is for child capture only. */
export function linuxStartTokenFromStat(stat, bootId, pid, { parentPid } = {}) {
  if (!PID(pid) || typeof stat !== 'string' || typeof bootId !== 'string') return null;
  const first = /^([1-9][0-9]*) \(/.exec(stat), end = stat.lastIndexOf(')');
  if (!first || first[1] !== String(pid) || end < first[0].length || !/^\s/.test(stat.slice(end + 1))) return null;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  if (parentPid !== undefined && (!PID(parentPid) || fields[1] !== String(parentPid))) return null;
  return linuxStartTokenFrom({ version: 1, platform: 'linux', bootId: bootId.trim(), pid, startTicks: fields[19] }, pid);
}

/** Equality includes boot, PID and the exact raw tick string; two absent tokens are not equal identity. */
export function sameLinuxStartToken(left, right, pid) {
  const a = linuxStartTokenFrom(left, pid), b = linuxStartTokenFrom(right, pid);
  return a !== null && b !== null && a.bootId === b.bootId && a.pid === b.pid && a.startTicks === b.startTicks;
}
