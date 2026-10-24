# Linux native checkpoint lock qualification for #6

PROVEN on actual Linux container runtimes with the real checkpoint implementation and wrapper producer. This is not final environment qualification. Reclamation remains a separate gate. No deployed service was exercised or changed, and power-loss durability was not tested.

## Replay

From this checkout on the Windows Docker host:

```sh
python docs/evidence/activity-flock-linux-6.py
```

The driver verifies the frozen parent is an ancestor and that product code, dependency declarations and the maintained runner still match it. It requires the frozen wrapper checkout at `C:/Users/Administrator/projects/wrapper-activity-loss-review-6`, verifies its HEAD, and archives its tracked `lib` bytes without executing its entry point. The driver selects exact official Node tags, records their immutable image IDs, and starts only uniquely named owned containers. Source is mounted read-only; work, dependencies, home and temp are container-local. Tests run exclusively through `npm test -- tests/the-dashboard-plugin-serializes-activity-checkpoints.test.js`.

Each replay creates a new ignored `.check-output/activity-flock-linux-6/run-*` folder. It retains sources, driver, hashes before/after, npm dependency receipts, native binaries, loaded libc/Koffi mappings, kernel/filesystem observations, all command exits, syscall traces, fixture checkpoint bytes and exact container IDs. Container deletion has positive and negative readback controls. No Docker socket, real home or live service state is mounted.

## Executed result

Frozen product `0e6f1f4178544ddf95840217534d27bc1fdec103`; wrapper `0de08cbd1ee6faf3a484bba2fb514ed0d117ce92`.

Verified run `run-1792880116660410400`. Its `summary.json` SHA-256 is `44330a4aa56648a4a063bec6d8086e1ac9c8739fa072976f305bc95c07164f06`.

| Native Node | Baseline | Compiling no-flock mutation | Restored |
| --- | --- | --- | --- |
| 22.20.0 | 5 passed, exit 0 | 3 passed, 2 failed, exit 1 | 5 passed, exit 0 |
| 26.7.0 | 5 passed, exit 0 | 3 passed, 2 failed, exit 1 | 5 passed, exit 0 |

Every arm executed five cases with zero skips, cancellations or todos. In both mutants, the two exclusion cases failed the named assertion `B cannot overwrite checkpoint bytes while A owns the operation`. B persisted generation 2 while A held ownership, starting from generation 1. Both writer exits were zero, and the forbidden B bytes were captured before releasing A. This was not a timeout or an entry-flag-only failure.

Each healthy arm recorded 15 successful native `flock` calls and two `EAGAIN` refusals using `LOCK_EX|LOCK_NB`. Each mutant recorded zero `flock` calls. Every arm recorded zero executions of a `flock` program. Healthy arms recorded 17 lock opens with `O_NONBLOCK|O_NOFOLLOW`, 32 successful-or-attempted fsync syscall records and 12 successful atomic checkpoint replacements. Individual owner traces show successful fsync followed by successful rename before the saved marker and SIGTERM.

Live-owner and genuinely dead-owner schedules preserved exact B-observed checkpoint bytes. Death before save preserved generation 1, then the successor persisted generation 2. Death after fsynced replacement preserved exact generation 2 bytes through successor acquisition, then the successor persisted generation 3. Owners were terminated through their held child handles; native close receipts and subsequent `ESRCH` probes established actual death. Missing Koffi continued to fail closed.

Both lanes loaded Linux Koffi 3.3.3, native glibc binding SHA-256 `2fcc0e86bc8f4244303e01a0878c2738cb768b84c40f1cd31694fa9c2d16baf1`. Native dependencies were installed inside Linux with the existing lockfile, not copied from Windows. No product dependency was added. Observed container kernel was `6.18.40.1-microsoft-standard-WSL2`, filesystem `overlayfs`, glibc 2.36, Debian revisions `2.36-9+deb12u13` and `2.36-9+deb12u14`. These are container observations, not an inference about another host filesystem.

Immutable image IDs:

- Node 22.20.0: `sha256:915acd9e9b885ead0c620e27e37c81b74c226e0e1c8177f37a60217b6eabb0d7`
- Node 26.7.0: `sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1`

Owned container IDs, both removed with exact-ID inspect refusal and successful image-inspect controls:

- `766e0e38a75b017baafaf56881bb9f07911a95ecb0eff4f114139db43c48ca8f`
- `b7924de1dfdf446951f47f42e8d341391c08807a4a96b1ad986c3d09c4cc9bf6`

The cached floating `node:22-bookworm` was actually 22.23.4, so it was not substituted for either required pin.

## Narrow test repair and retained failed attempts

The first instrumentation attempt failed because Koffi does not export its package.json subpath; metadata now reads its installed package file directly. The next run failed before all five tests because the POSIX npm script shell dropped `ProgramFiles(x86)`. Both original failure receipts remain private. The shared fixture and actor now require that Windows-only environment name only on Windows. Other sealed variables remain asserted on Linux, and no maintained-runner change was made. Tests additionally retain checkpoint snapshots around B and owner death, plus real death exit/PID receipts. Product lock code is unchanged.
