# Service launch roots

Launch roots are host policy for cooperative service-requested starts, not a sandbox against a local process that can edit the grants or call the local process API.

## Bounded entry points

`PluginProcesses.start` and the configured core lifecycle start use the host's live roots supplier. The daemon supplies `() => LAUNCH_ROOTS.current()` and its own Windows/POSIX flag independently of service data. An omitted or unanswerable authority refuses a start; constructors may still serve read-only/stop operations. Existing comms checks remain early, useful messages, not the sole enforcement point.

The host configures `PluginProcesses(runner, {cwdRoots, windows, currentCwd, ...})` and `createAgentLifecyclePorts({cwdRoots, windows, currentCwd, ...})`. `cwdRoots` is the host-owned array or live supplier, never a root list from a service request. `currentCwd` defaults to `process.cwd`; the daemon uses that default and tests may supply a fixture host directory.

The adapters preflight the actual prepared spec and supply Runner's optional per-call `admitSpawn` port. Runner invokes it after checkpoint-loading awaits and before `ManagedLifetimes.spawn`. The port returns only a working-folder string: it cannot replace command, arguments or the marker text already judged. An invalid return refuses before spawn. Replacements for Runner must honor this port; plain record-only test doubles establish ingress behavior, not late admission.

For an omitted/null cwd the final guard reads the host's current directory after its awaits and explicitly passes that exact checked value to spawn. Preflight does not freeze an early default. Supplied folders retain the existing lexical contract: slashes unified, case folded only on Windows, component boundaries respected, dot segments refused rather than resolved. No realpath or symlink grant is added. Roots are read through `rootsNow`; the same `workspaceWithinRoots` predicate remains the containment owner. The stored-roots reader's existing corrupt/unreadable-file behavior is unchanged: added roots are ignored, startup folder stays.

## Refusal and lifetime custody

`LaunchRootRefusal` is a typed pre-spawn failure (`code: LAUNCH_ROOTS_REFUSED`), not an error-message convention. Direct and invoked lifecycle starts retain it as refused; a restart still states that the old process stopped but was not restarted. Automatic cold-start admission converts only that type to its existing known-refusal result and still requires identity to remain cold before settling. Other exceptions, including a generic error bearing the same code/message, retain execution-unknown custody. The existing definition-lock failure classifier and effectsEntered boundaries are unchanged. No new lifecycle launch builder is added where composition was deliberately unavailable.

## Deliberate exemptions

Raw local `POST /processes` and Runner starts without `admitSpawn` remain unbounded, preserving the operator's `aify-env run` and launchers' `--shared` behavior. A defined-agent UI start is still a service/lifecycle start, not this raw-route exemption.

The dashboard provider and sweep do not use PluginProcesses: their own child runner is authorized by the watched-folder/real-path grant. That independent grant is preserved, not replaced by launch roots and not claimed race-free by this change.

This is a latest-observed policy check at the launch boundary, not an atomic filesystem authorization lease. Source publication does not activate the change; installation/restart and the joint switch remain operator-owned.
