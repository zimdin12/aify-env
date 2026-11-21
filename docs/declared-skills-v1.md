# Declared skill trees

An approved, top-level package installed by the current connect can put `"aifySkills": { "directory": "skills" }` in its package.json. The value names a contained, package-relative directory. Its immediate children are skill directories, each with a regular `SKILL.md`. A tree may be empty when the package intends to retire its previously placed skills. There is no new registry field.

The assets phase checks the same-connect path, package revision and approval before accepting this declaration. It reads and copies data; it never imports the package or executes an assets bin for the declared tree. A package must choose its legacy assets bin or the declaration, not both. The existing wrapper artifact format still requires a declared package bin even when no MCP entry references it; skill placement does not execute that bin. The usual package acquisition and connect policy is unchanged.

A file-set installer can keep its non-skill assets while a separate package supplies skills. By default, its assets step still runs first and a failure stops before placement. The chain never runs an additional package assets bin in this mode.

## Hand off guided skills to env

To require placement before the non-skill step, put exactly one literal header in the selected `install.sh`, such as `# aify-env-skills-handoff-v1: comms-skills`. Replace `comms-skills` with the artifact ID: lowercase letters, digits and hyphens, starting with a letter or digit. The chain reads this declaration without running the script. It requires that exact package to be accepted by the same connect and to declare a valid skills directory. Missing, pending and mismatched packages stop the chain.

For each selected, present runtime, env verifies the placement and then calls the same installer with `--assets-only --client <runtime> --skills-placed-v1 <url>`. The flag applies only to that invocation. That path must require the flag and never copy skills itself. A failed placement does not run that assets step; if non-skill assets fail afterward, successfully recorded skills stay placed for a rerun. Neither step receives the service key variables. `--acquire-only` and standalone keep their separate contracts and never receive the flag.

Before a service installer hands off to env, it can run `node <path-to-bin/aify-env-install.mjs> --supports-skills-handoff-v1` on the same module it will use. Exit 0 confirms the protocol without connecting, starting a daemon or processing credentials. Check before reading a key, and refuse rather than falling back when unsupported. The flag coordinates trusted installers; it is not proof for an unrelated process or an authorization boundary.

Only selected, present runtimes receive a copy. Claude honours `CLAUDE_CONFIG_DIR`. Codex must report that it searches the proposed `CODEX_HOME` skills root. Hermes uses its selected runtime's reported skills directory under `autonomous-ai-agents`, with no links or external-directory changes. An unproved or shadowed target must be resolved before placement.

Every ancestor of a skill destination must be a real directory. If a dotfile manager links `~/.claude` or `~/.codex`, the chain refuses rather than following the link. Put the runtime's configuration in a real directory, or point `CLAUDE_CONFIG_DIR` or `CODEX_HOME` directly at its intended real directory and rerun. Do not remove the managed link just to make the install pass.

`~/.aify/installed-skills.json` records service, skill, harness, approved source artifact/revision/path, destination, and the digest of the tree read back there. The index is separate from the service registry. Updates and removals require the recorded digest to match what is still on disk.

Before writing any skill or receipt for a service and runtime, env checks every incoming and retiring destination and names any conflicts together. Even a byte-identical unmanaged tree is not adopted. Move a conflicting skill aside intact to a backup outside every configured skill search root, then rerun. Leave linked runtime roots alone and configure a real directory as described above.

Preflight does not reserve the paths. Env checks again before each change. Every successful placement is recorded before moving on, so a late conflict can leave earlier placements recorded. A failed copy restores the preceding contents when it can do so without overwriting another writer.

The current slice exercises a toy service. Existing service installers are not replaced, and this contract grants no permission to load a plugin.

## Validate a declaration

Call `skillDirectory(value)` from `aify-env/client/installed-skills` with the `aifySkills` value. It returns the directory string or `null`, using the same grammar as the installer. One leading dot is allowed in a declared directory segment, as in `.agents/skills`, and in its recorded source path. `.` and `..` are refused. Skill names and entries inside a skill tree cannot start with a dot. This check reads no filesystem and does not verify package admission or placement.

## Verify a recorded placement

Call `verifyPlacement({ home, service, skill, harness })` from `aify-env/client/installed-skills`. Pass the absolute host home that owns `.aify`, the registered service name, the declared skill directory name, and the selected client (`claude`, `codex`, or `hermes`). Do not substitute a runtime-specific config home for `home`.

The synchronous result is `{ state, reason }`. `placed` means the recorded tree matches the receipt digest. `changed` means the recorded tree differs or could not safely be read. `absent` means the receipt is missing, invalid or non-unique for this selector, or the recorded destination is missing. The check writes nothing and returns no path or file contents. It verifies the recorded destination, not whether the runtime's current profile discovers the skill.
