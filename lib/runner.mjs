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

import { StringDecoder } from "node:string_decoder";
import { spawn as nodeSpawn } from "node:child_process";

import { mayExecute } from "./allowlist.mjs";
import { ProcessRegistry } from "./process-registry.mjs";
import { recordStarted, recordStopped } from "./owned-processes.mjs";
import { killTree } from "./kill-tree.mjs";
import { defaultIsAlive } from "./reaper.mjs";

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
    // WHICH KILL PATH THIS ENVIRONMENT WILL USE, reported rather than assumed.
    //
    // `AIFY_ENV_CONPTY_DLL=1` is an experiment an operator runs against a live fleet -- it selects the
    // node-pty backend whose `kill()` never enumerates a console -- and an experiment whose setting
    // cannot be observed is not an experiment. Setting the variable in the wrong shell, or before a
    // launcher that does not forward it, looks exactly like setting it correctly and the deaths
    // continuing. This is the difference between "the fix did not work" and "the fix was not on".
    return { available: true, reason: "", conptyDll: useConptyDll() };
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

/**
 * Should terminals use node-pty's conpty DLL backend?
 *
 * THE ESCAPE HATCH FOR THE CONSOLE-LIST KILL, off by default and switchable without a code change.
 *
 * node-pty's ConPTY `kill()` has two implementations and only one of them is dangerous. The default
 * forks a helper that ATTACHES TO THE CONSOLE of the pty's shell pid, lists every process in it, and
 * kills them all (`windowsPtyAgent.js:133-150`); with a dead or recycled pid that console can belong
 * to somebody else. The DLL branch does none of that -- it closes the input handle and kills the pty,
 * and never enumerates a console.
 *
 * OFF BY DEFAULT ON PURPOSE. The reaper fix in 2bac2c7 removes the only caller that could pass a dead
 * pid, and that repair has not yet been observed in the field. Turning both on at once would confound
 * the experiment: if the deaths stop, we would not know which change did it. Flip this only if they
 * continue.
 *
 * `conpty.dll` ships inside the package (`node-pty/build/Release/conpty/conpty.dll`), so this needs no
 * new dependency. On Linux and macOS the option never reaches anything -- `pty.spawn` builds a
 * `UnixTerminal`, which does not read it -- so setting it is harmless everywhere.
 */
