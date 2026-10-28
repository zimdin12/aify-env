# aify-env

The environment tier: **one process on a host that owns the processes and terminals**, so more than
one service can start agents on that machine without two spawners fighting over the same PTYs.

Nothing here knows what a message is or what a dispatch is. It knows which agents this host defines, which
processes it started, and whether they are alive. Since 0.9 it also derives what each agent is doing
(`lib/agent-state.mjs`) and publishes it as a SHADOW: the service's status still governs, and the two are
compared (`agent-state-shadow` in `aify-comms doctor`) before this one may.

**One of three repos.** [aify-comms](https://github.com/zimdin12/aify-comms) owns messaging, dispatch
and sessions; [aify-wrapper](https://github.com/zimdin12/aify-wrapper) owns the launchers this will
run. Nothing here depends on either: aify-env serves whichever services register on the host, and
runs whatever launcher carries the harness marker. That independence is the point — a second service
should not have to build its own spawner.

## Install

```bash
git clone https://github.com/zimdin12/aify-env
cd aify-env
npm install
```

**On a new PC, install and connect everything in one run** (guided install S2):

```bash
./install.sh --connect aify-comms=http://<host>:8800 --client claude --secret aify-comms.credentialRef=<key file>
```

It installs aify-env and aify-wrapper, then for each `--connect`: acquires the service's approved artifact,
connects it (`aify-wrapper-connect`), renders each `--client`'s launcher once, applies the service's assets for
clients whose CLI is present, and reports what is pending. Keys come from a file or `--secret-stdin`, never argv.
A tuple the catalogue does not approve is refused with the `--approve <digest>` that approves it. `aify-env install`
is the same chain on its own; aify-comms' installer hands off to it.

**Start it from the folder that contains your workspaces.** It starts work only in that folder and below
(`C:\` covers the whole `C:` drive on Windows; another drive or a network share needs its own start), and
refuses every other start. Started too narrowly, it names each managed agent it cannot start in a warning at
startup and in `aify-env doctor` (`agents-outside-roots`); aify-comms shows those agents `misconfigured`.

`node-pty` is the dependency that matters most, and it is the one that can fail: it is a native module,
so a host without build tools gets a working install with NO TERMINALS. That is not a broken state and
aify-env does not pretend otherwise — processes run with piped stdio, a console cannot render a TUI for
them, and `aify-env doctor` says so in as many words. Check before you trust it:

**Two more optional dependencies arrived in v0.6.3**, and they degrade the same way rather than
failing: `@xterm/headless` and `@xterm/addon-unicode11` are what let the right-hand pane draw a
coding agent's SCREEN instead of a notice. Absent, the pane says it cannot draw one and names
`aify-env attach`, which is exactly what it said before they existed. Nothing else changes.

**A third, `@xterm/addon-serialize`, lets a console join a long-running agent.** With all three
present the daemon keeps each PTY's screen and hands a late subscriber that screen, then the live
bytes after it, so the pane and `aify-env attach` draw an agent that has printed more than the 64 KB
replay. Without any one of them a late subscriber gets the replay as before, and the pane waits for a
full reset it may never see. A running daemon picks this up only after `npm install` and a restart.

```bash
aify-env doctor
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
`{"status":"healthy"}` from the dashboard. `aify-env doctor` refuses that impostor, because a real
environment reports the processes and terminals it owns; a defence is not a reason to keep a collision.

### On PATH, and updating

```bash
./install.sh                 # install or update, asking for anything this host is missing
git pull && ./install.sh     # updating is the same command
```

**The same command does both.** An installer with a separate update path grows a second set of steps
that drifts from the first, and the half that rots is the one nobody runs by hand.

**It asks for what is missing, and only for that.** A service registered on this host needs a
credential before aify-env can advertise to it or claim its work; without one every advertisement is
refused with 401 while both daemons report healthy. That happened on 2026-09-02 and cost a day, so
the installer now asks rather than proceeding silently. A credential already stored is left exactly
as it is -- re-asking would train an operator to paste secrets nothing needed, and overwriting a
working one would turn an update into an outage.

**Unattended runs do not hang and do not lie.** With no terminal it prints what is missing, names the
command that fixes it, and exits non-zero, because a host that cannot claim anything must not report
success:

```bash
./install.sh --no-prompt     # never ask; report and fail if something is missing
./install.sh --plan-only     # say what would happen; install nothing, ask nothing
```

`npm install -g .` still works and is what `install.sh` runs. What it does not do is notice a missing
credential, which is the whole reason the script exists.

Every command is named after the package, and a test enforces it. The doctor was called `aify-doctor`
until aify-comms turned out to install a different tool under that exact name -- two tiers on one host
is the whole point of the split, so whichever landed on PATH first would have silently shadowed the
other.

A running daemon keeps the code it loaded at boot, so an update reaches it only when it restarts.
Stopping it takes its processes with it, and the next instance reaps anything a hard kill left behind.

### Herdr: two ways in

**`herdr-aify env`, a dedicated instance.** aify-wrapper's launcher starts a Herdr of its own (its
own socket, config and state roots), runs this daemon in its first space with `--instance-context`,
and attaches the Herdr TUI. In that instance the daemon opens a Herdr space for every worker a
service plugin starts -- the pane runs `aify-env attach --id <id>` against the worker that is already
running, so the worker stays this daemon's and its console keeps streaming -- and closes that pane
when the worker exits. The view there offers `s` to start an agent and no console pane or Enter
attach, because every worker already has a space. **Leaving that Herdr session ends the environment
and every worker in it**; that lifetime is the launcher's, and it is described with the rest of the
mode in [aify-wrapper's HERDR.md](https://github.com/zimdin12/aify-wrapper/blob/main/HERDR.md).
That daemon serves a port the OS picked, and `aify-env agents import`, `aify-env attach` and
`aify-env run` find it from its ready receipt when nothing answers on 8802 (`AIFY_ENV_ENDPOINT`
still wins when set).

**`aify-env herdr [agent]`, one worker into a Herdr you already run.** It opens an existing worker
in a new Herdr workspace; with no argument it offers a numbered picker. This is a Windows PowerShell
adapter for Herdr 0.9.0. Both servers must already be running, `AIFY_ENV_ENDPOINT` and
`HERDR_SOCKET_PATH` must name them, and neither is started or stopped by this command.

Herdr is not bundled or installed. Detection looks where aify-wrapper looks: `HERDR_BIN_PATH`,
Herdr's standalone package, `HERDR_INSTALL_DIR`, then PATH. Keep `herdr.exe` with its app-local
ConPTY runtime. See [docs/HERDR.md](docs/HERDR.md) for setup, usage, lifecycle behaviour and the
real integration test.

### Which services it knows about

aify-env reads `~/.aify/services.json` — the shared registry each service writes its own entry into
when you install it. Nothing here registers anything; if the file is missing, that is simply no services
yet, and the doctor reports it as such rather than as a fault. Point `AIFY_SERVICE_REGISTRY` elsewhere
to use a different one.

A running aify-env follows the registry: a new entry starts its plugin, and a removed or re-pointed one
detaches it. One edit it does not follow: changing only WHERE a service's key comes from (`credentialRef`
or `keyEnv`) while the endpoint stays the same keeps the running plugin on the key source it started
with, until aify-env restarts. Rotating the key's value inside the same file or variable is picked up
without a restart.

**Which services it describes this host to.** Every 30 seconds (`AIFY_ADVERTISE_MS`) aify-env posts a
description of this host to each registered service it has a route for: the service's plugin supplies
one (aify-comms' does), or the entry declares it with `"advertisement": {"path": "/..."}`. An entry with
neither is sent nothing, and `"advertise": false` still opts a service out even when a route exists. A
declaration that is not a path sends nothing and is named in `/health` under `advertiseIgnored`.

### What it leaves behind, and what it does not

Every process it starts is recorded in `~/.aify/env-processes.json` (`AIFY_ENV_PROCESS_RECORD` to move
it). A graceful stop takes its processes with it; a hard kill runs no handler, so the NEXT instance
reads that record and reaps whatever is still alive before it starts listening. Kills reach the whole
tree, because a launcher is a script and the agent is its child.

One case it cannot fix and does not hide: if a launcher dies before the agent it started, the agent is
orphaned with no parent, and no pid-tree walk can find it from the record.

## The agents this host defines (0.8)

Which agents exist on this host, and how each one launches, is a **definition**: one JSON file per
agent in `~/.aify/agent-definitions/` (`AIFY_AGENT_DEFINITIONS_DIR` to move it). A definition is the
desired state you set: name, role, harness, mode, workspace, model, effort, instructions, herdr space
and extra environment. It holds nothing live; sessions, messages and status stay in the services.

```bash
aify-env agents list
aify-env agents show <id>
aify-env agents set <id> role=reviewer model=gpt-5.5 effort=high
aify-env agents set --harness claude model=opus --yes   # many at once (--all, --ids a,b); a dry run without --yes
aify-env agents models            # each agent's set model beside the one its session last answered with
aify-env agents import            # what it would define from the agents your services know; --write does it
```

A changed model reaches each agent at its next start, including a Claude session that resumes (0.9.1).

- **One writer.** Only the store behind `aify-env agents` writes those files, under a lock, with every
  write recoverable after a crash. `agents unlock` clears a lock whose writer is gone; `agents recover`
  settles an interrupted write the store could not prove either way.
- **The launcher reads it.** An agent's launcher takes its role, model and effort from its definition
  as defaults; a flag or the environment still wins. A missing file is the old behaviour; an invalid
  one, or one defining another harness, refuses the launch (exit 78). A managed start reads no file:
  aify-env hands the launch what it already checked.
- **Services get a copy, not ownership.** Each service plugin pushes this host's definitions to its
  service (every minute, and at once after a change it applied), so aify-comms shows them. An edit made
  in a service to a defined agent becomes a change request; this host claims those every 10 seconds
  and applies them through the store. A service older than definitions answers 404, which is logged
  once and reported by the doctor as "does not accept definitions".
- **Nothing moves until you say so.** An agent with no definition works as before. `agents import`
  without `--write` only prints its plan.

Status is still not here: alive is not working, and turn status belongs to the service.

### Dialogs it answers for a managed agent

The first time claude starts in a folder with no trusted ancestor, it asks "Is this a project you trust?" with the
cursor on **No, exit**. For a managed claude it starts, aify-env answers that dialog on the screen: one Down, then
Enter once the cursor is on **Yes, I trust this folder**. Claude then records the trust itself. aify-env never writes
`~/.claude.json`. Each answer can be switched off in `~/.aify/config.json`, and an edit applies without a restart:

```json
{ "plugins": { "aify-comms": { "autoConfirm": { "folderTrust": false } } } }
```

A missing file, section or key leaves the answer on. A section that cannot be read, or a value that is not `true` or
`false`, turns it off. `aify-env doctor` shows what is in force (`auto-confirm`), and says whether claude already
trusts the folders this host runs work in (`claude-trust-roots`). Trusting a root once, by opening claude in it and
choosing Yes, covers every folder below it.

## Starting a second one takes over

`aify-env` supersedes the environment already running: it stops the incumbent and takes the port. That
is what starting an environment means, and it matches what the aify-comms bridge has always done.

**The predecessor's processes are not stranded.** They are in the on-disk record, and the replacement
reaps from it -- but only AFTER the port is its own. That ordering is load-bearing and was wrong: the
reap ran BEFORE the bind, so a second start read the record of the instance already running, found its
processes alive and verifiably ours, killed them as orphans, and only then discovered the port was
taken and exited. The incumbent kept serving, robbed of its work.

**The holder is asked before it is killed.** `/health` reports the pid, so a replacement asks the port
who is there rather than scanning the process table: a pid says nothing about what a process is, and a
healthy status alone could come from anything serving JSON. Something that does not identify as an
aify-env is left alone, named, and the start exits 69 -- ending whatever happens to hold a port is how
you stop somebody else's server.

## What the view shows, and what it may not

Services it can reach, the processes it started, and its own traffic. Each process row carries:

- **agent** -- the `label` the caller supplied at spawn. aify-comms passes the agent id. aify-env
  stores and displays the string and reads no meaning into it; knowing what an agent IS belongs to the
  service. Without it a row reads `p2  pid 129340  aify-comms`, which cannot answer "which of my
  agents is this".
- **title** -- whatever terminal title the process set, taken off its output as it passes. Only the
  process knows what it is doing, and it already says so in a sequence every terminal honours.
- **up** -- derived where a clock is allowed. The view is pure and holds none.

**A resident agent appears here only if it was started through this environment**, which is what
`--shared` does: `claude-aify --shared` execs `aify-env run`, so the process is launched HERE, gets a
row, and can be attached to from another terminal. A resident started the ordinary way connects
straight to its service and this environment never sees it. The rule is not resident-versus-managed
-- it is whether this environment launched the process.

Colour and width are decided by the caller, so a pipe gets neither and `NO_COLOR` is honoured. Every
state is a word as well as a colour -- a glyph alone fails for a piped view or a colour-blind reader.

### The keyboard, where there is one

The view says what it accepts on screen, and this section exists for the two answers that are
decisions rather than bindings.

| key | does |
|---|---|
| `up`/`down`, `j`/`k`, `1`-`9` | move the selection |
| `g` | find, filtering the list as you type |
| `p` | show or hide the console pane |
| `enter` | attach -- every keystroke then goes into that agent's terminal |
| `m` | actions for the selected agent |
| `s` | start an agent this host knows that has no worker: the list replaces the table, typing searches it, arrows move, Enter starts, Tab switches whether the highlighted agent gets a herdr space from its next start (aify-comms keeps the setting) |
| `v` | more or fewer columns in the agents list: the status word, id, pid, service, io and uptime are in the extended set; kept in `~/.aify/tui.json` |
| `c` | the pane menu: each pane's letter (`s` services, `h` health, `a` agents, `x` exits, `n` notices, `t` traffic) collapses it to its heading or expands it; kept in `~/.aify/tui.json` |
| `ctrl+]` | back, from anywhere |
| `ctrl+l` | redraw the screen, if anything has smeared it (outside an attached pane, where it is the agent's) |
| `q` | leave, where leaving is offered |
| `ctrl+c` | back out of a menu, the start list or find; on the list, leave `aify-env tui`, or in the daemon's own terminal ask before stopping the environment |

**Ctrl+C IN THE DAEMON'S OWN TERMINAL ASKS FIRST.** There it stops the environment and every worker
it owns, so the view asks `stop the environment and its N workers?` and only a single `y` goes
ahead. In a menu, the start list or find it backs out instead, and inside an attached pane it goes to
the agent. A SIGINT sent by a signal rather than typed still stops the daemon at once.

**A PASTE IS NEVER A KEY.** While the view has the screen it turns on bracketed paste, so the terminal
marks every paste however it splits it: on the list, in a menu or a question a paste does nothing,
in find and the start list it is search text, and in an attached pane it reaches the agent whole.

**THE CONSOLE STARTS HIDDEN, and that is deliberate.** It costs half the width to show one process,
against a list of every agent on the host -- and the operator's stated priority for this view is
seeing which agents are working. `p` brings it back. While it is hidden nothing is streamed at all:
no connection, no buffer, no emulator.

**A DESTRUCTIVE ACTION IS A QUESTION, not a keystroke.** `stop` kills a live worker mid-turn, so it
is not reachable without opening the menu, choosing it, and answering `y`. Anything that is not `y`
cancels.

**`restart` IS NOT OFFERED BY EITHER TIER, and this paragraph used to say it was.** Respawning a
managed agent is the service's business and neither the daemon nor the client has a primitive for it,
so listing it would be a menu row that does nothing when chosen. The word survives in the action
*vocabulary* — which is what constrains a caller's offer — and no caller offers it.

**STARTING IS THE OTHER DIRECTION AND DOES NOT ASK.** `s` lists the agents this host knows that have
no worker, in place of the table, and starts the one you choose. Type to search it (`j` and `k` are
letters there); the list says how many of how many match, and the agents it leaves out are summarised
with the reason. "starting X…" stays on the line above the hints until X's worker appears. It ends nothing the service reports as live: the restart it
sends is refused if the agent has a live session. The launch itself replaces any leftover or unreported
instance of that agent still running on this host. The stop that undoes it is one menu
away — the confirmation is derived from "does this end work you cannot get back", and starting does
not. It still takes three deliberate keystrokes.

**What the pane can draw depends on what it is given.** A coding agent paints with cursor moves, so
with the emulator installed the pane runs one at the PRODUCER's geometry and shows the real screen --
cropped to the pane's width and, when the screen is taller than the pane, to its last painted rows,
where an agent's prompt and input box are. The title says when either crop happens. Without the emulator, or before a
trustworthy baseline exists, it says so rather than showing a reconstruction that may be wrong.

### Its layout: `~/.aify/tui.json` (0.9.6)

The view's own file, read when the view starts. `v` and the pane menu write it; the rest is edited by hand:

```json
{"version": 1,
 "panes": ["agents", "services", "health", "exits", "notices", "traffic"],
 "hidden": ["traffic"],
 "collapsed": ["health"],
 "extended": false,
 "columns": {"agents": {"normal": ["cursor", "status", "agent", "out", "title"],
                        "extended": ["#", "status-word", "agent", "out", "id", "pid", "service", "io", "up", "title"]}}}
```

- `panes` is the order. A pane it leaves out is drawn after the ones it names, so a pane added later still appears.
- `hidden` panes are not drawn at all; `agents` cannot be hidden, because the keys act on its list.
- `columns` are the agents list's two sets, the values above being the defaults. Each must include `agent`. The other
  names are `id`, `pid`, `service`, `io`, `up`, `status` and `status-word`.
- `status` is the agent's dot and, after it, how long it has been in that state (`● 12m`), or why, when the state
  needs looking at (`● folder-trust` for a blocked agent). `status-word` adds the word: `● working 12m`.

Every field is optional. A file that cannot be read, or names something unknown, does not stop the view: it draws
the defaults, or the parts it could use, and says what is wrong under its header. `v` and `c` never rewrite such a
file, so a typo in a hand edit is not lost to a keypress.

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

```bash
aify-env --help
```

**That is the list, and this file deliberately does not keep a second copy of it.** The block that
used to sit here had been hand-copied twice into one code fence -- the same six commands written out
in two different wordings, one after the other -- and between them they had missed `attach`, `run`,
`credential` and `--force` entirely. A command list in prose is a cache of `--help`, and this one had
gone stale in the way a cache does: silently, while looking authoritative.

What `--help` does not say, and belongs here:

- **`aify-env doctor --json`** gives `{summary, counts, exitCode, checks:[{id, state, detail, fix}]}`.
  The host rows that moved here from `aify-comms doctor` in aify-comms 0.9.7 (aify-env 0.9.4) carry a `code` as well, the one they
  had there: `env-processes`, `context-window` and `managed-orphans` (from the aify-comms plugin, when
  aify-comms is registered), `claude-login`, and `code-current` (`current`, `stale`, `unknown`), which
  answers what `env-code-currency` asked. A row that does not apply here passes with code `skipped`.
- **`aify-env registry check <file|--stdin>`** is what a registry writer asks before publishing: it checks the
  fields aify-env reads that aify-wrapper's parser drops (every `*CredentialRef`, cross-service collisions,
  `advertise`) and, unless `--candidate-only` is given, each reference's file in the store; `--service <name>` makes
  another service's missing file a warning. A candidate it evaluated gets one JSON document,
  `{check, ok, references, problems, warnings}`, with exit 0 or 65. A usage error (64) or a candidate it could not
  read (65) prints to stderr only, with no JSON.
- **`aify-env tui --once` renders one frame and exits** -- what a test or a status line wants.
- **`aify-env --port 0` asks the OS for a free port**, which is how the suite runs without touching a
  live environment.

**`--strict` is the one to reach for in a script**, and the word "unanswered" in its description is
load-bearing. Without it the exit is always 0, because a report you run to look at should not fail the
shell that merely wanted to look. With it, a check that could not gather evidence fails the run — which
is the whole reason this tool has a third state instead of two.

Over the wire (`docs/PROTOCOL.md`): start, stop, list, health, **output** as server-sent events with a
bounded replay for consumers that attach late, **input**, and **resize** — which refuses when there is
no terminal rather than silently doing nothing.

The plan it is built against lives in the aify-comms repo at
`docs/superpowers/plans/2026-08-20-aify-env.md`, with the architecture and its evidence in
`docs/AIFY_ENV_BOUNDARY.md`.

## Tests

```bash
npm install    # node-pty is an OPTIONAL dependency; without it one test fails, on purpose
npm test
npm test -- tests/one.test.js    # one file, under the same throwaway TEMP and HOME
```

Run a single file through `npm test --`, not `node --test`. The runner points TEMP and HOME at a directory it deletes,
and a file started directly leaves its fixtures in the real Temp.

**`npm install` first, and the reason is the design rather than an oversight.** `pty-real.test.js`
FAILS rather than skips on a host with no terminal support, because "the terminal path works" must not
report green when nobody could check it. So a clone that skips the install gets one red test — which
is honest, and confusing if you were not told. Now you were.

On a host where the native build genuinely cannot succeed, that same red is the truth: this environment
runs processes with piped stdio and a console cannot render a TUI for them. `aify-env doctor` says the same
thing in its own words.

Several of them exist because a component observed only in its empty or failing state has not been
observed:

- the allowlist is fed a REAL launcher rendered by the `aify-wrapper` package next door, because every
  other case in that file is hand-written text that would keep passing if the real marker line changed;
- `aify-env doctor` is run against a live environment AND a stopped one in the same run, because a checker
  seen only saying no cannot be trusted when it says no;
- the view is rendered with a real process in it, because a perfect empty frame proves the renderer and
  nothing about the snapshot ever being filled in;
- the real terminal path runs out of process, because node-pty leaves a handle behind and anything that
  spawns one never exits by itself.
