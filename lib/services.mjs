// Which services are registered on this host, and what each says about itself.
//
// READS LESS THAN THE AUTHORITATIVE PARSER, ON PURPOSE. aify-wrapper's lib/registry.mjs validates the
// whole schema because it renders launchers from it. aify-env needs a name and an endpoint, so that is
// all it reads — and it therefore cannot develop a second opinion about fields it never looks at. Two
// parsers of one format is a drift problem; two parsers where one reads a strict subset is not.
//
// AND IT ASKS RATHER THAN INSPECTS. aify-env has no way to know whether aify-comms is well, and no
// business deciding. It knocks, and it reports what came back — including "nothing came back", which
// is its own answer and not a failure. A silent service may be uninstalled, stopped, or on a machine
// that is switched off, and none of those is evidence that it is broken.

import { credentialRefIsValid, isCredentialRefField } from "./credential-store.mjs";
import { failed, passed, unanswered } from "./health.mjs";

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every stored credential an entry names, by field, each one the grammar accepts. PURE. */
function credentialRefsOf(entry) {
  if (!isPlainObject(entry)) return {};
  return Object.fromEntries(Object.entries(entry)
    .filter(([field, ref]) => isCredentialRefField(field) && credentialRefIsValid(ref))
    .map(([field, ref]) => [field, String(ref)]));
}

/**
 * The registry format this aify-env understands.
 *
 * Both writers -- aify-comms and aify-wrapper -- declare the same number and refuse a registry that
 * disagrees. The field exists so a format change can be NOTICED rather than half-read, which only
 * works if the readers look at it too.
 */
export const SUPPORTED_REGISTRY_VERSION = 1;

/**
 * The version a registry declares, or null when it declares none.
 *
 * Null means "did not say", which is not the same as "said something wrong": a hand-written file that
 * omits the field is read on its merits, while one that announces a format we do not know is not.
 *
 * @param {unknown} registryText
 * @returns {number|null}
 */
export function registryVersion(registryText) {
  const raw = typeof registryText === "string" ? registryText.trim() : "";
  if (raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "number" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Services registered on this host: `[{name, endpoint}]`, sorted.
 *
 * Never throws. An absent registry is no services, which is a legitimate state; a malformed one is
 * also no services, because aify-env must still start and still own processes when the file is broken.
 * It simply cannot tell anyone which services exist, and its doctor is where that gets said.
 */
/**
 * Whether registry text can be read at all. `readServices` answers [] for a file it cannot parse, and
 * that is right for advertising (nobody to tell), but a caller that ACTS on removals must not read an
 * unparseable registry as one naming no services: that would detach every plugin over a typo.
 */
export function registryIsReadable(registryText) {
  try {
    const parsed = JSON.parse(String(registryText ?? ""));
    return isPlainObject(parsed) && isPlainObject(parsed.services);
  } catch {
    return false;
  }
}

/**
 * Every stored credential the registry references, `{service, field, ref}`, or why that cannot be known. PURE.
 *
 * ⛔ THE WHOLE REFERENCE POPULATION, NOT THE PROBING ONE. `readServices` drops an entry with no endpoint, since there
 * is nowhere to knock; its credential is still referenced, and a doctor counting from it called a live key an orphan.
 * And UNKNOWN IS NOT EMPTY: a registry that cannot be read, is not a registry, or declares a version this does not
 * read (its own `version`, uncoerced) names an unknown set, so nothing it holds may be called unreferenced. Only an
 * absent or empty registry names nothing.
 *
 * @param {{text?: string|null, missing?: boolean, readError?: string}} source  what `readRegistry` answered
 * @returns {{references: Array<{service: string, field: string, ref: string}>}|{unknown: string}}
 */
export function registryReferences(source) {
  if (source?.readError) return { unknown: `the registry could not be read: ${source.readError}` };
  const text = typeof source?.text === "string" ? source.text : "";
  if (source?.missing || text.trim() === "") return { references: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { unknown: "the registry is not JSON" }; }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.services)) return { unknown: "the registry has no services object" };
  if (Object.hasOwn(parsed, "version") && parsed.version !== SUPPORTED_REGISTRY_VERSION) {
    return { unknown: "the registry declares a version this doctor does not read" };
  }
  const references = [];
  for (const [service, entry] of Object.entries(parsed.services)) {
    if (!isPlainObject(entry)) continue;
    for (const [field, ref] of Object.entries(entry)) {
      if (isCredentialRefField(field) && credentialRefIsValid(ref)) references.push({ service, field, ref: String(ref) });
    }
  }
  return { references };
}

