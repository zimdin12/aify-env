// What other plugins add to a defined worker's environment at start: the `spawnEnv` capability.
//
// A PLUGIN OFFERS `spawnEnv: { field, contribute({definition, signal}) }`, the way `agents` is offered, and is asked for
// every start built from a definition on this host. `field`, if present, is the definition field it supplies, one of
// the schema's PLUGIN_SUPPLIED_FIELDS. `definition` is that agent as this host's file holds it now, never what the
// launch carries (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, rule 1). It answers `{env: {NAME: "value"}}` or
// `{refused: {reason, variable}}`, `reason` one of CONTRIBUTOR_REASONS.
//
// EVERYTHING HERE FAILS THE START, never the variable. A worker started without what its definition names would run
// as if that were optional (rule 5). The service's own start retry is the retry.
//
// ⛔ NO TEXT A CONTRIBUTOR PRODUCES LEAVES THIS MODULE ("The spawnEnv repair: plan revision 1"). A reason is built here
// from host words: the fixed label "a plugin" (an offer's own `service` is shape, not ownership), a reason from the
// list, and a variable name only when the definition itself names it. A contributor is read by own descriptor, data
// properties only: an accessor is never invoked, and a throw, a rejection or a failing proxy is "a plugin failed".

import { ENV_NAME_PATTERN, PLUGIN_SUPPLIED_FIELDS, suppliedNames } from "../../agent-definition-schema.mjs";

/** How long every contributor together may take before the start is refused. Each contributor bounds its own calls. */
export const SPAWN_ENV_WAIT_MS = 15_000;

/** The only reasons a contributor may give, and the host's words for each. */
export const CONTRIBUTOR_REASONS = Object.freeze({
  "not-found": "was not found where it is kept",
  refused: "was refused where it is kept",
  unreadable: "could not be read where it is kept",
  unavailable: "cannot be fetched on this host now",
  unreachable: "could not be fetched",
  "no-credential": "could not be fetched: this host holds no credential for it",
  "bad-answer": "came back malformed",
});

const WHO = "a plugin";
const FAILED = `${WHO} failed`;
const WRONG_SHAPE = `${WHO} answered in the wrong shape`;
const NO_STORE = "this host has no definition store to read the start's definition from";
const WRONG = Symbol("wrong shape");
const ABSENT = Symbol("absent");
const NOT_DATA = Symbol("not a data property");
const LATE = Symbol("late");
const THREW = Symbol("threw");

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** An own, enumerable data property's value, ABSENT, or NOT_DATA. Never invokes an accessor. */
function own(object, key) {
  const found = Object.getOwnPropertyDescriptor(object, key);
  if (!found) return ABSENT;
  return "value" in found && found.enumerable ? found.value : NOT_DATA;
}

/** `object`'s own keys, or null when any of them is a symbol. */
function stringKeys(object) {
  const keys = Reflect.ownKeys(object);
  return keys.every((key) => typeof key === "string") ? keys : null;
}

/** Every env name the definition itself names, through any supplied field. PURE. */
function definitionNames(agent) {
  return new Set(PLUGIN_SUPPLIED_FIELDS.flatMap((field) => suppliedNames(agent, field)));
}

/** How a reason may name a contributed variable: by name only when the definition names it. PURE. */
const label = (name, named) => (named.has(name) ? name : "a variable a plugin set");

/** `{field, contribute}` from an offer, or `{refused}`. May throw, for a failing proxy; the caller contains it. */
function readOffer(contributor) {
  if (!isObject(contributor)) return { refused: `${WHO} offers nothing this host can ask` };
  const contribute = own(contributor, "contribute");
  if (typeof contribute !== "function") return { refused: `${WHO} offers nothing this host can ask` };
  const field = own(contributor, "field");
  if (field === ABSENT) return { field: null, contribute };
  if (typeof field !== "string" || !PLUGIN_SUPPLIED_FIELDS.includes(field)) return { refused: `${WHO} declares a field this host does not supply` };
  return { field, contribute };
}

/** `{env: [[name, value]]}`, `{refused: {reason, variable?}}`, or WRONG. May throw; the caller contains it. */
function readAnswer(answer, names) {
  if (!isObject(answer)) return WRONG;
  const keys = stringKeys(answer);
  if (!keys || keys.length !== 1) return WRONG;
  const value = own(answer, keys[0]);
  if (keys[0] === "env") return readEnv(value);
  if (keys[0] === "refused") return readRefusal(value, names);
  return WRONG;
}

function readEnv(value) {
  if (!isObject(value)) return WRONG;
  const keys = stringKeys(value);
  if (!keys) return WRONG;
  const entries = keys.map((key) => [key, own(value, key)]);
  return entries.every(([, entry]) => typeof entry === "string") ? { env: entries } : WRONG;
}

function readRefusal(value, names) {
  if (!isObject(value)) return WRONG;
  const keys = stringKeys(value);
  if (!keys || keys.some((key) => key !== "reason" && key !== "variable")) return WRONG;
  const reason = own(value, "reason");
  if (typeof reason !== "string" || !Object.hasOwn(CONTRIBUTOR_REASONS, reason)) return WRONG;
  const variable = own(value, "variable");
  if (variable === ABSENT) return { refused: { reason } };
  // Present, it must be a name the definition asks this contributor for: anything else would be a channel.
  return typeof variable === "string" && names.includes(variable) ? { refused: { reason, variable } } : WRONG;
}

