# The aify-env request contract

What a service may ask this environment to do. Phase 8 of the aify-comms separation is written against
this, so it is documented before it has a second caller rather than after.

**Loopback only, and not configurable.** `aify-env` binds `127.0.0.1`. This process starts programs on
request; reachable from another machine it is a remote shell with a JSON interface. There is
deliberately no `--host` flag — a guard that can be turned off is decoration.

Default port `8801`. `--port 0` takes an ephemeral one, which is how the tests avoid collisions.

## `GET /health`

```json
{
  "status": "healthy",
  "version": "0.6.0",
  "processes": [{ "id": "p1", "pid": 4242, "service": "aify-comms", "terminal": true }],
  "unknown":   [{ "id": "p7", "pid": 991 }],
  "terminals": { "available": false, "reason": "node-pty did not load" },
  "traffic":   { "requests": 12, "bytesOut": 34567 }
}
```

`terminals` is stated rather than inferred. A consumer that has to work out whether it got a terminal
from output that looks slightly wrong is a consumer that will get it wrong.

`traffic` is this environment's OWN io. It is the only traffic aify-env can honestly report -- it has
no visibility into what a service does elsewhere, and a number meaning anything wider would be
invented.

`unknown` is what the last sweep could not judge. The reaper keeps rather than reaps those, because
dropping a live process out of the only place that knows about it is worse than the leak — but the
decision has to surface here, or it quietly becomes a leak nobody sees.

**There is no agent status in this body, and there will not be.** aify-env knows processes. Alive is
not working, and a field here would make this a second place that answers for agents. There is a test
asserting the health body carries no agent verdict.

## `POST /processes`

```json
{ "service": "aify-comms", "launcher": "/home/you/.local/bin/claude-aify",
  "args": ["--managed"], "cwd": "/work", "env": { "AIFY_AGENT_ID": "coder-1" } }
```

`201` with `{ id, pid, terminal, service }`. **`terminal` is part of the answer, not a detail:** a PTY
renders a TUI and pipes do not, so a caller that silently gets pipes sees output that looks slightly
wrong and no reason why.

| status | when |
|---|---|
| `400` | no `service` (every process has an owner), no `launcher`, or a body that is not an object |
| `403` | the launcher is refused by the allowlist, **or could not be read at all** |
| `201` | started |

**Registration is not authorisation.** A request from a registered service is allowlist-checked
exactly like any other: a host that runs whatever a known caller asks for is one compromised service
away from running anything, and "it came from aify-comms" says nothing about the file being started.

**A launcher that cannot be read is refused.** "I could not open it" must never become "go ahead".

## How a launcher is actually started

The interpreter is **derived from the file that was just judged**, not from its name. The launchers are
bash scripts with a shebang; on unix the kernel reads it and the path alone is enough, but on Windows
nothing does, so a launcher spawned by path simply does not start and the failure arrives as "the agent
did not start" with no reason attached.

`#!/usr/bin/env bash` resolves to `bash`, since env is the lookup and not the program. The script path
goes after the interpreter's own arguments and before the launcher's: `bash --managed script` is a
different command from `bash script --managed`, and one of them is not the agent anybody asked for.

## `GET /processes`

`{ "processes": [...] }` — the same rows as `/health`.

## `GET /processes/:id/output`

Server-sent events, one event per chunk:

```
data: "FIRST-LINE
"

data: "SECOND-LINE
"
```

**A subscriber gets a replay first, then the live feed.** Attaching late is the normal case for a
console, not the exceptional one: an agent that prints its prompt during startup and gets a viewer a
second later must not show an empty pane, because that reads as a hung agent and somebody restarts a
perfectly healthy one.

The replay is **bounded** (64 KB by default, most-recent-first). A process that runs for a week must
not be holding a week of scrollback in the environment's memory, and truncating from the other end
would give a console the start of a session and none of what is happening now.

Each chunk is JSON-encoded inside the event, because a newline in the output would otherwise end the
event early -- a newline is this protocol's frame delimiter.

`404` when there is no such process. That is deliberately distinct from an open stream that is simply
quiet: one means look elsewhere, the other means wait, and conflating them makes a console look broken
for a reason nobody can see.

Closing the connection releases the subscription. SSE rather than a socket because a console only ever
reads: no framing to get wrong, no upgrade handshake, and it reconnects by itself.

## `POST /processes/:id/input`

```json
{ "data": "yes" }
```

`204` on delivery. **`404` when the process is gone** — refused rather than silently dropped, because a
console typing into a void leaves the operator concluding the agent is ignoring them. `400` when
`data` is not a string.

## `POST /processes/:id/resize`

```json
{ "cols": 120, "rows": 40 }
```

`204` when applied. **`409` when the process has no terminal to resize**, which is deliberately not a
404: the process exists and the request does not apply to it, and a console has to tell that apart
from "gone" before deciding whether a retry is worth anything. Accepting it silently would let a
console believe it had set a width while the agent kept wrapping at the default, with nothing anywhere
explaining the difference.

`409` too for a nonsense size. A zero or negative winsize has thrown out of node-pty's ioctl before,
and a console sending one should be told rather than taking the environment down with it.

## `DELETE /processes/:id`

`204`, always. Stopping is idempotent: a caller retrying, or a reaper racing one, must not get an error
for having been second.

## Known limitation: a TOCTOU window

The launcher is read to be judged and then started by path, so a file swapped between those two moments
would be judged as one thing and run as another. Closing it properly needs execution from the
descriptor that was read, which node does not offer.

On a host where an attacker can rewrite files in the launcher directory they can equally write a
contract marker, so this is not the weakest link. It is written down because the next person should
know it is there rather than find it.
