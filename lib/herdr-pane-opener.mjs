// Opening a Herdr space for a worker a SERVICE PLUGIN just started in a dedicated instance.
//
// PLUGIN STARTS ONLY, and the scope is deliberate. The hook sits on `PluginProcesses.start`, which is
// how every agent the operator starts from the picker or the dashboard arrives. The daemon's generic
// `POST /processes` route calls the Runner directly and gets no space: it is a process API for any
// caller, and giving every process started through it a window would be a change to that API, not a
// completion of this feature. Named here because review found the earlier wording claimed "a worker
// this environment just started", which that route contradicts.
//
// WHY IT EXISTS. `herdr-aify env` runs this daemon inside a Herdr it controls, and the spaces were
// the operator's whole reason for the mode: "lets that aify-env manage/spawn/kill other spaces".
// Started from the picker, two agents came up and no space appeared -- they ran as ordinary children
// of a daemon that happened to live in a pane, which is indistinguishable from running outside Herdr.
//
// IT ATTACHES, IT DOES NOT RE-RUN. The pane runs `aify-env attach --id <id>` against a worker that is
// ALREADY RUNNING, so the process stays this daemon's: it keeps its PTY, its output keeps streaming
// to the dashboard console, and closing the pane does not stop the agent. Starting the agent IN the
// pane instead would hand its PTY to Herdr and take the web console with it, and a visible TUI in the
// dashboard is a standing hard requirement rather than a preference.
//
// IT DRIVES THE `herdr` BINARY, and that is forced rather than chosen. `lib/herdr.mjs` speaks the
// socket protocol directly and is explicitly "never invokes a binary" -- but on Windows Herdr's
// socket is an AF_UNIX FILE, and Node's `net.connect` treats a path as a named pipe: connecting to
// the very Herdr this daemon is running inside fails with `ENOTSOCK`. Measured, against a live
// instance. The CLI has no such problem because it is not Node.
//
// AND THE COMMAND IS THE HOST'S. On Windows `attachCommand` produces one encoded
// `powershell.exe -EncodedCommand ...` line, which can be typed into whatever shell a pane happens to
// be running -- where the socket adapter refused any pane whose shell was not PowerShell. Elsewhere it
// is a POSIX line. It was the Windows one everywhere until WSL showed PowerShell in every pane.
//
// AND IT CLOSES THE WORKER'S PANE WHEN THE WORKER GOES. The operator, after the first working spawn:
// "it seems that killing just killed process in that space, but it did not kill the space where agent
// was running." The exit is taken from the RUNNER rather than from the stop call, so a worker that
// crashes or is killed from outside takes its pane with it too.
//
// THE PANE, NOT THE WORKSPACE, and that is what makes the close safe. This closed the WORKSPACE by id,
// which review showed would also destroy any unrelated pane an operator had moved into it -- a
// resident agent's session, say. Measured against Herdr 0.9.0 on 2026-09-13, on a private server:
// closing a space's LAST pane removes the space; closing ours while an unrelated pane shares the space
// leaves that pane and the space alone; and a pane moved into another space is still closed by the id
// it was created with. So one `pane close` does exactly the right thing in every case, and never
// touches anything this daemon did not create.
//
// ONLY IN A DEDICATED INSTANCE. An ordinary daemon started from a pane of the operator's own Herdr --
// or of the persistent `herdr-aify`, which is for residents and must not grow managed agents' panes --
// inherits a `HERDR_SOCKET_PATH` too. That socket is somebody else's, so the opener requires it to
// belong to this daemon's own invocation. Found by review.
//
// BEST EFFORT, ALWAYS. A pane is a convenience on top of a worker that is already up. Anything that
// goes wrong here is reported and swallowed: an agent running without its pane is a smaller failure
// than a start that reports failure because a window could not be drawn.

import path from "node:path";
import { spawnSync } from "node:child_process";

import { attachCommand, detectHerdr } from "./herdr.mjs";

/** How long to wait for a pane to have a shell before typing at it. 3s, in 100ms steps. */
const SHELL_ATTEMPTS = 30;
const SHELL_POLL_MS = 100;
/** One more try at a close that failed, this long after. One, because a pane is not worth a loop. */
const CLOSE_RETRY_MS = 2000;
/** Herdr's answer for a pane that is already gone -- which is the outcome a close wanted. */
const PANE_NOT_FOUND = "pane_not_found";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Run one `herdr` CLI call against this instance's socket and parse what it answers. */
function herdrCall(bin, argv, { socket, timeoutMs = 15000 }) {
  // NO `--json` FLAG. This CLI answers JSON on its own; passing one made every call fail, which
  // would have been every pane silently not opening.
  const result = spawnSync(bin, argv, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, HERDR_SOCKET_PATH: socket },
  });
  if (result.error) throw new Error(String(result.error.message || result.error));
  // A FAILING EXIT PUTS ITS BODY ON STDERR, measured: Herdr 0.9.0 leaves stdout empty and writes
  // `{"error":{"code":...}}` there. Reading stdout alone lost the code a caller branches on.
  const lastJson = (stream) => {
    try { return JSON.parse(String(stream || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop() || "null"); }
    catch { return null; }
  };
  const answer = lastJson(result.stdout) ?? lastJson(result.stderr);
  // EXIT 0 IS NOT SUCCESS on this CLI: it answers errors in the body. Both are checked.
  if (result.status !== 0 || answer?.error) {
    const failure = new Error(answer?.error?.message || answer?.error || String(result.stderr || "").trim() || `herdr ${argv[0]} failed`);
    failure.code = answer?.error?.code || null;
    throw failure;
  }
  return answer;
}

