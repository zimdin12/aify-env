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
const CARRIERS = new Set(["AIFY_ENV_URL", "AIFY_ENV_INSTANCE", "AIFY_LIFETIME"]);

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
    if (spec.agentId === undefined) return { child: createChild(spec), register() {} };
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
    return {
      child: createChild({ ...spec, env }),
      register: (handle, pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return;
        const record = { agentId: spec.agentId, lifetime, instance: owner.instance, pid, handle,
          cwd: typeof spec.cwd === "string" && spec.cwd ? spec.cwd : null, definition: launchDefinition(spec.definition) };
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
