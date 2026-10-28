// The `claude-login` row: whether the operator's claude login still has a way back, and how long is left.
//
// MOVED HERE FROM `aify-comms doctor` in 0.9.7 (plan D11: each doctor checks its own tier). The login is
// a credential on THIS HOST that the harnesses this tier starts depend on; no service is asked.
//
// WHY THIS EXISTS. Every claude-code agent on this host authenticates with one OAuth grant in
// `~/.claude/.credentials.json`. When it runs out, 21 agents stop working at once -- and nothing
// watched it. aify-comms' `usage-collector.js` already reads that exact file for the quota pool, so the gap was
// never access to the data; it was that nobody asked it the one question with a deadline attached.
//
// MEASURED 2026-09-03 16:36 UTC, which is why this was written: the task list recorded "claude login
// expires ~2026-09-05" and the file said the access token expired at 23:09 THAT NIGHT and the
// refresh token at 11:57 the next morning. Roughly two days optimistic, in the direction where being
// wrong means a fleet that stops overnight with the operator asleep.
//
// THE ACCESS TOKEN EXPIRING IS ROUTINE AND MUST NOT ALARM. It is short-lived and refreshed silently
// while the refresh token is valid -- an hourly check that went red every hour would be switched off
// within a day, and then the real deadline would pass unwatched too. Only the REFRESH token's window
// requires a human, so only that one decides the verdict. The access token's age is reported as
// context, never as a verdict.
//
// BOTH HALVES OF THAT WERE A HYPOTHESIS WHEN THIS WAS WRITTEN. They were WATCHED HAPPEN on
// 2026-09-03/04, on this host, across readings taken every few minutes from 18:40 to 23:57 UTC:
//
//   access  2026-09-03T23:09:47.365Z  ->  2026-09-04T07:04:49.396Z   renewed, +7.9h, no human
//   refresh 2026-09-04T11:57:46.365Z  ->  2026-09-04T11:57:46.396Z   NOT extended
//
// So the access token does renew itself, and a renewal does NOT push the refresh deadline out. The
// milliseconds are what make the second half evidence rather than an absence: the field was
// REWRITTEN (.365 -> .396) while its value stayed put, which separates "no refresh has happened yet"
// from "a refresh happened and did not extend it". Every reading before the renewal showed both
// stamps identical, so the pair is a real before/after.
//
// THAT IS WHY THIS ROW IS WORTH HAVING. The deadline is absolute from the moment of login: nothing
// the fleet does moves it, so there is no self-healing to wait for and no signal other than this one.
//
// IT NEVER READS THE TOKENS. Only the two expiry stamps beside them. A health check that handles a
// credential is a credential in one more place, and this one is called by a tool whose whole output
// is meant to be pasted into a report.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fromVerdict } from "./health.mjs";

/** Under this much refresh-token life, a human has to log in before it lapses. */
export const CLAUDE_REFRESH_WARN_HOURS = 24;

export const CLAUDE_LOGIN_OK = "ok";
export const CLAUDE_LOGIN_EXPIRING = "expiring";
export const CLAUDE_LOGIN_EXPIRED = "expired";
export const CLAUDE_LOGIN_UNKNOWN = "unknown";

/**
 * Classify a credentials payload, without touching what is in it beyond two timestamps.
 *
 * FOUR STATES, NOT A BOOLEAN, for the same reason aify-comms' `spawn-claimer.mjs` gives: an
 * absent file and an expired grant are different facts, and collapsing them makes one of the two
 * read as the other. UNKNOWN here means this host has no claude login recorded at all -- which on a
 * machine running codex or hermes agents is perfectly normal and must not read as broken.
 *
 * @param {unknown} creds parsed `~/.claude/.credentials.json`
 * @param {number} now epoch ms
 */
