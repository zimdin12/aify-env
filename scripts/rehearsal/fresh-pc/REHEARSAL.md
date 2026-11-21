# Fresh-PC rehearsal

**Run only after exact pins are reviewed and the operator prepares the guest.** The qualifying run is a cold online install over HTTPS on both native Windows and native WSL. No SSH, mirrors, warmed npm cache, live services, real client homes, or daemon starts. The work PC needs read access to the private Dashboard repository. Rehearse that access with a separate, short-lived HTTPS credential. Public anonymous HTTPS covers the wrapper lock check, not the entire install.

## Pin the four repositories

| Role | Required revision |
|---|---|
| Env | A successor to `f4d996a6e036240afd80a10777c22fd81a7f8009` with the qualified wrapper in `package.json#aifyWrapper`. |
| Wrapper | Data-only admission and the shared `skillDirectory` import, with the env dependency and lock pinned to `5b441ad4d13dc51cd15150010df7b89525cc39e8` or its reviewed successor. |
| Comms | #12 B and C, plus the qualified wrapper in the `mcp/stdio` manifest and lock. |
| Dashboard | `eb36e05f303684a8c371fa8fa06292c8ebe15098` or its reviewed successor with the declared skill and bridge bin. Its existing `5e91491a` reader pin is sufficient for `--check`. |

Fill `pins.template.json` with four full, published SHAs, the Dashboard repo slug and reviewed approval digests. Keep the new Comms skills tuple out of the blanket catalogue until the refusal arm has run. An unresolved pin or a fetch failure is not permission to use `main`, rewrite Git URLs, or edit a lock.

## Prepare and tear down

1. **Windows:** Use a Hyper-V Windows 11 VM with a clean checkpoint, not Windows Sandbox. The checkpoint lets you prepare pinned native tools and repeat the run without touching the work PC; nested virtualization lets the same VM host the WSL lane. Disable shared folders, clipboard and drive redirection. Name the guest and disposable account `aify-rehearsal-*`. **Teardown:** export only sanitized evidence; the operator reverts or destroys the guest.
2. **WSL inside that VM:** Import a fresh rootfs with `wsl --import aify-rehearsal-<id> <guest-only-vhd-dir> <verified-rootfs.tar> --version 2`. Set a disposable default user and a matching hostname. Write the following to `/etc/wsl.conf`, terminate only the new distro with `wsl --terminate aify-rehearsal-<id>` and reopen it. Verify ext4, no `/mnt/c`/Windows mount and no Windows PATH. **Teardown:** the operator runs `wsl --unregister aify-rehearsal-<id>` only after exporting evidence. This deletes the distro.

   ```ini
   [automount]
   enabled=false
   [interop]
   enabled=false
   appendWindowsPath=false
   ```

3. **Scratch services:** Use E5's exact-source build and run-owned DB volume pattern. Build pinned Comms and Dashboard, start required-key Comms, keyless Comms and required-key Dashboard. Give each lane its own three high loopback forwards (use the template ports); no host publishes. For WSL, put forwards in the imported distro, not in `/mnt/c` or on the operator's machine. Record the network/container and daemon-absence checks. Permit guest HTTPS only to GitHub, npm and approved dependency download hosts; block access to production endpoints, provider APIs and SSH. Do not change E5's existing stack. **Teardown:** operator removes only these labeled scratch services, volumes and forwards.
4. **Fixture root:** In each disposable profile, stage clean exact clones at `src/{env,wrapper,comms,dashboard}`, native Node >=24.15, npm, Git, Bash (Git Bash on Windows), pinned Claude/Codex >=0.160/Hermes, and `runtimes/hermes-agent` with its venv. Add native tool paths to `pins.json`; prepare sandbox/channel policy only, no provider login, launchers or skills. Set `keys/{comms,dashboard}.txt` to the same synthetic values the scratch services use: `rehearsal-<12 hex id>-<role>-<48 random hex>`. In the guest instead of the terminal, place a short-lived Dashboard-repo-only read token in the private `keys/dashboard-git.credential` Git credential-store file, in `https://x-access-token:<token>@github.com/<dashboardGitRepo>.git` format. No personal login, SSH entries or npm config. Only the guided child receives the URL-scoped helper; wrapper `npm ci` does not. Once checked, write `isolated-guest.json` containing `{id,host,platform,origins,noHostShares:true,envDaemonAbsent:true,network:"build-https-and-loopback-fixtures-only"}`. **Teardown:** operator revokes the token and discards the fixture root with the guest. Do not archive keys, caches, or client homes.

The driver reads the WSL config and current mount table, and checks profile, platform, paths, pins, origins and the preparation receipt. That receipt records the operator's inspection of network and daemon isolation; the script does not infer it from a successful connection.

## What the run proves

```sh
node scripts/rehearsal/fresh-pc/rehearse.mjs --preflight <fixture>/pins.json
node scripts/rehearsal/fresh-pc/rehearse.mjs --run <fixture>/pins.json
```

On each platform, the first gate runs unchanged wrapper `npm ci` with a cold cache, `GIT_ALLOW_PROTOCOL=https`, `GIT_TERMINAL_PROMPT=0` and Git trace. It records the lock's original resolution and exit status; any failure stops there. A green wrapper gate then runs the **whole** cold guided chain once for both services and all three clients with another fresh cache and sealed homes. The other arms prove refusal without approval/key, keyless operation, identical rerun, preservation of a byte-identical unmanaged tree, and standalone Comms without env. Keep `evidence/` for commands, statuses, spec/build receipts, skill digests, MCP initialize/list and hooks. No credential value is saved in those receipts.

Before qualifying, attach supervised runtime skill discovery, a launcher-started read-only MCP call for each service, and a scratch turn-start event; direct MCP and file reads alone do not prove these. Record a selected absent CLI as named pending/nonzero without that runtime's receipt. Re-run one later approved scratch revision that updates one skill and retires another; show unchanged bytes stable and edited local bytes refused. An unexplained failure, unknown pin, leaked key, second writer or missing observation leaves the rollout unqualified.

Validate the driver without installation with `npm test -- tests/fresh-pc-rehearsal.test.js`.
