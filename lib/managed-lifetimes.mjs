// Runner's named children, bound to their actual owner and captured handle, never a display label.
import { randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const counter = (value) => Number.isSafeInteger(value) && value > 0;
/** The binding a launch was built from, or null: a malformed one is reported as none, never half. */
export function launchDefinition(definition) {
  return definition !== null && typeof definition === "object" && typeof definition.storeId === "string"
    && definition.storeId && counter(definition.incarnation) && counter(definition.revision)
    ? { storeId: definition.storeId, incarnation: definition.incarnation, revision: definition.revision } : null;
}
/** The names a managed child's lifetime travels in: set on every managed start, and nowhere else. */
export const LIFETIME_CARRIERS = Object.freeze(["AIFY_ENV_URL", "AIFY_ENV_INSTANCE", "AIFY_LIFETIME"]);
/**
 * The names a managed child's DEFINITION BINDING travels in (0.9.9): the incarnation and revision of the definition its
 * start was admitted against, set only for a start built from one. aify-wrapper's launcher compares them with the
 * definition file it reads, so instructions are never taken from a revision nobody admitted (the P2 in aify-wrapper
 * c4818238). Stripped from what the child inherits like the lifetime's: an aify-env started inside a managed agent
 * must not hand that agent's binding to its own children.
 */
export const BINDING_CARRIERS = Object.freeze(["AIFY_DEFINITION_INCARNATION", "AIFY_DEFINITION_REVISION"]);
const CARRIERS = new Set([...LIFETIME_CARRIERS, ...BINDING_CARRIERS]);

/**
 * `env` (or the environment it inherits) without the binding names, or `env` itself when it carries none. A start with
 * no agent is bound to no definition, and aify-wrapper's launcher refuses a lone or foreign pair: one inherited by an
 * aify-env started inside a managed agent would refuse an unrelated start, or bind it to that agent's revision.
 */
function withoutBinding(env, base = process.env) {
  const source = env ?? base;
  const carried = (key) => BINDING_CARRIERS.includes(key.toUpperCase());
  if (!Object.keys(source).some(carried)) return env;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !carried(key)));
}

export class ManagedLifetimes {
  #owner;
  #report;
  #children = new Map();

  constructor({ managedHost, reportManaged = () => {} } = {}) {
    this.#owner = managedHost;
    this.#report = reportManaged;
  }

  /** Resolve after checkpoint loading, before spawn; failed creation never calls register. */
  spawn(spec, createChild) {
    if (spec.agentId === undefined) return { child: createChild({ ...spec, env: withoutBinding(spec.env) }), register() {} };
    if (typeof spec.agentId !== "string" || !ID.test(spec.agentId)) throw new TypeError("invalid managed agentId");
    const owner = this.#owner?.();
    if (!owner?.host || typeof owner.host.startManaged !== "function" || typeof owner.host.endManaged !== "function"
      || typeof owner.instance !== "string" || !ID.test(owner.instance)
      || typeof owner.url !== "string" || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(owner.url)
      || Number(new URL(owner.url).port) < 1) throw new Error("managed host unavailable");
    const lifetime = randomUUID();
    const env = Object.fromEntries(Object.entries(spec.env ?? process.env)
      .filter(([key]) => !CARRIERS.has(key.toUpperCase())));
    Object.assign(env, { AIFY_ENV_URL: owner.url, AIFY_ENV_INSTANCE: owner.instance, AIFY_LIFETIME: lifetime });
    const binding = launchDefinition(spec.definition);
    if (binding) Object.assign(env, { AIFY_DEFINITION_INCARNATION: String(binding.incarnation), AIFY_DEFINITION_REVISION: String(binding.revision) });
    return {
      child: createChild({ ...spec, env }),
      register: (handle, pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return;
        // `writtenAtUs`, as a resident's record has: the child exists by now, so an OS answer probed before this moment
        // may describe the pid's previous holder, and is not taken for this lifetime.
        const record = { agentId: spec.agentId, lifetime, instance: owner.instance, pid, handle,
          cwd: typeof spec.cwd === "string" && spec.cwd ? spec.cwd : null, definition: launchDefinition(spec.definition),
          writtenAtUs: Date.now() * 1000 };
        owner.host.startManaged(record);
        this.#children.set(handle, { host: owner.host, lifetime });
      },
    };
  }

  /** Called only on observed exit or confirmed death, including after stop removed the registry entry. */
  end(handle) {
    const captured = this.#children.get(handle);
    if (!captured) return;
    this.#children.delete(handle);
    const result = captured.host.endManaged(captured.lifetime);
    if (result.problem) {
      try { this.#report(`managed lifetime end: ${result.problem}`); } catch { /* reporting cannot abort Runner cleanup */ }
    }
  }
}