/** Why `name` may not be contributed, or "". PURE. */
function nameProblem(name, names, field) {
  if (name === "__proto__") return "__proto__ cannot be carried into a worker's environment on this host";
  if (!ENV_NAME_PATTERN.test(name)) return `${WHO} set a variable name this host does not accept`;
  if (field && !names.includes(name)) return `${WHO} set a variable its field does not name`;
  return "";
}

/**
 * Ask every contributor, in order, for `definition`. `{env}` is everything they added, `{refused}` the first reason,
 * in the host's words. Bounded: a contributor that ignores the signal is still given up on.
 */
export async function contributedEnv({ contributors, definition, waitMs = SPAWN_ENV_WAIT_MS, windows = false }) {
  const named = definitionNames(definition);
  const timeout = new AbortController();
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => { timeout.abort(); resolve(LATE); }, waitMs); });
  try {
    const env = {};
    const setBy = new Set(); // the names as compared
    for (const contributor of contributors) {
      let offer;
      let answer;
      try {
        offer = readOffer(contributor);
        if (offer.refused) return offer;
        const asked = Promise.resolve(Reflect.apply(offer.contribute, contributor, [{ definition, signal: timeout.signal }]));
        answer = await Promise.race([asked.then((value) => ({ value }), () => THREW), late]);
      } catch {
        return { refused: FAILED };
      }
      if (answer === LATE) return { refused: `${WHO} did not answer within ${waitMs / 1000} s` };
      if (answer === THREW) return { refused: FAILED };
      const names = offer.field ? suppliedNames(definition, offer.field) : [];
      let read;
      try { read = readAnswer(answer.value, names); } catch { return { refused: FAILED }; }
      if (read === WRONG) return { refused: WRONG_SHAPE };
      if (read.refused) {
        return { refused: `${WHO}: ${read.refused.variable ?? "a variable it supplies"} ${CONTRIBUTOR_REASONS[read.refused.reason]}` };
      }
      for (const [name, value] of read.env) {
        const problem = nameProblem(name, names, offer.field);
        if (problem) return { refused: problem };
        const key = windows ? name.toUpperCase() : name;
        if (setBy.has(key)) return { refused: `two values were contributed for ${label(name, named)}` };
        setBy.add(key);
        env[name] = value;
      }
    }
    return { env };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The env a start runs with once every contributor has answered for its definition, or why it must not start. Only a
 * start built from a definition on this host is asked about, and with no store to read that definition from it is
 * refused, not started bare: the contributors' answer is what the definition names, and nothing else can know it.
 * Never throws.
 *
 * ⛔ A DEFINITION NAMING A FIELD NO STARTED PLUGIN SUPPLIES IS REFUSED. Otherwise nobody fetches and nothing refuses,
 * and the worker runs without its secrets on every host where aify-dashboard is not started. So the definition is read
 * even when no plugin contributes. With no store and no contributor nothing is read: admission has no store either.
 */
export async function spawnEnvFor({ launch, env, contributors, definitionFor, windows, waitMs }) {
  if (!launch?.definition) return { env };
  if (typeof definitionFor !== "function") return contributors.length === 0 ? { env } : { refused: NO_STORE };
  let bound;
  try { bound = await definitionFor(launch); } catch { return { refused: "this host could not read the start's definition" }; }
  if (bound.refused) return { refused: bound.refused };
  const fields = [];
  for (const contributor of contributors) {
    let offer;
    try { offer = readOffer(contributor); } catch { return { refused: FAILED }; }
    if (offer.refused) return offer;
    fields.push(offer.field);
  }
  const unsupplied = PLUGIN_SUPPLIED_FIELDS.find((field) => Object.hasOwn(bound.agent, field) && !fields.includes(field));
  if (unsupplied) return { refused: `${launch.agentId} names ${unsupplied}, and no plugin started on this host supplies them` };
  if (contributors.length === 0) return { env };
  const contributed = await contributedEnv({ contributors, definition: bound.agent, windows, waitMs });
  if (contributed.refused) return contributed;
  return layeredEnv(env, contributed.env, { launch: launch.env, definition: bound.agent.env, windows, named: definitionNames(bound.agent) });
}

/**
 * `env` with `contributed` laid on top, or why the start must not happen. PURE.
 *
 * ⛔ A NAME THE LAUNCH OR THE DEFINITION SETS IS A COLLISION, NOT AN OVERRIDE: a silent winner between two sources of
 * one variable is the defect it would hide. On Windows the comparison ignores case, since a child gets its env in any
 * case there. A variable the daemon only inherited is replaced, in whatever case it had, so one spelling is left. A
 * reason names a contributed variable only when the definition does (`named`), and never the other side's spelling.
 */
export function layeredEnv(env, contributed, { launch = {}, definition = {}, windows = false, named = new Set() }) {
  const compare = (name) => (windows ? name.toUpperCase() : name);
  const owners = [[launch, "the launch"], [definition, "the definition"]];
  const next = { ...env };
  for (const [name, value] of Object.entries(contributed)) {
    if (value.includes("\u0000")) return { refused: `${label(name, named)} holds a NUL, which an environment block cannot carry` };
    for (const [source, owner] of owners) {
      if (Object.keys(source ?? {}).some((key) => compare(key) === compare(name))) {
        return { refused: `${label(name, named)} collides with a variable ${owner} sets` };
      }
    }
    for (const key of Object.keys(next)) if (compare(key) === compare(name)) delete next[key];
    next[name] = value;
  }
  return { env: next };
}
