# Herdr and aify-env

There are two ways to see aify-env's workers in Herdr, and they have opposite lifetimes.

## The dedicated instance: `herdr-aify env`

aify-wrapper's `herdr-aify env` starts a Herdr of its own, with its own socket and its own config and
state roots, runs the actual aify-env daemon in its first space with `--instance-context`, and
attaches the Herdr TUI. The launcher owns the lifetime; aify-env owns the workers.

- **A space per worker.** When a service plugin starts a worker (from the view's `s` start list or from
  the service's dashboard), the daemon opens a Herdr pane for it that runs `aify-env attach --id <id>`
  against the worker that is already running (`lib/herdr-pane-opener.mjs`). The worker keeps its PTY,
  its output keeps streaming to the web console, and closing the pane does not stop it. A process
  started through the generic `POST /processes` route gets no space.
- **The pane goes with the worker.** When the worker exits, however it exits, its pane is closed. Only
  that pane: an unrelated pane an operator moved into the same space is left alone.
- **The view gives way.** In this mode the daemon's view offers no console pane and no Enter attach,
  because every worker already has a space; the actions menu offers `stop`.
- **Leaving ends everything.** Closing or detaching from that Herdr session ends the launcher, the
  environment and every worker in it. That is the mode's intended lifetime, and it is the opposite of
  plain `herdr-aify`, where detaching is harmless.

Only a daemon started with an instance context opens spaces. A daemon started from a pane of your
ordinary Herdr inherits a `HERDR_SOCKET_PATH` too, and that socket is not its own, so it opens none.
The mode, its install step and its limits are documented in
[aify-wrapper's HERDR.md](https://github.com/zimdin12/aify-wrapper/blob/main/HERDR.md).

## One worker into a Herdr you already run: `aify-env herdr`

This optional command opens an existing aify-env terminal-backed worker in a new Herdr workspace. It does not start workers, install software, start either server, stop the daemon, or own the fleet.

## Requirements and usage

The supported configuration is Windows, Herdr 0.9.0 protocol 22, and PowerShell as Herdr's pane shell. Configure this in Herdr's own configuration before starting Herdr:

```toml
[terminal]
default_shell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
```

Install Herdr separately using <https://herdr.dev/docs/quick-start/>. Keep the complete Windows package, including `conpty/`. The adapter looks where aify-wrapper's `herdr-aify` looks, in the same order: `HERDR_BIN_PATH`, Herdr's standalone package (`HERDR_HOME`, default `~/.herdr`, then `packages/standalone/current` or the newest release), `HERDR_INSTALL_DIR` (default `%LOCALAPPDATA%/Programs/Herdr/bin`), then PATH. At an ordinary Windows prompt Herdr is usually not on PATH. It reads the filesystem only and never runs the detected executable, even for a version check; a refusal lists every place it looked.

Start/manage Herdr separately, outside this command. Use the same `HERDR_SOCKET_PATH` with which that server was started. On Windows Herdr 0.9.0 uses a filesystem socket (its own default is `...config\herdr\herdr.sock`), so give an absolute `.sock` path: aify-wrapper measured Herdr refusing a named pipe (`\\.\pipe\...`) with `PermissionDenied`. A bare name is still mapped to a named pipe by this adapter, which will only reach a server that is listening on one. The aify-env daemon must also already be running outside Herdr. For example, in PowerShell, substitute your existing daemon's port and Herdr socket name:

```powershell
$env:AIFY_ENV_ENDPOINT = 'http://127.0.0.1:12345'
$env:HERDR_SOCKET_PATH = 'C:/Users/me/.config/herdr/herdr.sock'
aify-env herdr worker-label
# Or display a numbered picker from the real daemon process list:
aify-env herdr
```

From this checkout, use `node bin/aify-env.mjs herdr worker-label` instead of the installed command. Exact process IDs also work. Duplicate labels are refused. The initial choice resolves once to an ID; refresh and the generated `attach --id <process-id>` command never fall back to labels if that ID disappears. Public `aify-env attach --id <process-id>` selects only that literal ID, while ordinary `attach worker-label` retains label convenience. The picker requires a terminal, refreshes the worker list after selection, and accepts Enter to cancel. There is no implicit default endpoint or socket. Only literal IPv4 loopback HTTP endpoints are accepted. This release does not support remote daemons or other pane shells.

The command creates and focuses one workspace, validates its foreground shell through Herdr's API, and submits the existing `aify-env attach` client. Paths and the endpoint are single-quoted PowerShell data inside an encoded command. Success reports the pane and worker IDs and means the command was submitted, not that an agent has become ready. Inspect the pane for attach errors if the worker exits during startup. If creation succeeds but submission fails, the command names the pane and leaves it for inspection rather than closing a potentially changed pane.

## Ownership and limits

- Ctrl-] detaches the attach client and returns to the pane shell. It does not stop the worker.
- Closing an attached pane ends its local clients, not the worker or external daemon. Repeating the command attaches again to the same worker.
- A worker exit appears in the pane as an exit message. The pane returns to its shell.
- Closing the last Herdr pane may create a replacement shell. Herdr owns that shell.
- This command starts nothing and launches no Herdr TUI; its numbered picker lists existing terminal workers only. Starting agents, a space per worker and the Herdr TUI launch belong to `herdr-aify env`, above.
- Verification uses Windows PowerShell and a synthetic Node worker. PowerShell Core is accepted by the shell check but was not exercised. Real agent credentials, agent readiness, long-running sessions, and UI performance were not tested.
- Herdr 0.9.0 has a Windows shutdown limitation: `src/platform/windows.rs::signal_processes` opens a handle with `PROCESS_QUERY_LIMITED_INFORMATION` and calls `TerminateProcess`, which requires termination access. An idle replacement shell can survive server shutdown. This adapter does not patch upstream or kill Herdr-owned processes in normal use. Do not interpret a disappearing pane or server process as proof that every Herdr shell exited.

## Verification

Run focused checks with:

```text
node --test tests/herdr-client.test.js
node tests/manual/herdr-stage0.mjs C:/path/to/complete/herdr.exe
```

The opt-in real Windows test uses UUID-scoped homes, config and named pipes, a separate aify-env daemon on an ephemeral port, an owned Node worker and a real Herdr TUI in ConPTY. It invokes the shipped dispatcher, reads worker output through Herdr, sends input, resizes the actual TUI and requires a changed worker terminal size. It closes an attached live pane, requires the local client processes to exit and the same worker to remain alive, reattaches, sends more input, then requires a clean worker exit.

The fixture's PowerShell supervisor creates the fixture root suspended, assigns it to a non-breakaway Windows Job Object, then resumes it. It retains the creation handles and terminates that owned job in finally, including Herdr's surviving replacement shell. Assignment failure never resumes the fixture. Lifecycle assertions run inside the fixture before job cleanup, so termination cannot manufacture pane-client exit or worker survival. Separate receipts require zero active job processes and both named pipes unavailable. No inherited service credentials or default registry are used. Receipts and TUI output remain under `.local/herdr-stage0/run-<uuid>/` for review.

The earlier diagnostic implementation and failing fixture were preserved under `.local/herdr-preserved/`; the original `probe-output-10.txt` remains unchanged. The real composed test, rather than mocks, is the authority for transport and lifecycle behavior. Automated picker keystroke coverage is not included.
