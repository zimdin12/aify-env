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

## Run 2: the rebased release commit, 7e37e47

Main moved under the release commit (0efe317: 29 exports un-exported, tests, one comment). comms-tech-lead asked
for this run before the tag because static linking cannot clear a lookup by name at runtime. Static linking is
the check that all 211 lib modules still link. A lookup by name at runtime is a plugin loader or an `import()`
reaching an export by its name.

**The candidate:** `npm pack` of 7e37e47, sha256 `e4d7124e247dc2a4…6f46`. The service was today's live image, by then
6726e22c. `rehearse-env-and-herdr-7e37e47.out` is the run.

| Check | Result |
|---|---|
| aify-env boots | `aify-env 0.9.8 (build 182c5ce3)`, `/health` healthy, on both starts |
| it publishes state | `agent-state-publishers`: 2 of 2 publisher(s) fresh |
| the comms doctor's three aify-env rows | all ✓; 14 passed, 3 skipped |
| `aify-env doctor` | 18 passed, 1 failed (`claude-login` not-set-up, correct), 1 unanswered (`claude-trust-roots`), as in run 1 |

**What this run covers of the 29.** The aify-comms plugin loaded, published, claimed and spawned, so its 16 un-exports
were loaded at runtime. The aify-dashboard plugin is not configured in this rehearsal, so its 13 were not. For those:

- They have no runtime use by name. No module in lib/ or bin/ has an `import * as`; the search finds one in
  tests/, which is its positive control.
- The only `import()` calls in lib/ name what they take (`LifecycleLaunch`), or load the wrapper's own file.
- Each of the 13 names appears only in its own file across aify-env's lib, bin and scripts, aify-wrapper and
  aify-comms. As a control, `servableNow`, which another module imports, is found in two files.
- aify-dashboard mentions six of them, only in dated mutation harnesses under docs/evidence/, as text anchors
  against the aify-env source of their day.
- The plugin itself is started from its real modules by the `the-dashboard-plugin-*` suites. Those pass in the
  full run on 7e37e47: 3859 tests, 3854 pass, 0 fail, 5 skipped.

**After run 2,** the release commit was rebuilt as fd3b2fc on 512a72d. That commit exports `DASHBOARD_SURFACE_PREFIX`
again, because aify-comms' tests import it by computed path, which none of the checks above could see. Run 2 still
stands for fd3b2fc: adding back an export cannot break a module that already links, and nothing in the daemon reads
it by name. The rest of the change is a comment and a test.
