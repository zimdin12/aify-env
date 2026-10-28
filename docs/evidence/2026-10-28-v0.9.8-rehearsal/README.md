# v0.9.8 candidate: the work-PC rehearsal against it, before the tag (2026-10-28)

The operator's live aify-env is 0.9.4, so his next restart jumps several releases at once, on the daemon that owns his
whole fleet. comms-tech-lead asked for the closest stand-in that touches nothing of his: the
[work-PC rehearsal](../2026-10-28-work-pc-rehearsal/README.md), run again with the candidate in place of GitHub's
main.

**The candidate:** `npm pack` of release commit 68a9f98 (VERSION 0.9.8), `aify-env-0.9.8.tgz`, sha256
`bb68f328c8ed8fd9…be304`. The script's new `AIFY_ENV_TARBALL` input hands it to comms' installer chain as
`AIFY_INSTALL_ENV_SOURCE`, so it is installed exactly as the operator's would be, only from a file.

**The rest of the stand-in:**

- the service: the live comms image, 667b6992, on a fresh volume;
- the client: Debian, node 22, the claude CLI never logged in;
- the old install: aify-comms v0.5.7, upgraded through today's chain;
- throwaway containers only, and all four were gone afterwards.

`rehearse-env-and-herdr.out` is the run. The checks asked for:

| Check | Result |
|---|---|
| aify-env boots | `aify-env 0.9.8 (build 6cadd07c)`, `/health` healthy, on both starts (with and without the stale v0.5 bridge) |
| it publishes state | comms doctor `agent-state-publishers`: 2 of 2 publisher(s) fresh |
| the comms doctor's three aify-env rows | `agent-state-publishers` ✓, `spawn-delegation` ✓, `env-bridge` ✓; 14 passed, 3 skipped |
| `aify-env doctor` | 18 passed, 1 failed, 1 unanswered |

The one failure is `claude-login`'s new `not-set-up`, and it is right. Nobody has ever run claude in this container,
and step 5 shows a managed claude waiting on the theme picker. The unanswered row is `claude-trust-roots` (no
`~/.claude.json` to read), as on 0.9.7. On the operator's host, where claude is set up, the same row reads `ok`
(seen 2026-10-28 with the installed doctor).

**Also seen:** `aify-env herdr` off Windows now names `herdr-aify env`. A stale v0.5 bridge is still superseded and
exits by itself.

**Not shown:** the operator's own machine, his fleet's agents and logins, Windows panes, and a real terminal for the
view.
