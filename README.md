# aify-env

The environment tier: **one process on a host that owns the processes and terminals**, so more than
one service can start agents on that machine without two spawners fighting over the same PTYs.

Nothing here knows what a message is, what a dispatch is, or whether an agent is thinking. It knows
which processes it started and whether they are alive. **Alive is not working** — status belongs to
whatever service owns agent semantics, and deriving it in two places is how two answers start
disagreeing.

## Install

```bash
git clone https://github.com/zimdin12/aify-env
cd aify-env
npm install
```

`node-pty` is the only dependency that matters, and it is the one that can fail: it is a native module,
so a host without build tools gets a working install with NO TERMINALS. That is not a broken state and
aify-env does not pretend otherwise — processes run with piped stdio, a console cannot render a TUI for
them, and `aify-env-doctor` says so in as many words. Check before you trust it:

```bash
node bin/aify-env-doctor.mjs
```

Then run it:

```bash
node bin/aify-env.mjs
```

It listens on `127.0.0.1:8802`, LOOPBACK ONLY and deliberately: this runs programs on behalf of
whatever asks, so it is not something to expose. `--port 0` takes an ephemeral port when 8802 is taken.

The default was 8801 until 2026-08-20, which aify-comms publishes for its Dashboard Next. Two tiers on
one host is the topology this project exists for, so that was a collision by construction rather than
bad luck -- and on the machine where it was found, `curl 127.0.0.1:8801/health` returned
`{"status":"healthy"}` from the dashboard. `aify-env-doctor` refuses that impostor, because a real
environment reports the processes and terminals it owns; a defence is not a reason to keep a collision.

### On PATH, and updating

```bash
npm install -g .        # aify-env, aify-env-doctor, aify-env-tui
git pull && npm install -g .    # updating is the same command
```

Every command is named after the package, and a test enforces it. The doctor was called `aify-doctor`
until aify-comms turned out to install a different tool under that exact name -- two tiers on one host
is the whole point of the split, so whichever landed on PATH first would have silently shadowed the
other.

A running daemon keeps the code it loaded at boot, so an update reaches it only when it restarts.
Stopping it takes its processes with it, and the next instance reaps anything a hard kill left behind.

### Which services it knows about

aify-env reads `~/.aify/services.json` — the shared registry each service writes its own entry into
when you install it. Nothing here registers anything; if the file is missing, that is simply no services
yet, and the doctor reports it as such rather than as a fault. Point `AIFY_SERVICE_REGISTRY` elsewhere
to use a different one.

### What it leaves behind, and what it does not

Every process it starts is recorded in `~/.aify/env-processes.json` (`AIFY_ENV_PROCESS_RECORD` to move
it). A graceful stop takes its processes with it; a hard kill runs no handler, so the NEXT instance
reads that record and reaps whatever is still alive before it starts listening. Kills reach the whole
tree, because a launcher is a script and the agent is its child.

One case it cannot fix and does not hide: if a launcher dies before the agent it started, the agent is
orphaned with no parent, and no pid-tree walk can find it from the record.

## Why it exists

Spawning used to live inside a coordinating service. That is fine with one service and impossible with
two: the second either runs its own spawner — two PTY owners on one host, each reaping by its own rules
— or depends on the first, which is the coupling a split is supposed to remove.

So the capability moves out. Services ask; this owns.

## What it will run, and how that is decided

**A file may be executed if it declares an interpreter and carries the harness contract marker** that
every launcher already has:

```
#!/bin/bash
HARNESS_WRAPPER_VERSION="0.6.0"
```

Both, not either. The marker alone is what a file that *documents* the contract carries — this README
did, and passed, until a review caught it. aify-env executes a path a caller supplies, so any file on
the host quoting the contract was enrolled by quoting it. A launcher declares how it is run; a
description of one does not.

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
aify-env                 run the environment on 127.0.0.1:8802
aify-env --port 0        pick an ephemeral port (what the tests use)
aify-env --version

aify-env-tui             a live view: services, owned processes, its own traffic
aify-env-tui --once      render one frame and exit -- what a script wants

aify-env-doctor              passed / failed / unanswered, human-readable
aify-env-doctor --json       {summary, counts, exitCode, checks:[{id, state, detail, fix}]}
aify-env-doctor --strict     exit non-zero when anything failed OR went UNANSWERED
```

**`--strict` is the one to reach for in a script**, and the word "unanswered" in its description is
load-bearing. Without it the exit is always 0, because a report you run to look at should not fail the
shell that merely wanted to look. With it, a check that could not gather evidence fails the run — which
is the whole reason this tool has a third state instead of two.

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
npm install    # node-pty is an OPTIONAL dependency; without it one test fails, on purpose
npm test
```

**`npm install` first, and the reason is the design rather than an oversight.** `pty-real.test.js`
FAILS rather than skips on a host with no terminal support, because "the terminal path works" must not
report green when nobody could check it. So a clone that skips the install gets one red test — which
is honest, and confusing if you were not told. Now you were.

On a host where the native build genuinely cannot succeed, that same red is the truth: this environment
runs processes with piped stdio and a console cannot render a TUI for them. `aify-env-doctor` says the same
thing in its own words.

Several of them exist because a component observed only in its empty or failing state has not been
observed:

- the allowlist is fed a REAL launcher rendered by the `aify-wrapper` package next door, because every
  other case in that file is hand-written text that would keep passing if the real marker line changed;
- `aify-env-doctor` is run against a live environment AND a stopped one in the same run, because a checker
  seen only saying no cannot be trusted when it says no;
- the view is rendered with a real process in it, because a perfect empty frame proves the renderer and
  nothing about the snapshot ever being filled in;
- the real terminal path runs out of process, because node-pty leaves a handle behind and anything that
  spawns one never exits by itself.
