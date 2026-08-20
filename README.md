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

## Terminals, and a leak worth knowing about

A real terminal is what lets a console render a TUI, so `aify-env` prefers one and falls back to piped
stdio. It always says which it got -- on the handle, in `/health`, and at startup -- because a consumer
left to infer it from output that looks slightly wrong will infer it wrong.

`node-pty` is an OPTIONAL dependency. A host where the native module will not build still gets an
environment; it gets one without terminals, and the doctor reports that as a real capability loss
rather than as a shrug.

**Measured, on Windows:** a node-pty child leaves a `PipeWrap` handle alive after it exits. The runner
calls `destroy()`, which frees the MessagePort and does **not** free that PipeWrap. Two consequences,
both real:

- any process that spawns a terminal never exits by itself, which is why the real-terminal test runs
  out of process and why every other runner test names the path it wants instead of taking whatever
  the machine happens to have installed;
- a long-running environment accumulates one of these per terminal-backed process. Worth watching if
  this ever spawns thousands.

`resolveExecutable` exists for the same family of reasons: `child_process` searches PATH and node-pty
does not, so an unresolved `bash` comes back as `File not found:` and, through the daemon, as a 500
carrying no clue at all.

## What it does today

```
aify-env            run the environment on 127.0.0.1:8801
aify-env-tui        a live view: services, owned processes, its own traffic
aify-doctor         passed / failed / unanswered, with its own exit statuses
```

Over the wire (`docs/PROTOCOL.md`): start, stop, list, health, **output** as server-sent events with a
bounded replay for consumers that attach late, **input**, and **resize** — which refuses when there is
no terminal rather than silently doing nothing.

Not built, and not by accident: nothing here answers questions about AGENTS. It knows which processes
it started and whether they are alive. Alive is not working.

The plan it is built against lives in the aify-comms repo at
`docs/superpowers/plans/2026-08-20-aify-env.md`, with the architecture and its evidence in
`docs/AIFY_ENV_BOUNDARY.md`.

## Tests

```bash
npm test
```

Several of them exist because a component observed only in its empty or failing state has not been
observed:

- the allowlist is fed a REAL launcher rendered by the `aify-wrapper` package next door, because every
  other case in that file is hand-written text that would keep passing if the real marker line changed;
- `aify-doctor` is run against a live environment AND a stopped one in the same run, because a checker
  seen only saying no cannot be trusted when it says no;
- the view is rendered with a real process in it, because a perfect empty frame proves the renderer and
  nothing about the snapshot ever being filled in;
- the real terminal path runs out of process, because node-pty leaves a handle behind and anything that
  spawns one never exits by itself.
