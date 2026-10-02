// A resident agent is a lifetime record its launcher writes, judged against the OS (0.9 plan P0 C4).
//
// PURE. The launcher writes `~/.aify/residents/<agentId>.<lifetime>.json`; the host reads the files and asks the OS
// about each pid (lib/process-identity.mjs). These functions say what the answers mean:
//   parseLifetimeRecord  a file's text and name, into a record or the reason it is not one
//   verifyLifetime       a record plus the OS's answer: yes, no, or unknown
//   currentLifetimes     the verdicts of every instance's records, per agent: this instance's current one, a conflict,
//                        or none
//
// TIME UNITS: microseconds since the epoch, as integers, everywhere here. The launcher stamps `writtenAtUs` from
// `$EPOCHREALTIME` (microseconds); Windows reports creation in 100 ns ticks, which the probe floors to microseconds.
// Comparing at a millisecond floor would make a pid born just after the write look equal to it (review of
// 6e79bcac, N3); at microseconds an equality is still possible, and it is `unknown`, never `yes`.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIFETIME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HARNESSES = new Set(["claude", "codex", "hermes"]);
/** 2001-09-09 in microseconds: a smaller `writtenAtUs` is a time in milliseconds, which would read every pid as reused. */
const MIN_EPOCH_MICROS = 1e15;

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
  if (!Number.isSafeInteger(writtenAtUs) || writtenAtUs < MIN_EPOCH_MICROS) return { ok: false, problem: `${fileName}: writtenAtUs` };
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
  if (probe?.alive !== true || !Number.isSafeInteger(created) || created <= 0) return { verified: "unknown", reason: "probe-unanswered", pin: pinnedCreatedAtUs };
  if (pinnedCreatedAtUs !== null) {
    return created === pinnedCreatedAtUs
      ? { verified: "yes", reason: "pinned", pin: pinnedCreatedAtUs }
      : { verified: "no", reason: "reused", pin: null };
  }
  if (created > record.writtenAtUs) return { verified: "no", reason: "reused", pin: null };
  if (created === record.writtenAtUs) return { verified: "unknown", reason: "equal-to-write", pin: null };
  if (typeof probe.commandLine !== "string") return { verified: "unknown", reason: "probe-unanswered", pin: null };
  // A WHOLE ARGUMENT, in one spelling. Windows reports a Git Bash launcher as `bash.exe /c/Users/.../claude-aify`,
  // so `C:/` against `/c/` read a live launcher as a stranger, while a substring match adopted `claude-aify-old`.
  // A pid created before the record that does not carry the launcher is more likely a spelling this does not fold
  // than another process, so it is unknown: kept, never adopted, and removed when the pid is gone.
  const launcher = pathKey(record.launcher);
  if (!windowsArguments(probe.commandLine).some((argument) => pathKey(argument) === launcher)) {
    return { verified: "unknown", reason: "launcher-unmatched", pin: null };
  }
  return { verified: "yes", reason: "adopted", pin: created };
}

/** A path as one key: one slash, one case, and Git Bash's `/c/` as `c:/`. */
function pathKey(value) {
  return String(value).split(String.fromCharCode(92)).join("/").toLowerCase().replace(/^\/([a-z])\//, "$1:/");
}

/**
 * A command line's arguments as Windows itself splits them (the C runtime's rules, which node's own argv follows),
 * checked against the native split of a table of lines in the test. Quotes toggle WITHIN one argument, so
 * `"C:/x/claude-aify"-old` is the single argument `C:/x/claude-aify-old`, which a quote-delimited regex read as the
 * launcher (review of e57d770, L1). Inside quotes `""` is a literal quote; backslashes escape a quote only when they
 * run straight into one, and halve when they do. The program name, argument 0, has simpler rules of its own, but a
 * launcher is a script and never argument 0.
 */
export function windowsArguments(commandLine) {
  const line = String(commandLine);
  const args = [];
  let i = 0;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i += 1;
    if (i >= line.length) return args;
    let arg = "";
    let quoted = false;
    while (i < line.length) {
      const c = line[i];
      if (c === "\\") {
        let run = 0;
        while (line[i + run] === "\\") run += 1;
        if (line[i + run] === '"') {
          arg += "\\".repeat(Math.floor(run / 2));
          i += run;
          if (run % 2 === 1) { arg += '"'; i += 1; }
        } else {
          arg += "\\".repeat(run);
          i += run;
        }
        continue;
      }
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { arg += '"'; i += 2; continue; }
        quoted = !quoted;
        i += 1;
        continue;
      }
      if ((c === " " || c === "\t") && !quoted) break;
      arg += c;
      i += 1;
    }
    args.push(arg);
  }
}

/**
 * Every instance's verdicts, per agent, as `instance` sees them. Records are read across instances because one
 * agent verified under two of them is a conflict (C4), never resolved by picking. Only a lifetime of this instance
 * can be current here, and only a lifetime of this instance is listed as unknown.
 *
 * @param {Array<{record: object, verified: string}>} verdicts
 * @param {{instance: string}} context
 * @returns {Map<string, {current: object|null, conflict: object[]|null, unknown: object[]}>}
 */
export function currentLifetimes(verdicts, { instance }) {
  if (typeof instance !== "string" || !instance) throw new TypeError("currentLifetimes needs the instance reading");
  const byAgent = new Map();
  for (const { record, verified } of verdicts) {
    const entry = byAgent.get(record.agentId) ?? { yes: new Map(), unknown: new Map() };
    if (verified === "yes") entry.yes.set(record.lifetime, record);
    if (verified === "unknown" && record.instance === instance) entry.unknown.set(record.lifetime, record);
    byAgent.set(record.agentId, entry);
  }
  const out = new Map();
  for (const [agentId, entry] of byAgent) {
    const yes = [...entry.yes.values()];
    const unknown = [...entry.unknown.values()];
    if (yes.length > 1) out.set(agentId, { current: null, conflict: yes, unknown });
    else out.set(agentId, { current: yes[0]?.instance === instance ? yes[0] : null, conflict: null, unknown });
  }
  return out;
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