export function useConptyDll(env = process.env) {
  return String(env.AIFY_ENV_CONPTY_DLL ?? "").trim() === "1";
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
    // Read at SPAWN time, not at module load, so the variable can be exported by whatever launches
    // this environment rather than having to be set before Node starts.
    useConptyDll: useConptyDll(),
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
        // THE LAUNCHER, NOT THE INTERPRETER THAT RUNS IT. `defaultVerify` decides whether a recorded
        // pid may be killed by asking whether the live process's command line CONTAINS this string,
        // so it has to be the part that identifies THIS process and no other.
        //
        // `spec.command` is the wrong half on Windows. A shebang launcher is spawned as
        // `bash.exe <launcher>` (see interpreterFor), so command is `bash.exe` -- shared by every
        // bash-launched process on the host. After pid reuse, a stranger's bash matched and was
        // killed with its whole tree. POSIX spawns the launcher directly, which is why only Windows
        // was exposed.
        //
        // Falls back to `spec.command` for a caller that sends no launcher: the old value, so a
        // record is never written without one, and `defaultVerify` refuses an entry with an empty
        // launcher outright.
        launcher: spec.launcher || spec.command,
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
      // A FACTORY, not one emitter: `#wireChild` needs a separate decoder per stream.
      makeEmit: () => this.#makeEmitter(stream, handleListeners, entry.id),
      finish: (code, signal) => {
        // The exit time comes from HERE, where the exit happened; the registry stays clock-free. The
        // CODE AND SIGNAL go with it: this is the only place in the whole chain that observes them
        // first-hand, and on the operator's host every tier downstream is days behind and drops them.
        this.#registry.remove(entry.id, {
          atMs: Date.now(),
          reason: "exited",
          // WHAT IT WAS SAYING WHEN IT WENT. An exit code alone cannot tell a crash from a kill: on
          // Windows an externally terminated process and a program that returned 1 are the same
          // number. The last bytes it emitted usually can -- a stack trace, a provider error, or
          // nothing at all mid-frame, which is itself the signature of an abrupt kill.
          //
          // Taken from the replay buffer that already exists, so this costs a slice and no new state.
          lastOutput: stream.buffer,
          exitCode: typeof code === "number" && Number.isFinite(code) ? code : null,
          exitSignal: signal == null ? "" : String(signal).trim(),
        });
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
      // THE SIZE THE PTY ACTUALLY HAS, asked of the pty rather than inferred from what was
      // requested. A caller that asked for nothing gets the opener's own default, and reading that
      // number back here is the only way to learn it without keeping a second copy of it -- and a
      // second copy of a default is a number that drifts silently the moment either side changes.
      //
      // Zero for a piped process, which has no terminal and therefore no size. That is a fact, not
      // a missing value: a caller must not record a width for something that has none.
      cols: useTerminal ? Number(child.cols) || 0 : 0,
      rows: useTerminal ? Number(child.rows) || 0 : 0,
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
      // THE REQUESTED SIZE REACHES THE PTY. It did not until 2026-09-03: this call passed `cwd` and
      // `env` only, so a caller that asked for a 157-column terminal silently got the opener's
      // default, and `cols` was computed, carried across the wire and dropped one frame short of the
      // thing it describes. Nothing failed -- the terminal simply was not the size anyone asked for,
      // and every consumer downstream reasoned from a width that was never true.
      //
      // ONLY A POSITIVE SIZE IS FORWARDED, which is the whole subtlety. Callers send `0` for "I do
      // not know" (`Number(control.cols) || Number(launch.cols) || 0`), and the opener defaults with
      // `options?.cols ?? 120` -- `??` substitutes for null and undefined but NOT for zero. Passing
      // the zero through would therefore replace a sane default with a zero-width PTY: a fix that
      // made things worse. Omitting the key instead lets the default apply exactly as before.
      return this.#openTerminal(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: spec.env,
        ...(Number(spec.cols) > 0 ? { cols: Number(spec.cols) } : {}),
        ...(Number(spec.rows) > 0 ? { rows: Number(spec.rows) } : {}),
      });
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
    // ONE DECODER PER STREAM, and it is what stops a split character becoming mojibake.
    //
    // `String(chunk)` decoded every chunk on its own. On the pty path node-pty hands back a string
    // and that was a no-op -- but `child.stdout.on("data")` and `child.stderr.on("data")` deliver
    // BUFFERS, and a UTF-8 character straddling a read boundary is then decoded as two partial
    // sequences and arrives as replacement characters. Measured:
    //
    //     original      "progress: \u273b done \u2500 100%"
    //     String(chunk) "progress: \ufffd\ufffd done \u2500 100%"
    //
    // Agents print box-drawing, spinners and progress glyphs constantly and every one is multi-byte,
    // so the only question was where the read boundary fell. This is B3's "encoding issues", which
    // had no repro since May.
    //
    // ONE DECODER PER ATTACHMENT, and this factory is called ONCE PER STREAM to get it. The first
    // version of this fix called it once per PROCESS and attached the single closure to both
    // stdout and stderr -- so one decoder carried bytes across two byte sequences and could
    // splice stdout's partial character onto stderr's next chunk, inventing a character neither
    // sent. That is the defect this fix exists to remove, and it survived the fix by hiding
    // behind the `stream` parameter, which is the registry's per-PROCESS record and not an OS
    // stream. A decoder handed a string returns it unchanged, so the pty path is unaffected.
    const decoder = new StringDecoder("utf8");
    const deliver = (text) => {
      if (!text) return;
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

    const emit = (chunk) => deliver(typeof chunk === "string" ? chunk : decoder.write(chunk));
    // THE LAST BYTES, when the stream closes mid-character. Without this they are dropped in
    // silence -- not even a replacement character -- and the last thing a process said is what
    // `#registry.remove` calls the only way to tell a crash from a kill.
    emit.end = () => deliver(decoder.end());
    return emit;
  }

  /**
   * The two shapes a child can have, and the only place that difference is handled.
   *
   * Everything above this line is identical for a terminal and a pipe, which is the point: a caller
   * reading `start()` should not have to hold both variants in their head to follow the sequence.
   */
  #wireChild({ child, useTerminal, makeEmit, finish }) {
    if (useTerminal) {
      child.onData(makeEmit());
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
    // ONE EACH. Sharing a decoder here is what made the encoding fix incomplete: a partial
    // character carried from one stream would be spliced onto the other's next chunk.
    const emitOut = makeEmit();
    const emitErr = makeEmit();
    child.stdout?.on("data", emitOut);
    child.stderr?.on("data", emitErr);
    // FLUSH ON CLOSE, so a final chunk ending mid-character is not silently dropped.
    child.stdout?.on("end", () => emitOut.end());
    child.stderr?.on("end", () => emitErr.end());
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
  /**
   * Stop a process and everything it started.
   *
   * `phase` IS FOR THE ONE FAILURE NOBODY CAN BOUND. Two calls below can block the event loop:
   * `killTree`, which no longer does, and `child.kill()`, which is node-pty's ConPTY kill and still
   * can -- its console-list helper's AttachConsole is unbounded, and no JS timer fires while it
   * runs. A shutdown wedged there prints nothing, times out on nothing, and reaches an operator as
   * "it froze at close again" with no way to tell which call it was in.
   *
   * So the caller may ask to be told BEFORE each blocking call rather than after it. Announcing
   * afterwards is worthless for exactly the case that matters: the line never runs.
   *
   * OFF BY DEFAULT, so an ordinary Stop stays silent. Only a teardown asks, because only a teardown
   * has an operator watching a screen that has stopped moving.
   *
   * @param {{phase?: (name: "console-kill"|"tree-kill"|"done") => void}} [options]
   */
  async stop(id, { phase = () => {} } = {}) {
    const child = this.#release(id, "stopped");
    if (!child) return;
    const pid = child.pid;
    // ALREADY DEAD? THEN NOTHING BELOW, and `#release` above has already done the safe half.
    //
    // The docstring on `#release` works this out in full for the REAPER and takes it off this
    // path entirely: against a dead pid `child.kill()` forks node-pty's console-list helper,
    // which ATTACHES TO THE CONSOLE of a number Windows may have recycled onto another agent.
    // What that analysis did not consider is that SHUTDOWN reaches here with dead pids too.
    //
    // OBSERVED ON THE OPERATOR'S MACHINE, 2026-08-27: the PC slept, both managed ptys died, and
    // SIGINT wedged `[aify-env] SIGINT: stopping 2 managed process(es)` for HOURS with both pids
    // already gone. `createShutdown` awaits these stops, and `Promise.allSettled` guards against
    // a rejection, not against a call that never returns -- so a hang here is a hang forever.
    //
    // A JS timeout would not have helped: AttachConsole on a wedged console blocks the event
    // loop synchronously, so nothing else gets to run. Not making the call is the only fix that
    // works, and it is also the correct one -- there is nothing to kill.
    if (!defaultIsAlive(pid)) return;
    // THE ORDER IS DELIBERATE, AND I TRIED IT THE OTHER WAY ROUND FIRST. Tree-killing by pid and
    // skipping `child.kill()` looked strictly safer -- it is what the sibling repo does, and it would
    // avoid node-pty's console-list kill entirely -- and it BREAKS Stop here.
    // `orphans-die-with-the-environment.test.js` caught the launcher's grandchild still running: on
    // ConPTY the pid this class holds is not the process whose tree contains the agent, and node-pty's
    // own kill is what reaches it, through that very console list. The idea was wrong and the suite
    // said so before it shipped.
    //
    // So the console-list kill stays, and its exposure is bounded from the other end instead. It is
    // dangerous only when the pid is ALREADY DEAD -- the helper's AttachConsole can then land on a
    // recycled number belonging to another agent. The reaper was the one caller that could only ever
    // pass a dead pid, and it no longer calls this at all.
    //
    // WINDOWS ONLY, for the record: node-pty guards that path with `if (this._useConpty)`. On Linux
    // and macOS it kills the process group and there is nothing here to be exposed to.
    // ANNOUNCED FIRST. This is the call that can take the loop with it.
    phase("console-kill");
    try {
      child.kill();
    } catch {
      // Already gone. The registry is the thing that had to be right, and it is.
    }
    // AND ITS CHILDREN. A launcher is a script and the agent is a child of it, so killing only the
    // direct child stops the wrapper and leaves the agent running -- found by cleaning up after the
    // orphan tests and finding `sleep` processes whose parents were already dead.
    // AWAITED, and it is what lets the shutdown deadline mean anything. This was a `spawnSync`
    // taskkill: up to ten seconds of BLOCKED event loop per process, during which no timer fires and
    // no line prints. The teardown's 5s deadline was armed and could not run.
    phase("tree-kill");
    await killTree(pid);
    phase("done");
  }

  /**
   * Tell this environment what the caller now calls a process it owns.
   *
   * A pass-through to the registry, exposed because the protocol layer talks to the runner and
   * never reaches past it -- the same reason `list()` exists.
   *
   * @returns {boolean} whether the process was found
   */
  relabel(id, label) {
    return this.#registry.setLabel(id, label);
  }

  /**
   * Let go of a process WITHOUT killing anything: the registry entry, the live handle, the buffer.
   *
   * THE HALF OF `stop()` THAT IS SAFE TO RUN ON SOMETHING ALREADY DEAD, and the reason it now exists.
   * The reaper reaps entries it has PROVEN dead -- `process.kill(pid, 0)` threw ESRCH -- and then
   * called `stop()`, whose last two acts are `child.kill()` and `taskkill /PID <pid> /T /F` against
   * that very pid. Against a dead process neither can achieve anything. On Windows both can do harm,
   * and the first is the worse one -- traced through node-pty 1.1.0's own source in this repo:
   *
   *   windowsPtyAgent.js:133  kill() under ConPTY forks `conpty_console_list_agent` with `_innerPid`
   *   conpty_console_list_agent.js:13  that helper calls getConsoleProcessList(shellPid), which
   *                             ATTACHES TO THE CONSOLE OF THAT PID and lists everything in it
   *   windowsPtyAgent.js:141  consoleProcessList.forEach(pid => process.kill(pid))
   *
   * Every pid in the returned list is killed. When `_innerPid` is ALIVE that list is this pty's own
   * console and the behaviour is correct. When it is DEAD -- which is precisely the case the reaper
   * hands over -- Windows may already have recycled the number onto another agent's process, the
   * helper attaches to THAT console, and node-pty kills its occupants. `taskkill /T` carries the same
   * recycling exposure a second time, on the tree of whatever now owns the pid.
   *
   * This repo's sibling already learned that lesson. aify-comms guards its own kill-by-pid fallback
   * with an identity check and says why: "the window where Windows may have RECYCLED it onto a live
   * sibling agent's worker". The reaper here had no such guard and did not need one -- it needs to
   * not kill at all.
   */
  #release(id, reason) {
    const child = this.#live.get(id);
    this.#live.delete(id);
    // NO CODE AND NO SIGNAL, deliberately. This runs when the reaper found a corpse or a caller asked
    // for a stop; neither observed the exit, and recording a zero here would turn "we found it gone"
    // into "it exited cleanly" -- the exact collapse the two fields exist to prevent.
    //
    // BUT THE LAST WORDS ARE STILL KNOWN, and that distinction is the point. The exit code is
    // genuinely unavailable here -- nobody watched the process end. The output is not: it is sitting
    // in the replay buffer this very function is about to delete. Dropping it threw away the only
    // evidence a reaped death ever leaves.
    //
    // Found the hard way on 2026-08-26: two workers died as `found already gone` twelve seconds after
    // a sibling died as `exited 1`, and the panel could show the sibling's final frame and nothing at
    // all for the two that mattered -- while their bytes were in memory the whole time.
    //
    // THE REASON IS RECORDED INSTEAD, and it is the discriminator the first real reading needed. On
    // 2026-08-26 the panel showed two deaths as "no exit reported", which already proved they were
    // REMOVED rather than observed exiting -- but not by whom. "somebody asked for a stop" and "the
    // reaper found a corpse" are different incidents with different culprits, and the record could not
    // tell them apart.
    this.#registry.remove(id, {
      atMs: Date.now(),
      reason,
      lastOutput: this.#streams.get(id)?.buffer ?? "",
    });
    if (this.#ownedFile) recordStopped(this.#ownedFile, id);
    // Buffers must not outlive the processes they belong to, or a long-running environment accumulates
    // one per process it has ever started: a leak with a slow fuse.
    this.#streams.delete(id);
    return child;
  }

  /** Public form of the above, for a caller that has already established the process is gone. */
  release(id) {
    this.#release(id, "reaped");
  }

  /**
   * Which instance of this environment minted the handles it is holding.
   *
   * A consumer keeps a handle across a restart -- aify-comms does it deliberately, holding a
   * terminal open rather than calling a live process dead while this environment is away. The id
   * carries the instance so a stale handle cannot match; this exists so an answer can NAME the
   * instance, which is the difference between \"your handle is old\" and \"that process is gone\".
   */
  instance() {
    return this.#registry.instance;
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
