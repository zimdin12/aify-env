// What other plugins add to a defined worker's environment at start: the `spawnEnv` capability.
//
// A PLUGIN OFFERS `spawnEnv: { service, contribute({definition, signal}) }`, the way `agents` is offered, and is asked
// for every start built from a definition on this host. `definition` is that agent as this host's file holds it now,
// never what the launch carries (aify-dashboard docs/DESIGN-SECRETS-INJECTION.md, rule 1). It answers
// `{env: {NAME: "value"}}` or `{refused: "why"}`.
//
// EVERYTHING HERE FAILS THE START, never the variable. A worker started without what its definition names would run
// as if that were optional (rule 5), so a refusal, a throw, a malformed answer, no answer in time, a name two sources
// set, or a value an env block cannot carry each refuses the start, with a reason that names the variable and never
// its value. The service's own start retry is the retry.

/** How long every contributor together may take before the start is refused. Each contributor bounds its own calls. */
export const SPAWN_ENV_WAIT_MS = 15_000;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `{env}` when the answer is a map of string values, `{refused}` when it says so, or null for anything else. */
function answerOf(answer) {
  if (isPlainObject(answer) && typeof answer.refused === "string" && answer.refused) return { refused: answer.refused };
  if (!isPlainObject(answer) || !isPlainObject(answer.env)) return null;
  return Object.values(answer.env).every((value) => typeof value === "string") ? { env: answer.env } : null;
}

/**
 * Ask every contributor, in order, for `definition`. `{env}` is everything they added, `{refused}` the first reason
 * one gave, prefixed with its service. Bounded: a contributor that ignores the signal is still given up on.
 */
export async function contributedEnv({ contributors, definition, waitMs = SPAWN_ENV_WAIT_MS, windows = false }) {
  const timeout = new AbortController();
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => { timeout.abort(); resolve(null); }, waitMs); });
  try {
    const env = {};
    const setBy = new Map(); // the name as compared -> [name, service]
    for (const contributor of contributors) {
      const service = String(contributor?.service || "a plugin");
      let answer;
      try {
        const asked = Promise.resolve(contributor.contribute({ definition, signal: timeout.signal })).then((value) => ({ value }));
        answer = await Promise.race([asked, late]);
      } catch (error) {
        return { refused: `${service}: ${error?.message || error}` };
      }
      if (answer === null) return { refused: `${service}: did not answer within ${waitMs / 1000} s` };
      const read = answerOf(answer.value);
      if (!read) return { refused: `${service}: answered in the wrong shape` };
      if (read.refused) return { refused: `${service}: ${read.refused}` };
      for (const [name, value] of Object.entries(read.env)) {
        const key = windows ? name.toUpperCase() : name;
        if (setBy.has(key)) return { refused: `two plugins set ${name}: ${setBy.get(key)[1]} and ${service}` };
        setBy.set(key, [name, service]);
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
 */
export async function spawnEnvFor({ launch, env, contributors, definitionFor, windows, waitMs }) {
  if (!launch?.definition || contributors.length === 0) return { env };
  if (typeof definitionFor !== "function") return { refused: "this host has no definition store to read the start's definition from" };
  const bound = await definitionFor(launch);
  if (bound.refused) return { refused: bound.refused };
  const contributed = await contributedEnv({ contributors, definition: bound.agent, windows, waitMs });
  if (contributed.refused) return contributed;
  return layeredEnv(env, contributed.env, { launch: launch.env, definition: bound.agent.env, windows });
}

/**
 * `env` with `contributed` laid on top, or why the start must not happen. PURE.
 *
 * ⛔ A NAME THE LAUNCH OR THE DEFINITION SETS IS A COLLISION, NOT AN OVERRIDE: a silent winner between two sources of
 * one variable is the defect it would hide. On Windows the comparison ignores case, since a child gets its env in any
 * case there. A variable the daemon only inherited is replaced, in whatever case it had, so one spelling is left.
 */
export function layeredEnv(env, contributed, { launch = {}, definition = {}, windows = false }) {
  const compare = (name) => (windows ? name.toUpperCase() : name);
  const owners = [[launch, "the launch"], [definition, "the definition"]];
  const next = { ...env };
  for (const [name, value] of Object.entries(contributed)) {
    if (value.includes("\u0000")) return { refused: `${name} holds a NUL, which an environment block cannot carry` };
    for (const [source, owner] of owners) {
      const taken = Object.keys(source ?? {}).find((key) => compare(key) === compare(name));
      if (taken !== undefined) return { refused: `${name} collides with ${taken}, which ${owner} sets` };
    }
    for (const key of Object.keys(next)) if (compare(key) === compare(name)) delete next[key];
    next[name] = value;
  }
  return { env: next };
}
