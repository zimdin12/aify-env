// Starting a process, owning it, and knowing when it is gone.
//
// Two paths, and the difference is visible to a consumer rather than being an implementation detail.
// A PTY gives a real terminal, which is what a web console needs to render a TUI at all. Piped stdio
// gives the output and none of the terminal. So the handle SAYS which one it got: a caller that
// silently receives pipes when it expected a terminal gets output that looks slightly wrong and no
// reason why.
//
// Everything ambient is injectable — the terminal factory and the spawner both. Not for tidiness: a
// native module that may or may not be installed is exactly the kind of thing that turns a test suite
// into a report about the developer's machine.
//
// NOTHING STARTS WITHOUT PASSING THE ALLOWLIST. The check lives here, at the only door, rather than at
// the call sites. A guard the caller has to remember to invoke is a guard that eventually is not.

import { spawn as nodeSpawn } from "node:child_process";

import { mayExecute } from "./allowlist.mjs";
import { ProcessRegistry } from "./process-registry.mjs";

/**
 * Whether a real terminal is available here, and if not, why not.
 *
 * Deliberately not a boolean. "We could not tell" is the answer that lets a caller assume the good
 * case, and this project has a rule paid for in incidents: no evidence is not a pass.
 */
export function terminalSupport() {
  try {
    // eslint-disable-next-line no-undef
    const require = createRequire();
    require.resolve("node-pty");
    return { available: true, reason: "" };
  } catch (error) {
    return { available: false, reason: `node-pty did not load: ${error.code ?? error.message}` };
  }
}

function createRequire() {
  // Indirection so the missing-module case is a value rather than an import-time crash.
  return globalThis.process.getBuiltinModule
    ? globalThis.process.getBuiltinModule("module").createRequire(import.meta.url)
    : null;
}

function defaultOpenTerminal() {
  if (!terminalSupport().available) return null;
  const require = createRequire();
  const pty = require("node-pty");
  return (command, args, options) => pty.spawn(command, args, {
    name: "xterm-color",
    cols: options?.cols ?? 120,
    rows: options?.rows ?? 30,
    cwd: options?.cwd,
    env: options?.env,
  });
}

export class Runner {
  #registry;
  #openTerminal;
  #spawnProcess;
  #live = new Map();

  /**
   * @param {{openTerminal?: Function|null, spawnProcess?: Function, registry?: ProcessRegistry}} deps
   *   `openTerminal: null` forces the piped path. Omitted means "use a terminal if this host has one".
   */
  constructor(deps = {}) {
    this.#registry = deps.registry ?? new ProcessRegistry();
    this.#openTerminal = deps.openTerminal === undefined ? defaultOpenTerminal() : deps.openTerminal;
    this.#spawnProcess = deps.spawnProcess ?? nodeSpawn;
  }

  /**
   * Start a process on behalf of a service.
   *
   * @param {{service: string, fileText: string, command: string, args: string[], cwd?: string, env?: object}} spec
   *   `fileText` is the launcher's contents, which the allowlist judges. It is passed rather than read
   *   here so the decision stays testable without a filesystem, and so the caller cannot hand us a
   *   path whose contents changed between the check and the spawn.
   */
  async start(spec) {
    const verdict = mayExecute(spec.fileText);
    if (!verdict.ok) {
      // Thrown BEFORE anything is spawned or recorded. A refused start must leave no trace.
      throw new Error(`aify-env refused to start ${spec.command}: ${verdict.reason}`);
    }

    const outputListeners = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });

    const useTerminal = typeof this.#openTerminal === "function";
    const child = useTerminal
      ? this.#openTerminal(spec.command, spec.args ?? [], { cwd: spec.cwd, env: spec.env })
      : this.#spawnProcess(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

    const entry = this.#registry.add({
      service: spec.service,
      pid: child.pid ?? 0,
      terminal: useTerminal,
    });

    const emit = (chunk) => {
      for (const listener of outputListeners) listener(String(chunk));
    };
    const finish = (code) => {
      this.#registry.remove(entry.id);
      this.#live.delete(entry.id);
      resolveExit(code ?? 0);
    };

    if (useTerminal) {
      child.onData(emit);
      child.onExit((event) => finish(event?.exitCode));
    } else {
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);
      child.on("close", (code) => finish(code));
      // A spawn that fails (missing binary) must resolve the same way, or a caller awaits forever.
      child.on("error", () => finish(-1));
    }

    this.#live.set(entry.id, child);

    return {
      id: entry.id,
      pid: entry.pid,
      terminal: useTerminal,
      service: spec.service,
      exited,
      onOutput: (listener) => outputListeners.push(listener),
      write: (data) => (useTerminal ? child.write(data) : child.stdin?.write(data)),
    };
  }

  /**
   * Stop a process.
   *
   * Idempotent, and safe on an id that never existed. A reaper runs on a schedule and will be asked to
   * stop things that already stopped; making that an error would mean every reaper needs to check
   * first, which is a race with extra steps.
   */
  async stop(id) {
    const child = this.#live.get(id);
    this.#live.delete(id);
    this.#registry.remove(id);
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Already gone. The registry is the thing that had to be right, and it is.
    }
  }

  list() {
    return this.#registry.list();
  }
}
