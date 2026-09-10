# Herdr attach client

This optional command opens an existing aify-env terminal-backed worker in a new Herdr workspace. It does not start workers, install software, start either server, stop the daemon, or own the fleet.

## Full integration remains blocked

The requested integrated mode would launch Herdr with the actual env daemon in the first workspace, list available agents before they have terminals, start them through the service, synchronize worker workspaces on spawn and kill, and preserve aify identity and native context on cold restore. The command below does not implement that mode.

Stock Herdr 0.9.0 builds its native agent list from existing terminal panes. Its native restore constructs agent CLI commands rather than restoring aify-owned launches. Full integration is on hold while extension options are evaluated, including an external controller and upstream extension points. The manual adapter is not its replacement or completion; retaining stock Herdr does not establish that a permanent fork is the only alternative.

## Requirements and usage

The supported configuration is Windows, Herdr 0.9.0 protocol 22, and PowerShell as Herdr's pane shell. Configure this in Herdr's own configuration before starting Herdr:

```toml
[terminal]
default_shell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
```

Install Herdr separately using <https://herdr.dev/docs/quick-start/>. Keep the complete Windows package, including `conpty/`. The adapter checks PATH and `%LOCALAPPDATA%/Programs/Herdr/bin/herdr.exe` by reading the filesystem; it never runs the detected executable, even for a version check.

Start/manage Herdr separately, outside this command. Use the same `HERDR_SOCKET_PATH` with which that server was started. The aify-env daemon must also already be running outside Herdr. For example, in PowerShell, substitute your existing daemon's port and Herdr socket name:

```powershell
$env:AIFY_ENV_ENDPOINT = 'http://127.0.0.1:12345'
$env:HERDR_SOCKET_PATH = 'my-herdr.sock'
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
- No locked daemon pane, unopened-worker sidebar, service start picker, agent-status synchronization, or automatic Herdr TUI launch is provided. The numbered picker lists existing terminal workers only.
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
