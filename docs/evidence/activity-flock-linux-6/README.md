# Native Linux checkpoint locking

PROVEN on Linux container overlayfs with Node 22.20.0 and 26.7.0 at predecessor `20f0782e6a935cf140698cdea9efced18cc53271`: each runtime passed five baseline and five restored cases. A compiling flock-bypass control failed both exclusion cases on forbidden persisted checkpoint bytes, with three other cases passing. There were no skips, cancellations or todos.

The real in-process flock covered live/dead owners and death before/after fsynced checkpoint replacement. Healthy arms recorded 15 successful calls and two EAGAIN refusals; mutants recorded no flock calls. No flock executable or unlocked fallback was used. Missing native support failed closed.

With the existing lockfile dependencies installed in an owned Linux container, sealed home/temp roots, an explicit `AIFY_WRAPPER_REPO` at `0de08cbd1ee6faf3a484bba2fb514ed0d117ce92`, and each exact native interpreter selected on PATH, run:

```sh
npm test -- tests/the-dashboard-plugin-serializes-activity-checkpoints.test.js
```

Disposable-container controllers, compiling mutation automation, syscall traces, native binaries, checkpoint snapshots and exact cleanup receipts stay in private ignored `.check-output` custody. This result does not qualify a successor by inheritance, other filesystems, reclamation, a live daemon or power-loss durability. Activity stays off.
