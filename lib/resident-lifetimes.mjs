// A resident agent is a lifetime record its launcher writes, judged against the OS (0.9 plan P0 C4).
//
// PURE. The launcher writes `~/.aify/residents/<agentId>.<lifetime>.json`; the host reads the files and asks the OS
// about each pid (lib/process-identity.mjs). These functions say what the answers mean:
//   parseLifetimeRecord  a file's text and name, into a record or the reason it is not one
//   verifyLifetime       a record plus the OS's answer: yes, no, or unknown
//   currentLifetimes     the verdicts of one instance's records, per agent: current, conflict, or none
//   restoreTurn          a turn stored before a restart, by its lifetime's verdict now (C3)
//
// TIME UNITS: microseconds since the epoch, as integers, everywhere here. The launcher stamps `writtenAtUs` from
// `$EPOCHREALTIME` (microseconds); Windows reports creation in 100 ns ticks, which the probe floors to microseconds.
// Comparing at a millisecond floor would make a pid born just after the write look equal to it (review of
// 6e79bcac, N3); at microseconds an equality is still possible, and it is `unknown`, never `yes`.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIFETIME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HARNESSES = new Set(["claude", "codex", "hermes"]);

/**
 * @returns {{ok: true, record: object} | {ok: false, problem: string}}
 */
export function parseLifetimeRecord(text, fileName) {
  let body;
  try { body = JSON.parse(String(text ?? "")); } catch { return { ok: false, problem: `${fileName}: not JSON` }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, problem: `${fileName}: not an object` };
  const { agentId, lifetime, instance, harness, pid, launcher, writtenAtUs, herdrPane } = body;
  if (typeof agentId !== "string" || !ID.test(agentId)) return { ok: false, problem: `${fileName}: agentId` };
  if (typeof lifetime !== "string" || !LIFETIME.test(lifetime)) return { ok: false, problem: `${fileName}: lifetime` };
  if (fileName !== `${agentId}.${lifetime}.json`) return { ok: false, problem: `${fileName}: name does not match its agentId and lifetime` };
  if (typeof instance !== "string" || !ID.test(instance)) return { ok: false, problem: `${fileName}: instance` };
  if (!HARNESSES.has(harness)) return { ok: false, problem: `${fileName}: harness` };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, problem: `${fileName}: pid` };
  if (typeof launcher !== "string" || !launcher.trim()) return { ok: false, problem: `${fileName}: launcher` };
  if (!Number.isSafeInteger(writtenAtUs) || writtenAtUs <= 0) return { ok: false, problem: `${fileName}: writtenAtUs` };
  if (herdrPane !== undefined && typeof herdrPane !== "string") return { ok: false, problem: `${fileName}: herdrPane` };
  return { ok: true, record: { agentId, lifetime, instance, harness, pid, launcher, writtenAtUs, ...(herdrPane ? { herdrPane } : {}) } };
}

/**
 * The OS's answer for a record's pid, as the probe gives it: `alive` false when the pid is gone, and null fields when
 * the probe could not answer (access denied, timeout, no probe on this platform).
 *
 * @param {object} record
 * @param {{alive: boolean|null, createdAtUs: number|null, commandLine: string|null}} probe
 * @param {number|null} pinnedCreatedAtUs  the creation time pinned at adoption, or null before it
 * @returns {{verified: "yes"|"no"|"unknown", reason: string, pin: number|null}}
 */
export function verifyLifetime(record, probe, pinnedCreatedAtUs = null) {
  if (probe?.alive === false) return { verified: "no", reason: "gone", pin: null };
  const created = probe?.createdAtUs;
  if (probe?.alive !== true || !Number.isSafeInteger(created)) return { verified: "unknown", reason: "probe-unanswered", pin: pinnedCreatedAtUs };
  if (pinnedCreatedAtUs !== null) {
    return created === pinnedCreatedAtUs
      ? { verified: "yes", reason: "pinned", pin: pinnedCreatedAtUs }
      : { verified: "no", reason: "reused", pin: null };
  }
  if (created > record.writtenAtUs) return { verified: "no", reason: "reused", pin: null };
  if (created === record.writtenAtUs) return { verified: "unknown", reason: "equal-to-write", pin: null };
  if (typeof probe.commandLine !== "string") return { verified: "unknown", reason: "probe-unanswered", pin: null };
  const flat = (value) => value.split(String.fromCharCode(92)).join("/").toLowerCase();
  if (!flat(probe.commandLine).includes(flat(record.launcher))) return { verified: "no", reason: "sibling", pin: null };
  return { verified: "yes", reason: "adopted", pin: created };
}

/**
 * One instance's verdicts, per agent. Two `yes` lifetimes for one agent is a conflict, never resolved by picking.
 *
 * @param {Array<{record: object, verified: string}>} verdicts
 * @returns {Map<string, {current: object|null, conflict: object[]|null, unknown: object[]}>}
 */
export function currentLifetimes(verdicts) {
  const byAgent = new Map();
  for (const { record, verified } of verdicts) {
    const entry = byAgent.get(record.agentId) ?? { yes: [], unknown: [] };
    if (verified === "yes") entry.yes.push(record);
    if (verified === "unknown") entry.unknown.push(record);
    byAgent.set(record.agentId, entry);
  }
  const out = new Map();
  for (const [agentId, { yes, unknown }] of byAgent) {
    out.set(agentId, yes.length > 1
      ? { current: null, conflict: yes, unknown }
      : { current: yes[0] ?? null, conflict: null, unknown });
  }
  return out;
}

/**
 * A turn stored before a restart, by what its lifetime is now (C3's table).
 *
 * @param {{lifetime: string, startedAtUs: number, lastEventAtUs: number}} turn
 * @param {"yes"|"no"|"unknown"} verified
 * @returns {{keep: boolean, renewable: boolean, cause: string}}
 */
export function restoreTurn(turn, verified) {
  if (verified === "yes") return { keep: true, renewable: true, cause: "restored" };
  if (verified === "no") return { keep: false, renewable: false, cause: "lifetime-ended" };
  return { keep: true, renewable: false, cause: "identity-unknown" };
}

/**
 * An ISO timestamp with up to 7 fractional digits (PowerShell's "o" format) as epoch microseconds, floored. `Date.parse`
 * keeps milliseconds only, which is the precision N3 ruled out. Null for anything else.
 */
export function isoToEpochMicros(text) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(seconds)) return null;
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
  return seconds * 1000 + Number(fraction);
}
