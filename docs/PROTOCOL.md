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
  "unknown":   [{ "id": "p7", "pid": 991 }]
}
```

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

## `GET /processes`

`{ "processes": [...] }` — the same rows as `/health`.

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
