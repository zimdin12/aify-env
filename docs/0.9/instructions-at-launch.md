# Instructions at launch (design, approved 2026-10-28)

Written by aify-env's and aify-wrapper's owners together; approved by comms-tech-lead with two amendments, both
folded in below: the per-launch files live in `~/.aify/sessions/<id>/`, and that folder is removed by events, not
by a sweep.

## Problem

A definition's `agent.instructions` reached no agent. aify-env stores and validates it (max 64 KB); the wrapper's
`readDefinition` returned role, model and effort only. On the day: 2 of 18 claude/managed definitions carried
instructions (longest 4313 chars), 0 of 9 hermes.

## Design

1. **Stored:** unchanged. `~/.aify/agent-definitions/<id>.json`, written only by aify-env's `DefinitionStore`.
2. **Read at launch:** by the launcher, through `readDefinition` (same file, schema and refusals). It writes the text
   to `~/.aify/sessions/<id>/instructions.txt`, beside the launch's `mcp.json` (aify-wrapper `lib/session-folder.mjs`).
   There is one file per agent, not per launch, in a folder only its owner can open, checked before every write (exit
   78 if it was widened).
   - Not `mktemp` with an EXIT trap: aify-env stops a launcher with TerminateProcess on Windows, which skips the trap.
     On this host %TEMP% held 59 aify-mcp and 49 aify-hooks files against 7 live claudes, 39 over a day old.
   - Not %TEMP% at all: a file there inherited CodexSandboxUsers Modify and an unresolved SID's Modify. Anyone who can
     write the file can rewrite an agent's system prompt between rebuilds.
3. **Claude:** pass `--append-system-prompt-file <file> --system-prompt-snapshot off`, only when the instructions are
   non-empty.
   - Kept in their own array, never in `CLAUDE_ARGS`, which the channel and resume scans read.
   - An operator's own `--append-system-prompt` passes through and combines with them.
4. **Hermes: refused** (exit 78, naming the field) while a hermes definition has non-empty instructions.
   - The managed path is the TUI gateway, whose agent takes its ephemeral prompt only from config or `/personality`.
   - `HERMES_EPHEMERAL_SYSTEM_PROMPT` is not read on that path, and the gateway start strips it
     (`DAEMON_STRIPPED_ENV`).
   - The refusal lifts only when a live hermes quotes a sentinel on a fresh session and on a resumed one.
5. **Resume:** see the probe below. `--system-prompt-snapshot off` is what makes a resumed conversation carry the
   text.
6. **Cost:** a prompt rebuilt every request could re-bill the context. Baseline from usage already on disk: cache
   creation was a median 0.48% of tokens read, p90 1.58% (461 requests).
   - Canary on one agent first.
   - Roll back (drop the snapshot flag) at 3x the baseline median, or on any steady-state turn over 50%.
7. **Removal:** removing a definition does not stop its agent, and its claude keeps reading the folder. So aify-env
   removes `~/.aify/sessions/<id>/` only when `<id>` has no definition here AND aify-env's identity says no live
   process; anything unknown keeps it (`lib/session-folders.mjs`). It acts on three events, never a timer:
   - a definition removed (`aify-env agents remove` asks the running aify-env on `DELETE /agents/:id/session-folder`;
     a service's removal request tells the store's listener);
   - an agent's last lifetime ending (a managed end, or a resident's record gone or proved dead);
   - the daemon's start, for folders left while no aify-env ran.
   Folders named `_pid-<pid>` belong to unnamed launches; the launcher records and sweeps those itself.

## The resume probe (2026-10-28, run once on the operator's direct approval)

Haiku in `-p` mode, in a new empty folder, with this agent's identity stripped from the environment. The results
were read from the session file's `api-request-shape` records (the system blocks sent) and `usage`, never by asking
the model. The session folder was deleted afterwards, and no `~/.claude.json` entry was created.

| Step | Launch | Predicted | System blocks sent | cache creation / read |
|---|---|---|---|---|
| P1 | new session, `--append-system-prompt-file` with sentinel A | A | A (shape 66f3a5e9) | 7730 / 658 |
| P2 | `--resume` with sentinel B | still A | A (shape 66f3a5e9) | 564 / 7864 |
| P3 | P2 plus `--system-prompt-snapshot off` | B | B (shape 1d9770fc) | 7809 / 658 |
| P4 | P3 again after a commit in the folder | creation under 10% of read | B (shape 1d9770fc) | 65 / 8442 (0.77%) |

- **PROVEN, in `-p` mode:** a resumed conversation keeps the prompt recorded on its first request. The flag alone
  changes nothing for an agent that is resumed.
- **PROVEN, in `-p` mode:** with `--system-prompt-snapshot off`, the new text is sent. A rebuild with nothing
  changed is byte-identical (same shape) and cache-stable (0.77%).
- **ASSUMED until the canary runs:** the same holds for an interactive session.

The reader, `docs/evidence/2026-10-28-resume-probe/probe-read.mjs`, prints the same columns from any session file.
Total cost of the four requests was $0.0100.

## Tests that fail without it

- **Wrapper:** a fake claude that records its argv must see both flags on a fresh launch, on `--resume` and on a
  recovered id, and read the file's bytes equal to the definition's text while it runs. It must also show:
  - empty instructions pass neither flag and remove the file;
  - `--shared` passes neither;
  - a hermes definition with instructions exits 78;
  - a widened folder exits 78.
- **aify-env, composition (`AIFY_WRAPPER_REPO`):** aify-env starts a managed agent from a definition with
  instructions, through the real launcher and a fake claude; the recorded file equals the definition.
- **aify-env, removal:** `tests/a-removed-agents-session-folder-goes-only-when-it-is-not-running.test.js`.
- **Live, after the operator's next ordinary restart:** the canary quotes a sentinel found only in its instructions.