export function claudeLoginStateAt(creds, now) {
  const oauth = creds && typeof creds === "object" ? creds.claudeAiOauth : null;
  if (!oauth || typeof oauth !== "object") return { state: CLAUDE_LOGIN_UNKNOWN, detail: "" };

  const refreshAt = Number(oauth.refreshTokenExpiresAt);
  const accessAt = Number(oauth.expiresAt);
  // A STAMP THAT IS NOT A NUMBER IS NOT A DEADLINE. Reporting "expired" for an unparseable value
  // would send an operator to re-authenticate a login that may be perfectly healthy.
  if (!Number.isFinite(refreshAt) || refreshAt <= 0) return { state: CLAUDE_LOGIN_UNKNOWN, detail: "" };

  const refreshHours = (refreshAt - now) / 3_600_000;
  const accessHours = Number.isFinite(accessAt) ? (accessAt - now) / 3_600_000 : null;
  // CONTEXT, NOT A VERDICT: an expired access token beside a healthy refresh token is the ordinary
  // state between two calls, so it is reported and never counted.
  const access = accessHours === null
    ? ""
    : accessHours < 0
      ? " The short-lived access token has lapsed and refreshes on next use, which is normal."
      : ` The access token has ${accessHours.toFixed(1)}h left and renews itself.`;

  if (refreshHours <= 0) {
    return {
      state: CLAUDE_LOGIN_EXPIRED,
      detail: `the claude login has EXPIRED (${Math.abs(refreshHours).toFixed(1)}h ago). `
        + `Every claude-code agent on this host needs it: run \`claude\` once and log in.`,
    };
  }
  if (refreshHours < CLAUDE_REFRESH_WARN_HOURS) {
    return {
      state: CLAUDE_LOGIN_EXPIRING,
      detail: `the claude login lapses in ${refreshHours.toFixed(1)}h and cannot renew itself past `
        + `that. Log in before then, or every claude-code agent stops at once.${access}`,
    };
  }
  return {
    state: CLAUDE_LOGIN_OK,
    detail: `the claude login is good for ${Math.floor(refreshHours)}h.${access}`,
  };
}

/** Where claude keeps it. Named once; aify-comms' `usage-collector.js` reads the same path for the quota pool. */
export function claudeCredentialsPath(home = homedir()) {
  return join(home, ".claude", ".credentials.json");
}

/** Where claude keeps its own settings, the first-run setup among them. */
export function claudeConfigPath(home = homedir()) {
  return join(home, ".claude.json");
}

/**
 * Whether claude's first-run setup was completed on this host: true, false, or null when its config exists
 * but cannot be read as JSON (the `claude-trust-roots` row reports that one).
 *
 * WATCHED, 2026-10-28, Claude Code 2.1.312 in two throwaway containers: with no `~/.claude.json`, and with
 * one that claude itself wrote on a first start that went no further, every start opens on "Choose the text
 * style" and waits there; with `hasCompletedOnboarding: true` it goes on. A managed agent's claude on a host
 * nobody set up waits on that screen with nobody to answer it (docs/evidence/2026-10-28-work-pc-rehearsal).
 */
function claudeSetupCompleted(readFile, home) {
  let text;
  try {
    text = String(readFile(claudeConfigPath(home), "utf8"));
  } catch (error) {
    return error?.code === "ENOENT" ? false : null;
  }
  try {
    return JSON.parse(text)?.hasCompletedOnboarding === true;
  } catch {
    return null;
  }
}

/**
 * The ids of the claude agents defined on this host, from a `DefinitionStore.list()` answer, or null when that
 * answer is missing, or is partial and names none. PURE.
 */
export function claudeAgentIds(listed) {
  if (!Array.isArray(listed?.definitions)) return null;
  const ids = listed.definitions.filter((reading) => reading?.agent?.harness === "claude").map((reading) => reading.id);
  if (ids.length) return ids;
  return listed.unreadable?.length || listed.conflict || listed.enumerationFailed ? null : [];
}

