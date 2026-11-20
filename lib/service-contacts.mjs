// What the view says about each registered service, from what this daemon's own channels last heard (env #30).
//
// THE VIEW SENDS A SERVICE NOTHING. It used to knock on every service's `/health` on every refresh, which made an
// open screen the biggest source of idle traffic on the host. The daemon already talks to its services: the comms
// plugin beats, the dashboard plugin waits for provider work. `/health` reports each channel's last result as
// `serviceContacts`, and this turns that report into one row per registered service. PURE: facts in, a check out.
//
// A SERVICE NOTHING CONTACTS IS SAID TO BE UNOBSERVED, never healthy and never failed: nobody asked it anything, and
// the row names the command that will (`aify-env doctor` still knocks on every service).

import { failed, passed, unanswered } from "./health.mjs";
import { serviceIdentity } from "./services.mjs";
import { relativeAge } from "./tui-parts.mjs";

const PROBE = "run `aify-env doctor` to ask it directly";

/** An endpoint as two readers compare it: no trailing slash. */
function sameEndpoint(a, b) {
  return String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "");
}

/** Epoch ms from a number or an ISO string; NaN for anything else. */
function epochMs(at) {
  if (typeof at === "number") return at;
  if (typeof at === "string" && at.trim() !== "") return Date.parse(at);
  return Number.NaN;
}

/** One channel's last result, in words: `heartbeat ok 12s ago`, `heartbeat failed 3s ago: 401 refused`. */
function contactPhrase(contact, nowMs) {
  const channel = String(contact.channel || "contact");
  const age = relativeAge(epochMs(contact.at), nowMs);
  const when = age ? ` ${age}` : "";
  return contact.ok === true
    ? `${channel} ok${when}`
    : `${channel} failed${when}: ${String(contact.error || "no reason given")}`;
}

/**
 * The row for one registered service.
 *
 * @param {object} entry           a registry entry, as `readServices` returns it
 * @param {object} health          what this daemon's `/health` said: `{answered, contacts}`; `contacts` is its
 *                                 `serviceContacts` list, or not an array when the daemon does not report one
 * @param {number} nowMs           the reference point for "how long ago"
 */
export function serviceContactCheck(entry, { answered = false, contacts = null } = {}, nowMs = Number.NaN) {
  const { name, endpoint } = serviceIdentity(entry);
  if (!answered) return unanswered(name, `no aify-env answered, so what it last heard from ${endpoint} is unknown; ${PROBE}`);
  if (!Array.isArray(contacts)) {
    return unanswered(name, `this aify-env does not report what it heard from its services; ${PROBE}`);
  }
  const heard = contacts.filter((contact) => contact && typeof contact === "object"
    && String(contact.name || "") === name && sameEndpoint(contact.endpoint, endpoint));
  if (!heard.length) return unanswered(name, `unobserved: nothing on this host contacts ${endpoint}; ${PROBE}`);
  const detail = heard.map((contact) => contactPhrase(contact, nowMs)).join("; ");
  return heard.every((contact) => contact.ok === true)
    ? passed(name, detail)
    : failed(name, detail, `See the aify-env log for ${name}; ${PROBE}.`);
}
