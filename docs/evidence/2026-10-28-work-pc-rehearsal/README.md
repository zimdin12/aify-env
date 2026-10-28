# Work-PC rehearsal: aify-env and herdr on Linux after a v0.5.7 upgrade (2026-10-28)

The question: on Steven's work PC (WSL, herdr wanted, upgraded from before 0.6), what happens after aify-comms'
[upgrade rehearsal](https://github.com/zimdin12/aify-comms/blob/main/docs/evidence/2026-10-28-upgrade-rehearsal/README.md)
stops, which is where aify-env would start? Debian bookworm in a container stands in for WSL. Throwaway containers
only (`aify-wpc-svc`, `aify-wpc-client`, network `aify-wpc-net`, volume `aify-wpc-data`); nothing on the host was
started, read or changed. There is no claude or hermes login anywhere.

`rehearse-env-and-herdr.sh` -> `rehearse-env-and-herdr.out` is one end-to-end run, including teardown and a by-name
check that all four are gone. `herdr-install.reviewed.sh` is herdr's official installer as downloaded and read
before it ran (sha256 `bf83668c…93dd`); the container ran exactly those bytes.

## What it showed

1. **The upgrade** is the comms rehearsal's, unchanged: three installer passes (approval digest, then the one
   printed `sudo` for Claude's channel policy, then complete).
2. **A v0.5 environment bridge still running hides a problem.** The v0.5.7 install starts none by itself; the
   script starts one as v0.5's bare `aify-comms` did. Before aify-env runs, the comms doctor's `env-bridge` row
   reads ✓ "1 online", answered by the 0.5.7 bridge, while `spawn-delegation` and `agent-state-publishers` fail.
   Starting aify-env SUPERSEDES it: the old bridge logs "was superseded by replacement bridge ... exiting" and
   exits by itself. The guide's "stop it first" is still the right order, but not stopping it does no harm the
   rehearsal could see.
3. **With aify-env running** (started bare, as an operator would): the comms doctor reads 14 passed, 3 skipped,
   including all three rows the comms rehearsal left failing. `aify-env doctor`: 19 passed, 1 unanswered,
   `claude-trust-roots` ("~/.claude.json could not be read as claude's config").
4. **A managed spawn with Claude never set up does not fail. It waits.** The daemon starts `claude-aify` for a
   probe agent, and its screen is Claude Code's first-run "Choose the text style" picker, before any login prompt.
   No doctor row says Claude has never been set up: `claude-login` passes with "no claude credentials on this
   host, so there is no login to age".
5. **Stopping the daemon takes the worker with it.** Before the stop, the tree is `aify-env` -> `claude-aify` ->
   `claude`; 20 s after a SIGTERM to the daemon none of the three is running. The two lines step 5 still lists are
   the listing's own shell, whose command line holds the words it searches for. An earlier run without `--init`
   showed the dead `claude` and `claude-aify` as `<defunct>` under a PID 1 that does not reap, which read as
   survivors; WSL's init reaps, which `--init` stands in for.
6. **herdr's official installer** chose v0.9.5 from the live manifest and verified it. The guide's reviewed
   reference is v0.9.0, and aify-env's `aify-env herdr` adapter documents Herdr 0.9.0 (protocol 22).
   `scripts/herdr-state.sh --probe` reads it as installed, runnable, 0.9.5. Its server fetches
   `herdr.dev/agent-detection/*` at runtime.
7. **`aify-env herdr` does not run on Linux**: exit 69, "This adapter currently supports Windows PowerShell panes
   only".
8. **`herdr-aify env` works on Linux in a real terminal.** With no terminal size it starts the instance (a herdr
   server, and aify-env in `w1:p1`), fails to attach ("zero-sized grid"), and DETACHES, leaving both running.
   `herdr-aify --status` then says `spent: true` for an instance that is running. A second `herdr-aify env` in a
   120x40 terminal attaches to it and shows aify-env's view; `herdr-aify env --stop` says "confirmed gone" and
   nothing is left.
9. **`aify-herdr-pane install`** links the restore plugin, and `herdr plugin list` shows it enabled.

## Not shown here

- WSL itself: its init, `/mnt/c` paths, Windows-side `claude` logins and `WSLENV` are not in a container.
- A logged-in agent doing work; the restore plugin across a real reboot; hermes on Linux.
- Herdr inside a real terminal emulator: the attach was observed through `script` in a 120x40 pseudo-terminal.

## Reproduce

```bash
REHEARSE_DIR=<scratch dir, Windows form on Git Bash: C:/...> AIFY_COMMS_REPO=<comms checkout> bash rehearse-env-and-herdr.sh
```

It uses the image of the running `aify-comms-service` container as "today". `KEEP=1` leaves the containers up.