//: The variables claude logs in with when they are set, instead of the credentials file.
const CLAUDE_LOGIN_ENV = Object.freeze(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
const SET_UP_FIX = "Run `claude` once by hand in a terminal on this host: choose a theme, then log in.";

/** Why this host needs claude: the agents defined here, and the launcher it offers the services. */
function whyClaude(ids, launcher) {
  const named = ids?.length > 3 ? `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more` : ids?.join(", ");
  return [
    ids?.length && `${ids.length} claude agent(s) are defined here (${named})`,
    launcher === true && "claude-aify is installed, so this host offers claude agents to its services",
  ].filter(Boolean).join(", and ");
}

/**
 * The `claude-login` row.
 *
 * WHETHER A MISSING LOGIN IS A FAILURE DEPENDS ON WHAT THIS HOST RUNS. A host running only codex or hermes
 * agents has no claude login and is not broken; failing there would teach an operator that this row is noise,
 * so it passes with code `skipped`. A host with claude agents defined and claude never set up is the opposite:
 * every one of them waits on claude's first screen (2026-10-28 rehearsal, where this row passed with "no
 * claude credentials on this host, so there is no login to age"). Claude is wanted here when `claudeAgents`,
 * the ids `claudeAgentIds` read from this host's definitions, names any, or when `claudeLauncher` says
 * claude-aify is on PATH: aify-env then advertises claude, and a service routes claude spawns here (the
 * rehearsal's agent was one of those, with no definition). Neither, with the definitions unread, is unanswered.
 *
 * @param {{readFile?: Function, now?: () => number, home?: string, claudeAgents?: string[]|null,
 *   claudeLauncher?: boolean, platform?: string, env?: object}} [deps]
 * @returns {object} one doctor row (lib/health.mjs), carrying the verdict's `code`
 */
export function claudeLoginCheck({
  readFile = readFileSync, now = Date.now, home, claudeAgents = null, claudeLauncher = false, platform = process.platform,
  env = process.env,
} = {}) {
  const id = "claude-login";
  const why = whyClaude(claudeAgents, claudeLauncher);
  if (why && claudeSetupCompleted(readFile, home) === false) {
    return fromVerdict(id, {
      code: "not-set-up",
      detail: `Claude Code's first-run setup was never completed on this host, and ${why}: `
        + "each claude started here waits on its first screen, which asks for a theme",
      fix: SET_UP_FIX,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(String(readFile(claudeCredentialsPath(home), "utf8")));
  } catch {
    const fromEnv = CLAUDE_LOGIN_ENV.find((name) => env?.[name]);
    if (fromEnv) return fromVerdict(id, { ok: true, code: "skipped", detail: `claude logs in with ${fromEnv} from the environment, so there is no login file to age` });
    if (!why && claudeAgents === null) {
      return fromVerdict(id, { code: "unknown-agents", detail: "no claude credentials on this host, and its agent definitions could not be read, so whether claude agents need a login is unknown" });
    }
    if (!why) return fromVerdict(id, { ok: true, code: "skipped", detail: "no claude agents are defined or offered here and there are no claude credentials, so there is no login to age" });
    if (platform === "darwin") {
      return fromVerdict(id, { code: "unknown-keychain", detail: `${why}; on macOS claude keeps its login in the Keychain, which this doctor does not read` });
    }
    return fromVerdict(id, {
      code: "no-login",
      detail: `no claude login on this host, and ${why}: no claude agent can work here until someone logs in`,
      fix: SET_UP_FIX,
    });
  }
  const verdict = claudeLoginStateAt(parsed, now());
  if (verdict.state === CLAUDE_LOGIN_UNKNOWN) {
    return fromVerdict(id, { ok: true, code: "skipped", detail: "claude credentials carry no readable expiry, so nothing was measured" });
  }
  const ok = verdict.state === CLAUDE_LOGIN_OK;
  return fromVerdict(id, {
    ok, code: verdict.state, detail: verdict.detail, fix: ok ? "" : "Run `claude` in a terminal and complete the login.",
  });
}
