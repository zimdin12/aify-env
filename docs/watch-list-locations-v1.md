# Watch-list locations

The dashboard lists projects for a host key. It passes each stored root's `fsNamespace` and `path` through unchanged. The same host key can list Windows and multiple WSL filesystems. The reporter chooses only its own namespace before resolving or opening a listed folder.

| Reporter | Reads | Path rules |
| --- | --- | --- |
| `win32:<host>` | `windows` | Windows drive paths, case folded for comparison |
| `linux:<host>` | `linux` | Absolute POSIX paths, case kept |
| `wsl:<host>` | `wsl:<distroId>` | Absolute POSIX paths in that distro, excluding verified Windows drive mounts |

WSL uses the local, trimmed `/etc/machine-id` (8 to 128 ASCII letters, digits, dots, underscores or hyphens) and verified drive mounts from `/proc/mounts`. Missing facts refuse WSL placement with a reason. Compare by whole path segments and keep the real Git-path grant checks. A backslash in a POSIX path is a name character. Unknown filesystems, including Darwin in this version, stay unassigned. Neither side translates a mismatched watch-list row.

HEAD, range-open, resync and file-list reports may carry the same top-level `wsl: { distroId, driveMounts }` block as registration. The dashboard applies the same worktree placement rule to all four. Batch requests stay bound to the range's stored location, with no new field. Reports outside WSL keep their previous body. Deploy the receiver first: an older receiver refuses an unplaced WSL report, and an older reporter refuses a namespace it cannot read.

## Paired proof

Run `npm test -- tests/the-dashboard-plugin-sweeps-a-new-head.test.js` on native WSL with the isolated receiver's URL and exact commit in `AIFY_TEST_WATCH_LIST_SCRATCH` and `AIFY_TEST_WATCH_LIST_RECEIVER_SHA`. The paired fixture accepts only a private IPv4 scratch address on port 9794, checks `/health` before loading a key from `AIFY_TEST_WATCH_LIST_KEY_FILE`, and writes body-free receipts if `AIFY_TEST_WATCH_LIST_RECEIPTS` names a private directory. Never point it at a live dashboard. It registers fresh project roots in the scratch database. The watch-list, HEAD, range and file-list traffic is real; the provider poll and sweep subprocess output remain scripted. Compare the receipts with the scratch database's acknowledged HEAD, completed range and commits on the same location. The scratch owner removes the fixture service and its data.

The portable report-body and refusal controls run in `tests/the-dashboard-plugin-reports-its-worktree-namespace.test.js`. Windows runs the composed sweep cases without the paired scratch fixture.
