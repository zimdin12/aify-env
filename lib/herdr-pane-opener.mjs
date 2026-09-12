// Opening a Herdr space for a worker this environment just started.
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
// AND TYPING AN ENCODED COMMAND REMOVES A LIMIT. `attachCommand` produces one base64
// `powershell.exe -EncodedCommand ...` token with no spaces or quotes to survive, so it can be typed
// into whatever shell a pane happens to be running -- where the socket adapter refused any pane whose
// shell was not PowerShell.
//
// BEST EFFORT, ALWAYS. A space is a convenience on top of a worker that is already up. Anything that
// goes wrong here is reported and swallowed: an agent running without its space is a smaller failure
// than a start that reports failure because a window could not be drawn.

import { spawnSync } from "node:child_process";

import { attachCommand, detectHerdr } from "./herdr.mjs";

/** How long to wait for a pane to have a shell before typing at it. 3s, in 100ms steps. */
const SHELL_ATTEMPTS = 30;
const SHELL_POLL_MS = 100;
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
  const text = String(result.stdout || "").trim();
  let answer = null;
  try { answer = JSON.parse(text.split(String.fromCharCode(10)).filter(Boolean).pop() || "null"); }
  catch { answer = null; }
  // EXIT 0 IS NOT SUCCESS on this CLI: it answers errors in the body. Both are checked.
  if (result.status !== 0 || answer?.error) {
    throw new Error(answer?.error?.message || answer?.error || String(result.stderr || "").trim() || `herdr ${argv[0]} failed`);
  }
  return answer;
}

/**
 * The opener this daemon should use, or null when it is not running inside a Herdr it can drive.
 *
 * NULL IS THE ORDINARY ANSWER. An aify-env started from a terminal has no Herdr socket and must not
 * grow one: this is the difference between "inside a dedicated instance" and "the host's daemon".
 *
 * @param env    the process environment; `HERDR_SOCKET_PATH` is what makes a Herdr reachable
 * @param base   this daemon's own endpoint, which the pane's attach command is pointed at
 * @param node   the interpreter the attach command runs
 * @param script the aify-env entry point the pane runs
 * @param call   injected so a test drives the whole path without a Herdr, a pane or a binary
 */
export function paneOpenerFor({
  env = process.env,
  base,
  node,
  script,
  cwd = process.cwd(),
  log = () => {},
  call = herdrCall,
  bin = null,
} = {}) {
  const socket = env?.HERDR_SOCKET_PATH;
  if (!socket || !base || !node || !script) return null;
  const binary = bin || env?.HERDR_BIN_PATH || detectHerdr(env);
  if (!binary) return null;

  return async function openSpaceFor(record) {
    // TERMINAL-BACKED ONLY, the same filter the manual adapter applies: a worker with no PTY has
    // nothing for a pane to attach to, and opening one would leave an empty shell on the screen.
    if (!record || record.terminal !== true || !record.id) return null;
    try {
      const command = attachCommand({ node, script, base, id: record.id });
      const created = call(binary, ["workspace", "create", "--label", `aify-env ${record.label || record.id}`], { socket, cwd });
      const paneId = created?.result?.root_pane?.pane_id || created?.result?.pane?.pane_id;
      if (!paneId) throw new Error("herdr created no pane");

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

      call(binary, ["pane", "run", paneId, ...command.split(" ")], { socket, cwd });
      log(`herdr: opened a space for ${record.label || record.id} in ${paneId}`);
      return { paneId, workerId: record.id };
    } catch (error) {
      log(`herdr: no space for ${record.id} (${error?.message || error})`);
      return null;
    }
  };
}
