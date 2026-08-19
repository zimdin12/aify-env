# aify-env

The environment tier: **one process on a host that owns the processes and terminals**, so more than
one service can start agents on that machine without two spawners fighting over the same PTYs.

Nothing here knows what a message is, what a dispatch is, or whether an agent is thinking. It knows
which processes it started and whether they are alive. **Alive is not working** — status belongs to
whatever service owns agent semantics, and deriving it in two places is how two answers start
disagreeing.

## Why it exists

Spawning used to live inside a coordinating service. That is fine with one service and impossible with
two: the second either runs its own spawner — two PTY owners on one host, each reaping by its own rules
— or depends on the first, which is the coupling a split is supposed to remove.

So the capability moves out. Services ask; this owns.

## What it will run, and how that is decided

**A file may be executed if it carries the harness contract marker** every launcher already has:

```
HARNESS_WRAPPER_VERSION="0.6.0"
```

Derived, not listed. Installing a launcher enrols it, nobody maintains a policy file, and a new harness
works without anyone remembering to add it. A list you must remember to update is a defect with a delay
on it.

**The marker is READ out of the file, never asked for by running it.** Deciding whether to execute
something by executing it is the shape of a bug this family of tools has already paid for: asking a
pre-contract launcher `--check` forwards the flag to the runtime and starts it.

The bound this gives you is honest rather than total. The marker says "this speaks the harness
contract", not "this is safe". Anything that can write to your launcher directory can write a marker —
locally that is already game over, and on a shared host the installed set needs recording at install
time as well.

## Status

Early. `lib/allowlist.mjs` is the first piece. The plan it is being built against lives in the
aify-comms repo at `docs/superpowers/plans/2026-08-20-aify-env.md`, with the architecture and its
evidence in `docs/AIFY_ENV_BOUNDARY.md`.

## Tests

```bash
npm test
```

One of them renders a real launcher from the `aify-wrapper` package next door and requires the
allowlist to accept it. A predicate that cannot accept the genuine article is worth nothing, and every
other case in that file is hand-written text that would keep passing if the real marker line changed.
