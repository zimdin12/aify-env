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

/**
 * How much recent output is kept per process for a late subscriber.
 *
 * Bounded because a process that runs for a week must not be holding a week of scrollback in the
 * environment's memory. Enough to fill a console on attach, and not a scrollback store: whoever wants
 * history should be keeping it, and it is not this component's concern.
 */
const DEFAULT_REPLAY_BYTES = 64 * 1024;

export class Runner {
  #registry;
  #openTerminal;
  #spawnProcess;
  #replayBytes;
  #live = new Map();
  /** id -> {buffer: string, listeners: Set<Function>} */
  #streams = new Map();

  /**
   * @param {{openTerminal?: Function|null, spawnProcess?: Function, registry?: ProcessRegistry}} deps
   *   `openTerminal: null` forces the piped path. Omitted means "use a terminal if this host has one".
   */
  constructor(deps = {}) {
    this.#registry = deps.registry ?? new ProcessRegistry();
    this.#openTerminal = deps.openTerminal === undefined ? defaultOpenTerminal() : deps.openTerminal;
    this.#spawnProcess = deps.spawnProcess ?? nodeSpawn;
    this.#replayBytes = deps.replayBytes ?? DEFAULT_REPLAY_BYTES;
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
        // stdin PIPED, not ignored. Ignoring it means a piped process can never be typed at, which
        // makes the fallback path a viewer rather than a console -- and a caller wanting to delegate
        // would have to keep a local terminal around just for the writing.
        stdio: ["pipe", "pipe", "pipe"],
      });

    const entry = this.#registry.add({
      service: spec.service,
      pid: child.pid ?? 0,
      terminal: useTerminal,
    });

    const stream = { buffer: "", listeners: new Set() };
    this.#streams.set(entry.id, stream);

    const emit = (chunk) => {
      const text = String(chunk);
      // Keep the MOST RECENT bytes. Truncating from the other end gives a console the start of a
      // session and none of what is happening now, which is the half nobody needs.
      stream.buffer = (stream.buffer + text).slice(-this.#replayBytes);
      for (const listener of outputListeners) listener(text);
      for (const listener of stream.listeners) {
        try {
          listener(text);
        } catch {
          // Delivery is best-effort. A broken console must not be able to take down an agent.
        }
      }
    };
    const finish = (code) => {
      this.#registry.remove(entry.id);
      this.#live.delete(entry.id);
      // The stream OUTLIVES the process deliberately, so a consumer that attaches just after an exit
      // still sees why it exited. stop() is what releases it; the reaper calls stop().
      resolveExit(code ?? 0);
    };

    if (useTerminal) {
      child.onData(emit);
      child.onExit((event) => {
        // Release what the terminal holds. MEASURED, so nobody has to trust it: on Windows ConPTY this
        // frees the MessagePort and does NOT free a PipeWrap, which is why a process that has spawned
        // one never exits by itself. Partial is worth doing — a long-running environment spawning
        // thousands of agents accumulates both otherwise — and partial is worth saying, because the
        // next person will otherwise assume this closed the whole hole. See README.
        try {
          child.destroy?.();
        } catch {
          // Already gone. The registry is the thing that had to be right, and finish() sees to that.
        }
        finish(event?.exitCode);
      });
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

  /** Is there anything to watch under this id? Asked by the request layer, which must answer 404
   * without subscribing — deciding whether a route exists should not have a side effect. */
  canStream(id) {
    return this.#streams.has(id);
  }

  /**
   * Watch a process's output: the recent buffer first, then everything new.
   *
   * Returns an unsubscribe function, or NULL when there is no such process. A caller has to be able to
   * tell "no such process" from "a process that has produced nothing yet" — one is a 404 and the other
   * is an open stream, and conflating them makes a console show empty for a reason nobody can see.
   */
  subscribe(id, listener) {
    const stream = this.#streams.get(id);
    if (!stream) return null;

    if (stream.buffer) {
      try {
        listener(stream.buffer);
      } catch {
        // A subscriber that throws on its replay still gets the live feed; its failure is its own.
      }
    }
    stream.listeners.add(listener);
    return () => stream.listeners.delete(listener);
  }

  /**
   * Send input to a process.
   *
   * Refuses an unknown id rather than dropping the bytes. A console typing into a process that has
   * gone must be told, or the operator types into a void and concludes the agent is ignoring them.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  write(id, data) {
    const child = this.#live.get(id);
    if (!child) return { ok: false, error: `no such process: ${id}` };
    try {
      if (typeof child.write === "function") child.write(data);
      else if (child.stdin) child.stdin.write(data);
      else return { ok: false, error: `process ${id} has no input channel` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Resize a process's terminal.
   *
   * A piped process has no terminal, and saying so is the point. Accepting the request silently would
   * let a console believe it had set a width while the agent kept wrapping at the default, with
   * nothing anywhere explaining the difference.
   *
   * Dimensions are validated here rather than passed through: a zero or negative winsize has thrown
   * out of node-pty's ioctl before, and a console sending one should be told rather than taking the
   * environment down with it.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  resize(id, cols, rows) {
    const child = this.#live.get(id);
    if (!child) return { ok: false, error: `no such process: ${id}` };
    if (typeof child.resize !== "function") {
      return { ok: false, error: `process ${id} has no terminal to resize` };
    }
    for (const [name, value] of [["cols", cols], ["rows", rows]]) {
      if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
        return { ok: false, error: `${name} must be a positive integer, got ${JSON.stringify(value)}` };
      }
    }
    try {
      child.resize(cols, rows);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Stop a process, and release what watching it costs.
   *
   * Idempotent, and safe on an id that never existed. A reaper runs on a schedule and will be asked to
   * stop things that already stopped; making that an error would mean every reaper needs to check
   * first, which is a race with extra steps.
   */
  async stop(id) {
    const child = this.#live.get(id);
    this.#live.delete(id);
    this.#registry.remove(id);
    // Buffers must not outlive the processes they belong to, or a long-running environment accumulates
    // one per process it has ever started: a leak with a slow fuse.
    this.#streams.delete(id);
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
