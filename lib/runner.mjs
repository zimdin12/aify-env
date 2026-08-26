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
import { recordStarted, recordStopped } from "./owned-processes.mjs";
import { killTree } from "./kill-tree.mjs";

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
 * The LAST terminal title in a chunk of output, or null when it contains none.
 *
 * OSC 0 and OSC 2 both set a window title and both end with BEL or ST. Kept small and pure: it runs on
 * every byte a process emits, so it must not allocate a parser or throw on half a sequence -- a title
 * split across two chunks is simply missed, and the next one arrives soon enough.
 */
export function lastTerminalTitle(text) {
  // Scanned rather than matched. A regex for this needs an escape, a bracket and two terminators, and
  // building one through three layers of quoting produced `Unterminated group` twice; this cannot be
  // broken that way and is easier to read besides.
  const ESCAPE = String.fromCharCode(27);
  const BELL = String.fromCharCode(7);
  const value = String(text ?? "");
  let found = null;
  for (const opener of [`${ESCAPE}]0;`, `${ESCAPE}]2;`]) {
    let at = value.indexOf(opener);
    while (at !== -1) {
      const from = at + opener.length;
      // Either terminator ends it; whichever comes first wins. A sequence split across chunks has
      // neither, and is simply skipped -- the next title arrives soon enough.
      const bell = value.indexOf(BELL, from);
      const st = value.indexOf(`${ESCAPE}${String.fromCharCode(92)}`, from);
      const ends = [bell, st].filter((i) => i !== -1);
      if (ends.length) found = value.slice(from, Math.min(...ends));
      at = value.indexOf(opener, from);
    }
  }
  return found;
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
  #ownedFile;
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
    // Where what-we-own is written down, so the instance that REPLACES a dead one can find
    // its leftovers. Null disables persistence, which is what most tests want.
    this.#ownedFile = deps.ownedFile ?? null;
    this.#openTerminal = deps.openTerminal === undefined ? defaultOpenTerminal() : deps.openTerminal;
    this.#spawnProcess = deps.spawnProcess ?? nodeSpawn;
    this.#replayBytes = deps.replayBytes ?? DEFAULT_REPLAY_BYTES;
  }

  /**
   * Start a process on behalf of a service.
   *
   * Reads as the sequence it is: refuse, spawn, record, wire, hand back. Each step below is its own
   * method because this was one 88-line function and the shape was buried in it — and the shape is the
   * part somebody needs when they come to change one step without disturbing the others.
   *
   * @param {{service: string, fileText: string, command: string, args: string[], cwd?: string, env?: object}} spec
   *   `fileText` is the launcher's contents, which the allowlist judges. It is passed rather than read
   *   here so the decision stays testable without a filesystem, and so the caller cannot hand us a
   *   path whose contents changed between the check and the spawn.
   */
  async start(spec) {
    this.#refuseUnlessAllowed(spec);

    const useTerminal = typeof this.#openTerminal === "function";
    const child = this.#spawnChild(spec, useTerminal);
    const entry = this.#registry.add({
      service: spec.service,
      pid: child.pid ?? 0,
      terminal: useTerminal,
      // Passed through, never interpreted. The caller names its own work; this only shows it.
      label: spec.label,
      // Stamped here because this is the moment the process began. Uptime is derived from it
      // where a clock is allowed -- the view is not such a place.
      startedAtMs: Date.now(),
    });
    // Written down BEFORE anything can go wrong with the wiring below. A process we started and
    // failed to record is exactly the orphan this file exists to prevent.
    if (this.#ownedFile) {
      recordStarted(this.#ownedFile, {
        id: entry.id,
        pid: child.pid ?? 0,
        service: spec.service,
        launcher: spec.command,
        startedAt: Date.now(),
      });
    }

    // `exited` IS SEPARATE FROM `exitCode` AND HAS TO BE. A signalled process reports a NULL code --
    // that is what Node means by it -- so "has it ended" cannot be read off the code without calling
    // every SIGKILL a live process. Before 2026-08-26 the code was coerced to 0 and this flag was not
    // needed because nothing could tell the difference; that coercion is the defect this fixes.
    const stream = {
      buffer: "",
      listeners: new Set(),
      exitListeners: new Set(),
      exited: false,
      exitCode: null,
      exitSignal: "",
    };
    this.#streams.set(entry.id, stream);
    this.#live.set(entry.id, child);

    const handleListeners = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });

    this.#wireChild({
      child,
      useTerminal,
      emit: this.#makeEmitter(stream, handleListeners, entry.id),
      finish: (code, signal) => {
        // The exit time comes from HERE, where the exit happened; the registry stays clock-free.
        this.#registry.remove(entry.id, { atMs: Date.now() });
        this.#live.delete(entry.id);
        if (this.#ownedFile) recordStopped(this.#ownedFile, entry.id);
        // The stream OUTLIVES the process deliberately, so a consumer that attaches just after an exit
        // still sees why it exited. stop() is what releases it; the reaper calls stop().
        //
        // The code is REMEMBERED as well as delivered, so a subscriber arriving after this moment is
        // told rather than left on an open, silent stream -- which reads exactly like a live process.
        //
        // NULL IS KEPT, and this line used to read `code ?? 0`. Node hands a null code EXACTLY when a
        // signal killed the process, so coercing it manufactured a CLEAN EXIT for every killed agent
        // and there was no signal beside it to contradict the claim. A consumer downstream then
        // recorded "exited with code 0" for a worker something had killed -- worse than the silence it
        // replaced, because a 0 reads as evidence. The two facts travel as two fields for the same
        // reason: "killed by SIGKILL" and "exited 0" are different answers.
        stream.exited = true;
        stream.exitCode = typeof code === "number" && Number.isFinite(code) ? code : null;
        stream.exitSignal = signal == null ? "" : String(signal).trim();
        for (const onExit of stream.exitListeners) {
          try {
            onExit(stream.exitCode, stream.exitSignal);
          } catch {
            // A broken console must not stop the others being told, and must not take the environment
            // down with it. Delivery here is best-effort, same as output.
          }
        }
        stream.exitListeners.clear();
        resolveExit(stream.exitCode);
      },
    });

    return {
      id: entry.id,
      pid: entry.pid,
      terminal: useTerminal,
      service: spec.service,
      exited,
      onOutput: (listener) => handleListeners.push(listener),
      write: (data) => (useTerminal ? child.write(data) : child.stdin?.write(data)),
    };
  }

  /** Throws BEFORE anything is spawned or recorded. A refused start must leave no trace. */
  #refuseUnlessAllowed(spec) {
    const verdict = mayExecute(spec.fileText);
    if (!verdict.ok) {
      throw new Error(`aify-env refused to start ${spec.command}: ${verdict.reason}`);
    }
  }

  #spawnChild(spec, useTerminal) {
    if (useTerminal) {
      return this.#openTerminal(spec.command, spec.args ?? [], { cwd: spec.cwd, env: spec.env });
    }
    return this.#spawnProcess(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env,
      // stdin PIPED, not ignored. Ignoring it means a piped process can never be typed at, which makes
      // the fallback path a viewer rather than a console -- and a caller wanting to delegate would have
      // to keep a local terminal around just for the writing.
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** Buffers for late subscribers, then fans out. Delivery is best-effort in both directions. */
  #makeEmitter(stream, handleListeners, id = "") {
    return (chunk) => {
      const text = String(chunk);
      // THE TITLE THE PROCESS SET, taken as it goes past. Only the process knows what it is doing, and
      // it says so in an OSC sequence that every terminal already honours -- so this reads what is
      // there rather than asking anyone. Best-effort by construction: a process that never sets a
      // title simply has none, which the view shows as empty rather than inventing something.
      if (id) {
        const title = lastTerminalTitle(text);
        if (title !== null) this.#registry.setTitle(id, title);
      }
      // Keep the MOST RECENT bytes. Truncating from the other end gives a console the start of a
      // session and none of what is happening now, which is the half nobody needs.
      stream.buffer = (stream.buffer + text).slice(-this.#replayBytes);
      for (const listener of handleListeners) listener(text);
      for (const listener of stream.listeners) {
        try {
          listener(text);
        } catch {
          // A broken console must not be able to take down an agent.
        }
      }
    };
  }

  /**
   * The two shapes a child can have, and the only place that difference is handled.
   *
   * Everything above this line is identical for a terminal and a pipe, which is the point: a caller
   * reading `start()` should not have to hold both variants in their head to follow the sequence.
   */
  #wireChild({ child, useTerminal, emit, finish }) {
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
        // node-pty hands BOTH, and the signal was dropped here until 2026-08-26.
        finish(event?.exitCode, event?.signal);
      });
      return;
    }
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    // Node's `close` event is `(code, signal)`. The second argument was discarded AT THIS CALL SITE,
    // which is where the information about a killed agent was lost: everything downstream was then
    // reading a null code that the line above coerced to zero. One of the two halves of that defect.
    child.on("close", (code, signal) => finish(code, signal));
    // A spawn that fails (missing binary) must resolve the same way, or a caller awaits forever.
    // No signal: nothing killed it, it never ran.
    child.on("error", () => finish(-1, ""));
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
  subscribe(id, listener, onExit) {
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

    // EXIT IS OPTIONAL, because every caller before this passed one argument and most want output
    // alone. A consumer driving an agent's lifecycle needs it: without exit on the wire, a delegated
    // process that died is indistinguishable from one that is thinking.
    if (typeof onExit === "function") {
      // THE FLAG, NOT THE CODE. This read `stream.exitCode !== null`, which was a correct test only
      // while the code was coerced to 0 -- now that a signalled process keeps its null code, testing
      // the code would leave every SIGKILLED process looking live to a late subscriber, on a stream
      // that never ends. That is the exact failure this whole change exists to end, so the fix must
      // not reintroduce it one function away.
      if (stream.exited) {
        // Already gone. Told immediately rather than left on a silent stream, which is the normal case
        // for a console that attaches late.
        queueMicrotask(() => {
          try { onExit(stream.exitCode, stream.exitSignal); } catch { /* its own failure */ }
        });
      } else {
        stream.exitListeners.add(onExit);
      }
    }

    return () => {
      stream.listeners.delete(listener);
      if (onExit) stream.exitListeners.delete(onExit);
    };
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
    this.#registry.remove(id, { atMs: Date.now() });
    if (this.#ownedFile) recordStopped(this.#ownedFile, id);
    // Buffers must not outlive the processes they belong to, or a long-running environment accumulates
    // one per process it has ever started: a leak with a slow fuse.
    this.#streams.delete(id);
    if (!child) return;
    const pid = child.pid;
    try {
      child.kill();
    } catch {
      // Already gone. The registry is the thing that had to be right, and it is.
    }
    // AND ITS CHILDREN. A launcher is a script and the agent is a child of it, so killing only the
    // direct child stops the wrapper and leaves the agent running -- found by cleaning up after the
    // orphan tests and finding `sleep` processes whose parents were already dead.
    killTree(pid);
  }

  list() {
    return this.#registry.list();
  }

  /**
   * What this environment has started and when one last exited. Distinct from `list()`, which is
   * only what it holds NOW -- and an empty `list()` is the state an operator misreads as a fault.
   */
  history() {
    return this.#registry.history;
  }
}