export function readServices(registryText) {
  const raw = typeof registryText === "string" ? registryText.trim() : "";
  if (raw === "") return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.services)) return [];

  return Object.keys(parsed.services)
    .sort()
    .map((name) => ({
      name,
      endpoint: parsed.services[name]?.endpoint,
      // THE ENV NAMES that hold this service's key -- never the key itself. The registry is a
      // shared file every service on the host can read, so a secret in it would be a secret shared
      // with everything. Names let each writer say where ITS credential lives and let a reader
      // resolve one from its own environment, which is the only place it should exist.
      keyEnv: Array.isArray(parsed.services[name]?.keyEnv)
        ? parsed.services[name].keyEnv.filter((n) => typeof n === "string" && n.trim() !== "")
        : [],
      // AND WHERE THE FILE IS, still never the value. `keyEnv` only works for a process somebody
      // exported a variable into, and nothing on this host does that for the daemon -- which is why
      // enabling API_KEY made every advertisement 401 in silence. `credentialRef` is one BASENAME
      // that this daemon resolves under its own root, so the registry cannot point anywhere.
      // A reference the grammar refuses is dropped rather than carried: a registry is a shared file
      // and a bad value in it must not become a path this daemon tries.
      credentialRef: credentialRefIsValid(parsed.services[name]?.credentialRef)
        ? String(parsed.services[name].credentialRef)
        : "",
      // AND EVERY OTHER STORED CREDENTIAL IT NAMES, by field, `credentialRef` among them: aify-dashboard's secrets fetch
      // key is `secretsCredentialRef`. The doctor's referenced set is these, so a new one is counted without a list.
      credentialRefs: credentialRefsOf(parsed.services[name]),
      // CARRIED AS WRITTEN, whatever its type: `advertisingChoice` decides what it means and reports a value it
      // ignores. Normalised here, a non-boolean would vanish before anything could say so.
      advertise: parsed.services[name]?.advertise,
    }))
    // A service with no endpoint is not somewhere we can knock. Skipping beats half-reading it.
    .filter((service) => typeof service.endpoint === "string" && service.endpoint.trim() !== "");
}

/**
 * Turn one service's answer into a check.
 *
 * @param {{name: string, endpoint: string}} service
 * @param {{ok: boolean, body?: unknown, error?: string}} response
 *   Supplied by the caller rather than fetched here, so the decision is testable without a network and
 *   so the transport can change without this rule moving.
 */
export function probeService(service, response) {
  if (!response?.ok) {
    return unanswered(
      service.name,
      `no answer from ${service.endpoint}: ${response?.error ?? "unreachable"}`,
    );
  }

  const body = response.body;
  if (!isPlainObject(body) || typeof body.status !== "string") {
    // A 200 carrying HTML is a proxy or a captive portal, not a service saying it is well.
    return unanswered(service.name, `${service.endpoint} answered, but not with a health report`);
  }

  // ONLY the fields a health report is defined to carry. A service volunteering agent counts must not
  // turn aify-env into a second place that answers questions about agents: alive is not working, and
  // two components deriving status is how two answers start disagreeing.
  // `build` joins the defined set because a release version cannot distinguish two BUILDS of one
  // release, and that is the case this stack hits: the fleet runs a checkout that moved on since the
  // tag. Still a relay -- rendered only when the service sends a string, so a service sending a number
  // or an object leaves no trace rather than turning this into a parser of somebody else's mistakes.
  const build = typeof body.build === "string" && body.build ? ` build ${body.build}` : "";
  const version = typeof body.version === "string" ? ` version ${body.version}${build}` : build;
  const detail = typeof body.detail === "string" ? ` — ${body.detail}` : "";

  if (body.status === "healthy" || body.status === "ok") {
    return passed(service.name, `${service.endpoint} reports ${body.status}${version}`);
  }

  // The evidence exists and it is bad, and the service said so itself. This is the one case aify-env
  // may call a failure, and it still holds no opinion of its own.
  return failed(
    service.name,
    `${service.endpoint} reports ${body.status}${version}${detail}`,
    `Ask ${service.name} why it is ${body.status}; aify-env only relays what it was told.`,
  );
}
