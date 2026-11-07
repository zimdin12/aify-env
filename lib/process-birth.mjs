// Birth witnesses, not liveness guesses. Recovery observations never upgrade a saved PID-only record.
import { linuxStartTokenFrom, sameLinuxStartToken } from './linux-process-token.mjs';
const WINDOWS_FIELDS = Object.keys({ version: 1, platform: 'win32', pid: 0, createdAtUs: 0 });

export function observedBirth(pid, answer, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || answer?.alive !== true) return null;
  if (platform === 'linux') return answer.platform === 'linux' ? linuxStartTokenFrom(answer.startToken, pid) : null;
  if (platform !== 'win32' || !Number.isSafeInteger(answer.createdAtUs) || answer.createdAtUs <= 0) return null;
  return { version: 1, platform: 'win32', pid, createdAtUs: answer.createdAtUs };
}

export function validBirth(value, pid = value?.pid) {
  if (value?.platform === 'linux') return linuxStartTokenFrom(value, pid);
  if (value?.version !== 1 || value?.platform !== 'win32' || value?.pid !== pid
      || !Number.isSafeInteger(pid) || pid <= 0 || Object.keys(value).length !== WINDOWS_FIELDS.length
      || !WINDOWS_FIELDS.every(field => Object.hasOwn(value, field))
      || !Number.isSafeInteger(value.createdAtUs) || value.createdAtUs <= 0) return null;
  return { version: 1, platform: 'win32', pid, createdAtUs: value.createdAtUs };
}

export function sameBirth(left, right, pid = left?.pid) {
  const a = validBirth(left, pid), b = validBirth(right, pid);
  if (!a || !b || a.platform !== b.platform) return false;
  return a.platform === 'linux' ? sameLinuxStartToken(a, b, pid) : a.createdAtUs === b.createdAtUs;
}

/** An unanswered/malformed live identity is unknown, not evidence that the original exited. */
export function originalBirthState(birth, answer, platform = process.platform) {
  const known = validBirth(birth);
  if (!known || known.platform !== platform) return 'unknown';
  if (answer?.alive === false) return 'gone';
  const observed = observedBirth(known.pid, answer, platform);
  return observed ? (sameBirth(known, observed) ? 'present' : 'gone') : 'unknown';
}

/** GetProcessTimes reports 100 ns units since 1601; the shared probe reports Unix microseconds. */
export function heldBirthMatches(birth, held) {
  const known = validBirth(birth);
  if (known?.platform !== 'win32' || typeof held?.createdAt100ns !== 'string'
      || !/^[1-9][0-9]*$/.test(held.createdAt100ns)) return false;
  try { return BigInt(held.createdAt100ns) / 10n - 11644473600000000n === BigInt(known.createdAtUs); }
  catch { return false; }
}
