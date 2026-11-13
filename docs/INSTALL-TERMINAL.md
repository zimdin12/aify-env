# Interactive install terminal teardown

The install entry reads artifact approval and policy consent from the controlling terminal, not stdin. Stdin may carry a service key. A `node:tty` ReadStream owns that input descriptor. Closing readline and destroying the terminal streams must let the process exit without `process.exit()`.

A filesystem ReadStream is not interchangeable with a terminal ReadStream. On an owned Linux PTY, the old filesystem reader left the entry alive after its final report. The same entry with the terminal reader exited naturally.

## Native regression witness

Run from this checkout with the normal test environment and explicit peer checkout variables:

```sh
env -u AIFY_AGENT_ID -u AIFY_AGENT_LEASE -u AIFY_ENV_INSTANCE -u AIFY_LIFETIME \
  npm test -- tests/install-terminal-native.test.js
```

The witness requires Linux or WSL, `/usr/bin/python3`, and native Node. It uses Python's stdlib `pty.fork` to run the actual `bin/aify-env-install.mjs`. It answers the actual approval prompt, then requires natural exit within three seconds of the final report. Both approval and refusal are checked. A timeout signals and reaps only the rig's own direct child and is reported as failure, never successful exit.

Installed-wrapper functions and installers are fixture collaborators. The witness has no network, npm installation, policy preparation or runtime-launch effects. Linux HOME, USERPROFILE, TMPDIR and the registry are private. The approval case runs fake acquire/connect/assets in order; refusal runs none and publishes no registry. This proves terminal lifecycle, not real install admission or end-to-end service onboarding. Separate chain composition tests cover admission.

Set `AIFY_TEST_NATIVE_NODE` to an absolute native Linux binary path to qualify another Node version with the identical witness. From Git Bash, preserve the Linux path with `MSYS2_ENV_CONV_EXCL=AIFY_TEST_NATIVE_NODE`. Each result prints the actual child Node version.

## Observed qualification on 2026-11-13

PASSES IN TESTS on an owned WSL PTY, not a live installer or staging acceptance:

| Native Node | Filesystem reader baseline | Terminal reader |
| --- | --- | --- |
| 22.22.2 | Both cases printed their final report, then required cleanup after three seconds | Both exited naturally, approval 0 and refusal 78 |
| 22.20.0 | Same two named natural-exit assertion failures | Both exited naturally, approval 0 and refusal 78 |

An exact filesystem-reader replant made both assertions fail again. Restoring the saved source bytes returned both to green. No process-exit workaround is used.

The portable 22.20.0 runtime came from `https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz`. Its SHA-256 matched the vendor's SHASUMS256.txt, `00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc`. It was extracted outside every repository and executed from a private fixture home.

The earlier staging hang had no captured holder. This differential witness establishes the reader defect on these owned PTYs, not the identity of that historical staging holder. Native Windows console teardown was not exercised. The existing regular-file terminal fixture tests consent ordering only and explicitly adapts its synthetic input.