/** True when `socket` lives inside `root`. A socket elsewhere belongs to some other Herdr. */
function socketBelongsTo(socket, root) {
  if (!socket || !root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(socket));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The opener this daemon should use, or null when it is not running inside a Herdr it owns.
 *
 * NULL IS THE ORDINARY ANSWER. An aify-env started from a terminal has no Herdr socket, and one
 * started from a pane of any Herdr other than its own invocation's must not drive that Herdr.
 *
 * @param env           the process environment; `HERDR_SOCKET_PATH` is what makes a Herdr reachable
 * @param dedicatedRoot this daemon's own invocation root, from its instance context. The socket must
 *   live inside it. Absent -- every ordinary daemon -- means no opener at all.
 * @param base          this daemon's own endpoint, which the pane's attach command is pointed at
 * @param node          the interpreter the attach command runs
 * @param script        the aify-env entry point the pane runs
 * @param platform      the host, which decides the shell the attach command is written for
 * @param call          injected so a test drives the whole path without a Herdr, a pane or a binary
 * @param watchExit     how this opener learns the worker is gone, so its pane goes with it. Returns
 *   null when there is no such worker any more, which means it has already gone.
 * @param defer         injected timer, so a close runs outside the exit notification and a retry can
 *   be driven by a test without waiting
 */
export function paneOpenerFor({
  env = process.env,
  dedicatedRoot = null,
  base,
  node,
  script,
  platform = process.platform,
  cwd = process.cwd(),
  log = () => {},
  call = herdrCall,
  bin = null,
  watchExit = null,
  defer = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  const socket = env?.HERDR_SOCKET_PATH;
  if (!socket || !base || !node || !script) return null;
  if (!socketBelongsTo(socket, dedicatedRoot)) return null;
  const binary = bin || env?.HERDR_BIN_PATH || detectHerdr(env);
  if (!binary) return null;

  /** Close one pane this opener created. True when it is gone, whether by this call or before it. */
  const closePane = (paneId, name) => {
    try {
      call(binary, ["pane", "close", paneId], { socket, cwd });
      log(`herdr: closed ${paneId}, the pane for ${name}`);
      return true;
    } catch (error) {
      if (error?.code === PANE_NOT_FOUND) return true;
      log(`herdr: ${paneId} outlived ${name} (${error?.message || error})`);
      return false;
    }
  };

  /**
   * Close it OUTSIDE whatever called us, and try once more if that fails.
   *
   * DEFERRED because the close is a blocking CLI call and the exit notification that asks for it
   * carries other workers' business; a slow Herdr must not hold that up. RETRIED ONCE because a
   * pane left behind by one busy moment is exactly the leftover this exists to prevent.
   */
  const closeSoon = (paneId, name) => {
    defer(() => {
      if (!closePane(paneId, name)) defer(() => { closePane(paneId, name); }, CLOSE_RETRY_MS);
    }, 0);
  };

  return async function openSpaceFor(record) {
    // TERMINAL-BACKED ONLY, the same filter the manual adapter applies: a worker with no PTY has
    // nothing for a pane to attach to, and opening one would leave an empty shell on the screen.
    if (!record || record.terminal !== true || !record.id) return null;
    const name = record.label || record.id;
    //: Set the moment a pane exists, so a failure after that point still cleans it up.
    let paneId = null;
    try {
      const command = attachCommand({ node, script, base, id: record.id, platform });
      const created = call(binary, ["workspace", "create", "--label", `aify-env ${name}`], { socket, cwd });
      paneId = created?.result?.root_pane?.pane_id || created?.result?.pane?.pane_id || null;
      if (!paneId) throw new Error("herdr created no pane");
      const workspaceId = created?.result?.workspace?.workspace_id || created?.result?.root_pane?.workspace_id || null;

      // WAIT FOR THE SHELL BEFORE TYPING AT IT. A pane exists before anything is listening in it, and
      // `pane run` TYPES: text sent into that window is simply lost, and the CLI still reports
      // success, so the failure is a space that opens and then sits empty. Measured exactly that.
      // The socket adapter polls for the same reason; dropping the poll is what reproduced it.
      let ready = false;
      for (let attempt = 0; attempt < SHELL_ATTEMPTS && !ready; attempt += 1) {
        if (attempt) await sleep(SHELL_POLL_MS);
        const info = call(binary, ["pane", "process-info", "--pane", paneId], { socket, cwd });
        ready = Boolean(info?.result?.process_info?.shell_pid);
      }
      if (!ready) throw new Error(`no shell in ${paneId} to attach with`);

      // ONE ARGUMENT: `pane run` types its command text and Enter, and that is how Herdr documents it.
      call(binary, ["pane", "run", paneId, command], { socket, cwd });
      log(`herdr: opened a space for ${name} in ${paneId}`);
      if (watchExit) {
        // REGISTERED AFTER THE PANE IS RUNNING. The Runner tells a late subscriber about an exit that
        // already happened, so a worker that died during the shell poll still closes its pane.
        const watching = watchExit(record.id, () => closeSoon(paneId, name));
        // AND NO SUCH WORKER MEANS IT IS ALREADY GONE. The Runner answers null once a stream has been
        // released, so there is nothing left to tell us -- close now, or the pane stays for ever.
        if (watching === null) closeSoon(paneId, name);
      }
      return { paneId, workspaceId, workerId: record.id };
    } catch (error) {
      log(`herdr: no space for ${record.id} (${error?.message || error})`);
      // A PANE MADE BEFORE THE FAILURE IS CLOSED, not left as an empty space with the agent's name.
      if (paneId) closeSoon(paneId, name);
      return null;
    }
  };
}
